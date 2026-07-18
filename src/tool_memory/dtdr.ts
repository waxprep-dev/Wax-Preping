/**
 * WaxPrep v3.0 — Dynamic Tool Dependency Reasoning (DTDR)
 * Selects tools based on query context + execution history + tool memory.
 */

import { routeAndCall } from '../llm/router';
import { getAllToolMemoriesForStudent } from './registry';
import { logger } from '../middleware/logger';
import type { ToolSelection, DTDRContext } from '../types/cognitive';

/**
 * Select tools using DTDR.
 */
export async function selectTools(
  context: DTDRContext,
  studentId: string
): Promise<ToolSelection[]> {
  const toolMemories = await getAllToolMemoriesForStudent(studentId);

  const prompt = `
You are the tool selection intelligence of Wax, an AI tutor.
Given the student's query and tools already used, decide which tool(s) to call next.

STUDENT QUERY: ${context.initial_query}

TOOLS ALREADY USED:
${context.executed_tools.join(', ') || 'None'}

INTERMEDIATE RESULTS:
${context.intermediate_results.join('\n') || 'None'}

AVAILABLE TOOLS AND HISTORICAL PERFORMANCE:
${toolMemories.map(t => `
- ${t.tool_name}: ${t.successful_calls}/${t.total_calls} success (${((t.successful_calls / Math.max(1, t.total_calls)) * 100).toFixed(0)}%)
  Avg latency: ${t.avg_latency_ms ? `${t.avg_latency_ms.toFixed(0)}ms` : 'unknown'}
  Optimal params: ${JSON.stringify(t.optimal_params)}
  Common failures: ${t.common_failures.map(f => f.failure_pattern).join('; ') || 'none'}
`).join('')}

STUDENT PROFILE: ${context.student_profile_summary}

OUTPUT FORMAT (JSON):
{
  "tool_calls": [
    {
      "tool_name": "string",
      "params": {},
      "reasoning": "why this tool",
      "confidence": 0.0-1.0
    }
  ],
  "should_stop": false,
  "stop_reasoning": "string or null"
}

Rules:
- Only call tools genuinely needed
- If sufficient info exists, set should_stop=true
- Avoid tools with < 50% success unless necessary
- Params optimized based on tool_memories.optimal_params
`;

  try {
    const response = await routeAndCall(
      [
        { role: 'system', content: 'You select tutoring tools optimally. JSON only.' },
        { role: 'user', content: prompt },
      ],
      { tier: 'smart', jsonMode: true, maxTokens: 600, studentId, purpose: 'tool_selection' }
    );

    const cleaned = response.content.replace(/```json|```/g, '').trim();
    const result = JSON.parse(cleaned) as {
      tool_calls: Array<{ tool_name: string; params: Record<string, unknown>; reasoning: string; confidence: number }>;
      should_stop: boolean;
      stop_reasoning: string | null;
    };

    if (result.should_stop) return [];

    return result.tool_calls.map(tc => ({
      tool_name: tc.tool_name,
      params: tc.params,
      reasoning: tc.reasoning,
      confidence: tc.confidence,
    }));
  } catch (err) {
    logger.warn({ err, studentId }, '[DTDR] Tool selection failed');
    return [];
  }
}
