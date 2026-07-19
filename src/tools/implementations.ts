/**
 * Tool Implementations — all callable tools live here.
 *
 * The tutor core never hardcodes tool names. It reads from the tools table
 * and dispatches by name. Adding a new tool means:
 * 1. Insert into tools table
 * 2. Add handler function here
 * 3. Done. No tutor code changes.
 */
import { searchSyllabus, formatSyllabusContext, getChunksByTopic } from '../syllabus/store';
import { logger } from '../middleware/logger';
import { db } from '../db/client';

export interface ToolResult {
  success: boolean;
  output: string;
  data?: unknown;
  error?: string;
  latencyMs: number;
}

type ToolHandler = (params: Record<string, unknown>, studentId: string) => Promise<ToolResult>;

const TOOL_REGISTRY: Record<string, ToolHandler> = {
  syllabus_query: handleSyllabusQuery,
  web_search: handleWebSearch,
  calculator: handleCalculator,
  code_interpreter: handleCodeInterpreter,
  concept_lookup: handleConceptLookup,
  past_question_retrieval: handlePastQuestionRetrieval,
};

export async function executeToolByName(
  name: string,
  params: Record<string, unknown>,
  studentId: string
): Promise<ToolResult> {
  const start = Date.now();
  const handler = TOOL_REGISTRY[name];

  if (!handler) {
    return {
      success: false,
      output: `Unknown tool: ${name}`,
      error: 'Tool not found in registry',
      latencyMs: Date.now() - start,
    };
  }

  try {
    const result = await handler(params, studentId);
    result.latencyMs = Date.now() - start;

    await logToolCall(studentId, name, params, result);
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const result: ToolResult = {
      success: false,
      output: `Tool ${name} failed: ${error}`,
      error,
      latencyMs: Date.now() - start,
    };
    await logToolCall(studentId, name, params, result);
    return result;
  }
}

async function handleSyllabusQuery(params: Record<string, unknown>): Promise<ToolResult> {
  const query = String(params.query || '');
  const subject = params.subject ? String(params.subject) : undefined;
  const examBoard = params.exam_board ? String(params.exam_board) : undefined;
  const level = params.level ? String(params.level) : undefined;
  const topic = params.topic ? String(params.topic) : undefined;

  const chunks = await searchSyllabus({
    query,
    subject,
    examBoard,
    level,
    topic,
    limit: 5,
  });

  const output = formatSyllabusContext(chunks);
  return {
    success: true,
    output,
    data: chunks,
    latencyMs: 0,
  };
}

async function handleWebSearch(params: Record<string, unknown>): Promise<ToolResult> {
  const query = String(params.query || '');
  const maxResults = Math.min(10, Math.max(1, Number(params.max_results) || 5));

  try {
    const response = await fetch(`https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${maxResults}`, {
      headers: {
        'Ocp-Apim-Subscription-Key': process.env.BING_SEARCH_API_KEY || '',
      },
    });

    if (!response.ok) {
      return {
        success: false,
        output: `Web search failed: ${response.status}`,
        error: `HTTP ${response.status}`,
        latencyMs: 0,
      };
    }

    const data = await response.json() as { webPages?: { value?: Array<{ name: string; url: string; snippet: string }> } };
    const results = (data.webPages?.value || []).map((r) => ({
      title: r.name,
      url: r.url,
      snippet: r.snippet,
    }));

    const output = results.length > 0
      ? results.map((r) => `- ${r.title}: ${r.snippet} (${r.url})`).join('\n')
      : 'No web results found.';

    return {
      success: true,
      output,
      data: results,
      latencyMs: 0,
    };
  } catch (err) {
    return {
      success: false,
      output: 'Web search unavailable.',
      error: err instanceof Error ? err.message : String(err),
      latencyMs: 0,
    };
  }
}

async function handleCalculator(params: Record<string, unknown>): Promise<ToolResult> {
  const expression = String(params.expression || '');

  try {
    const math = await import('mathjs');
    const result = math.evaluate(expression);

    return {
      success: true,
      output: `${expression} = ${result}`,
      data: { result, expression },
      latencyMs: 0,
    };
  } catch (err) {
    return {
      success: false,
      output: `Could not evaluate: ${expression}`,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: 0,
    };
  }
}

async function handleCodeInterpreter(params: Record<string, unknown>): Promise<ToolResult> {
  const code = String(params.code || '');
  const language = String(params.language || 'python');

  return {
    success: true,
    output: `[Code execution stub for ${language}]\nCode submitted:\n${code.slice(0, 200)}...\n\nIn production, this runs in a sandboxed environment and returns output + any visualization URL.`,
    data: { code, language, status: 'stub' },
    latencyMs: 0,
  };
}

async function handleConceptLookup(params: Record<string, unknown>): Promise<ToolResult> {
  const term = String(params.term || '');
  const subject = params.subject ? String(params.subject) : undefined;
  const context = params.context ? String(params.context) : '';

  const chunks = await searchSyllabus({
    query: term,
    subject,
    limit: 3,
  });

  if (chunks.length > 0) {
    const output = formatSyllabusContext(chunks);
    return {
      success: true,
      output,
      data: chunks,
      latencyMs: 0,
    };
  }

  const { routeAndCall } = await import('../llm/router');
  const response = await routeAndCall([
    { role: 'system', content: 'You are a concise academic dictionary. Define the term clearly with 2 examples and 3 related concepts. Keep under 300 words.' },
    { role: 'user', content: `Define "${term}"${subject ? ` in ${subject}` : ''}${context ? `. Context: ${context}` : ''}` },
  ], { tier: 'fast', maxTokens: 400, temperature: 0.2, purpose: 'concept_lookup' });

  return {
    success: true,
    output: response.content,
    data: { term, subject, source: 'llm_fallback' },
    latencyMs: 0,
  };
}

async function handlePastQuestionRetrieval(params: Record<string, unknown>): Promise<ToolResult> {
  const subject = String(params.subject || '');
  const topic = String(params.topic || '');
  const examBoard = String(params.exam_board || 'WAEC');
  const yearRange = Array.isArray(params.year_range) ? params.year_range as number[] : [2010, 2025];
  const limit = Math.min(20, Math.max(1, Number(params.limit) || 5));

  try {
    const result = await db.query(
      `SELECT * FROM past_questions 
       WHERE subject = $1 AND topic = $2 AND exam_board = $3 
         AND year BETWEEN $4 AND $5
       ORDER BY year DESC, RANDOM()
       LIMIT $6`,
      [subject.toLowerCase(), topic.toLowerCase(), examBoard.toUpperCase(), yearRange[0], yearRange[1], limit]
    );

    if (result.rows.length === 0) {
      return {
        success: true,
        output: `No past questions found for ${subject} — ${topic} (${examBoard}, ${yearRange[0]}-${yearRange[1]}). Try a broader topic or different exam board.`,
        data: { subject, topic, examBoard, count: 0 },
        latencyMs: 0,
      };
    }

    const questions = result.rows.map((r: Record<string, unknown>) => ({
      year: r.year,
      question: r.question_text,
      options: r.options,
      answer: r.correct_answer,
      explanation: r.explanation,
    }));

    const output = questions.map((q: Record<string, unknown>, i: number) =>
      `${i + 1}. [${q.year}] ${q.question}\n${Array.isArray(q.options) ? q.options.map((o: string, j: number) => `   ${String.fromCharCode(65 + j)}. ${o}`).join('\n') : ''}\n   Answer: ${q.answer}\n   ${q.explanation || ''}`
    ).join('\n\n');

    return {
      success: true,
      output,
      data: { subject, topic, examBoard, count: questions.length, questions },
      latencyMs: 0,
    };
  } catch (err) {
    return {
      success: false,
      output: 'Past question retrieval failed.',
      error: err instanceof Error ? err.message : String(err),
      latencyMs: 0,
    };
  }
}

async function logToolCall(
  studentId: string,
  toolName: string,
  input: Record<string, unknown>,
  result: ToolResult
): Promise<void> {
  await db.query(
    `INSERT INTO tool_call_logs (student_id, tool_name, tool_input, tool_output, latency_ms, error)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      studentId,
      toolName,
      JSON.stringify(input),
      JSON.stringify({ success: result.success, output: result.output, data: result.data }),
      result.latencyMs,
      result.error || null,
    ]
  ).catch(err => {
    logger.debug({ err }, '[ToolLog] Failed to log tool call');
  });
}