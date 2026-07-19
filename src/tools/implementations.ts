/**
 * Tool Implementations — all callable tools live here.
 *
 * The tutor core never hardcodes tool names. It reads from the tools table
 * and dispatches by name. Adding a new tool means:
 * 1. Insert into tools table
 * 2. Add handler function here
 * 3. Done. No tutor code changes.
 *
 * CRITICAL AUTOMATION RULES:
 * - No manual past-question bank uploads.
 * - No hardcoded exam boards or subjects.
 * - past_question_retrieval synthesizes practice items from syllabus
 *   objectives (LLM) and optionally enriches via live web search.
 * - web_search uses Brave/Tavily (env-configured), never a hardcoded provider.
 */
import { searchSyllabus, formatSyllabusContext } from '../syllabus/store';
import { searchBrave, searchTavily } from './search';
import { routeAndCall } from '../llm/router';
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

async function handleSyllabusQuery(
  params: Record<string, unknown>,
  _studentId: string
): Promise<ToolResult> {
  const query = String(params.query || params.topic || '');
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
    output: output || 'No matching syllabus content found for that query.',
    data: chunks,
    latencyMs: 0,
  };
}

async function handleWebSearch(
  params: Record<string, unknown>,
  _studentId: string
): Promise<ToolResult> {
  const query = String(params.query || '');
  const maxResults = Math.min(10, Math.max(1, Number(params.max_results) || 5));

  if (!query.trim()) {
    return {
      success: false,
      output: 'Web search requires a query.',
      error: 'missing_query',
      latencyMs: 0,
    };
  }

  try {
    const [brave, tavily] = await Promise.allSettled([
      searchBrave(query),
      searchTavily(query),
    ]);

    const results = [
      ...(brave.status === 'fulfilled' ? brave.value : []),
      ...(tavily.status === 'fulfilled' ? tavily.value : []),
    ].slice(0, maxResults);

    if (results.length === 0) {
      return {
        success: true,
        output: 'No web results found (search providers unavailable or empty).',
        data: [],
        latencyMs: 0,
      };
    }

    const output = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`)
      .join('\n');

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

async function handleCalculator(
  params: Record<string, unknown>,
  _studentId: string
): Promise<ToolResult> {
  const expression = String(params.expression || params.query || '');

  if (!expression.trim()) {
    return {
      success: false,
      output: 'Calculator requires an expression.',
      error: 'missing_expression',
      latencyMs: 0,
    };
  }

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

async function handleCodeInterpreter(
  params: Record<string, unknown>,
  _studentId: string
): Promise<ToolResult> {
  const code = String(params.code || params.expression || params.query || '');
  const language = String(params.language || 'python');

  if (!code.trim()) {
    return {
      success: false,
      output: 'code_interpreter requires a `code` string.',
      error: 'missing_code',
      latencyMs: 0,
    };
  }

  const { runSandboxedCode, formatCodeRunForTutor } = await import('./sandbox');
  const run = await runSandboxedCode(code, language);
  const output = formatCodeRunForTutor(run);

  return {
    success: run.success,
    output,
    data: {
      code: code.slice(0, 2000),
      language: run.language,
      status: run.blocked ? 'blocked' : run.timedOut ? 'timeout' : run.success ? 'ok' : 'error',
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      blocked: run.blocked,
      blockReason: run.blockReason,
    },
    error: run.success ? undefined : run.stderr || run.blockReason || 'execution_failed',
    latencyMs: run.durationMs,
  };
}

async function handleConceptLookup(
  params: Record<string, unknown>,
  studentId: string
): Promise<ToolResult> {
  const term = String(params.term || params.query || params.topic || '');
  const subject = params.subject ? String(params.subject) : undefined;
  const context = params.context ? String(params.context) : '';

  if (!term.trim()) {
    return {
      success: false,
      output: 'concept_lookup requires a term.',
      error: 'missing_term',
      latencyMs: 0,
    };
  }

  const chunks = await searchSyllabus({
    query: term,
    subject,
    limit: 3,
  });

  if (chunks.length > 0) {
    return {
      success: true,
      output: formatSyllabusContext(chunks),
      data: chunks,
      latencyMs: 0,
    };
  }

  // Dynamic generation from LLM guided by optional context — never a static pack
  try {
    const response = await routeAndCall(
      [
        {
          role: 'system',
          content:
            'You define academic concepts clearly for secondary-school students. No fluff. JSON only.',
        },
        {
          role: 'user',
          content: [
            `Term: ${term}`,
            subject ? `Subject hint: ${subject}` : '',
            context ? `Context: ${context}` : '',
            'Return JSON: {"definition":"...","key_points":["..."],"common_confusion":"...","simple_example":"..."}',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      {
        tier: 'smart',
        jsonMode: true,
        maxTokens: 500,
        temperature: 0.3,
        studentId,
        purpose: 'concept_lookup',
      }
    );

    const cleaned = response.content.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned) as {
      definition?: string;
      key_points?: string[];
      common_confusion?: string;
      simple_example?: string;
    };

    const output = [
      `Definition: ${parsed.definition || ''}`,
      parsed.key_points?.length
        ? `Key points:\n${parsed.key_points.map(p => `- ${p}`).join('\n')}`
        : '',
      parsed.common_confusion ? `Common confusion: ${parsed.common_confusion}` : '',
      parsed.simple_example ? `Example: ${parsed.simple_example}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      success: true,
      output,
      data: parsed,
      latencyMs: 0,
    };
  } catch (err) {
    return {
      success: false,
      output: `Could not look up concept: ${term}`,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: 0,
    };
  }
}

/**
 * past_question_retrieval — AUTOMATIC, no manual bank.
 *
 * 1) Pull syllabus objectives for the topic (vector store).
 * 2) Optionally enrich with live web search for public past-paper style items.
 * 3) Synthesize practice questions with the LLM guided by syllabus metadata.
 */
async function handlePastQuestionRetrieval(
  params: Record<string, unknown>,
  studentId: string
): Promise<ToolResult> {
  const subject = params.subject ? String(params.subject) : undefined;
  const topic = String(params.topic || params.query || '');
  const examBoard = params.exam_board ? String(params.exam_board) : undefined;
  const limit = Math.min(10, Math.max(1, Number(params.limit) || 5));

  if (!topic.trim()) {
    return {
      success: false,
      output: 'past_question_retrieval requires a topic.',
      error: 'missing_topic',
      latencyMs: 0,
    };
  }

  try {
    const syllabusChunks = await searchSyllabus({
      query: topic,
      subject,
      examBoard,
      limit: 5,
    });
    const syllabusContext = formatSyllabusContext(syllabusChunks);

    const searchQuery = [
      examBoard || '',
      subject || '',
      topic,
      'past questions exam practice',
    ]
      .filter(Boolean)
      .join(' ')
      .trim();

    const [brave, tavily] = await Promise.allSettled([
      searchBrave(searchQuery),
      searchTavily(searchQuery),
    ]);
    const webHits = [
      ...(brave.status === 'fulfilled' ? brave.value : []),
      ...(tavily.status === 'fulfilled' ? tavily.value : []),
    ].slice(0, 5);

    const webContext = webHits.length
      ? webHits.map((r, i) => `[${i + 1}] ${r.title}: ${r.snippet}`).join('\n')
      : 'No external past-paper snippets available.';

    const response = await routeAndCall(
      [
        {
          role: 'system',
          content: [
            'You generate original exam-style practice questions for secondary students.',
            'NEVER copy copyrighted past papers verbatim.',
            'Ground every item in the provided syllabus objectives.',
            'Match the style and difficulty of the named exam board when provided.',
            'Return JSON only.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            `Topic: ${topic}`,
            subject ? `Subject: ${subject}` : '',
            examBoard ? `Exam board label: ${examBoard}` : 'Exam board: discover from context or keep generic',
            `How many questions: ${limit}`,
            '',
            'SYLLABUS OBJECTIVES / CONTEXT:',
            syllabusContext || '(none found — use general secondary curriculum standards)',
            '',
            'EXTERNAL REFERENCE SNIPPETS (inspiration only, do not copy):',
            webContext,
            '',
            'Return JSON:',
            '{',
            '  "questions": [',
            '    {',
            '      "prompt": "...",',
            '      "options": ["A ...","B ..."] | null,',
            '      "answer": "...",',
            '      "explanation": "...",',
            '      "objective_tested": "...",',
            '      "difficulty": "easy"|"medium"|"hard"',
            '    }',
            '  ]',
            '}',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      {
        tier: 'smart',
        jsonMode: true,
        maxTokens: 1400,
        temperature: 0.5,
        studentId,
        purpose: 'past_question_synthesis',
      }
    );

    const cleaned = response.content.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned) as {
      questions?: Array<{
        prompt?: string;
        options?: string[] | null;
        answer?: string;
        explanation?: string;
        objective_tested?: string;
        difficulty?: string;
      }>;
    };

    const questions = (parsed.questions || []).slice(0, limit);
    if (questions.length === 0) {
      return {
        success: true,
        output: `Could not synthesize practice questions for "${topic}". Try a more specific topic.`,
        data: { subject, topic, examBoard, count: 0 },
        latencyMs: 0,
      };
    }

    const output = questions
      .map((q, i) => {
        const opts = Array.isArray(q.options)
          ? q.options.map((o, j) => `   ${String.fromCharCode(65 + j)}. ${o}`).join('\n')
          : '';
        return [
          `${i + 1}. [${q.difficulty || 'medium'}] ${q.prompt || ''}`,
          opts,
          q.answer ? `   Answer: ${q.answer}` : '',
          q.explanation ? `   Why: ${q.explanation}` : '',
          q.objective_tested ? `   Objective: ${q.objective_tested}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n');

    return {
      success: true,
      output,
      data: {
        subject,
        topic,
        examBoard: examBoard || null,
        count: questions.length,
        questions,
        source: 'llm_synthesis_from_syllabus',
        web_refs: webHits.map(w => w.url),
      },
      latencyMs: 0,
    };
  } catch (err) {
    logger.warn({ err }, '[Tools] past_question_retrieval failed');
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
  await db
    .query(
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
    )
    .catch(err => {
      logger.debug({ err }, '[ToolLog] Failed to log tool call');
    });
}
