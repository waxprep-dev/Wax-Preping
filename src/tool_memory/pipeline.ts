/**
 * WaxPrep v3.0 — Tool Output to Memory Pipeline
 * Every tool result becomes a graph node/edge.
 */

import { getGraphAdapter } from '../graph/factory';
import { autoConstructPalacePath, placeInPalace } from '../palace/organizer';
import { recordToolOutcome, recordToolDependency, updateToolOptimalParams } from './registry';
import { logger } from '../middleware/logger';
import type { GraphAdapter } from '../graph/interfaces';

/**
 * Process a tool call outcome: store result in graph, update tool memory.
 */
export async function processToolOutput(
  studentId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: Record<string, unknown> | string,
  latencyMs: number,
  success: boolean,
  error?: string,
  previousTool?: string
): Promise<void> {
  const graph = await getGraphAdapter();

  // 1. Record tool outcome in tool memory
  await recordToolOutcome(toolName, studentId, toolInput, latencyMs, success, error);

  if (!success) return;

  // 2. Create graph node for tool result
  const resultNode = await graph.createNode({
    labels: ['ToolResult', 'Episode'],
    properties: {
      tool_name: toolName,
      tool_input: toolInput,
      tool_output: typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput),
      success,
      latency_ms: latencyMs,
    },
    student_id: studentId,
    source: 'tool_result',
  });

  // 3. Link to student
  const studentNodes = await graph.searchNodes({ labels: ['Student'], student_id: studentId }, 1);
  if (studentNodes.length > 0) {
    await graph.createEdge({
      source_id: studentNodes[0].id,
      target_id: resultNode.id,
      type: 'PARTICIPATED_IN',
      student_id: studentId,
    });
  }

  // 4. Extract facts from tool output and store
  await extractFactsFromToolOutput(graph, studentId, toolName, toolOutput, resultNode.id);

  // 5. Update tool optimal params if successful
  if (success && typeof toolOutput === 'object') {
    const optimalParams = inferOptimalParams(toolName, toolInput, toolOutput);
    if (Object.keys(optimalParams).length > 0) {
      await updateToolOptimalParams(toolName, studentId, optimalParams);
    }
  }

  // 6. Record dependency if previous tool exists
  if (previousTool) {
    await recordToolDependency(previousTool, toolName, studentId);
  }

  // 7. Place in palace if topic is known
  const topic = toolInput.topic as string || toolInput.subject as string || toolInput.query as string;
  if (topic) {
    const subject = toolInput.subject as string || 'General';
    const { drawer } = await autoConstructPalacePath(studentId, subject, topic, topic);
    await placeInPalace(drawer.id, resultNode.id, 'tool_result');
  }

  logger.debug({ studentId, toolName }, '[ToolMemory] Processed tool output');
}

/**
 * Extract semantic facts from tool output.
 */
async function extractFactsFromToolOutput(
  graph: GraphAdapter,
  studentId: string,
  toolName: string,
  output: Record<string, unknown> | string,
  resultNodeId: string
): Promise<void> {
  // Simple fact extraction: tool outputs often contain definitions, values, or references
  const facts: Array<{ key: string; value: unknown }> = [];

  if (typeof output === 'string') {
    // For text outputs, we could run LLM extraction here
    // For now, store the raw output as a fact
    facts.push({ key: `${toolName}_result`, value: output.slice(0, 1000) });
  } else {
    for (const [key, val] of Object.entries(output)) {
      if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
        facts.push({ key: `${toolName}_${key}`, value: val });
      }
    }
  }

  for (const fact of facts) {
    const factNode = await graph.createNode({
      labels: ['Fact'],
      properties: {
        attribute_key: fact.key,
        attribute_value: fact.value,
        source_tool: toolName,
        confidence: 0.8,
      },
      student_id: studentId,
      source: 'tool_extraction',
    });

    await graph.createEdge({
      source_id: resultNodeId,
      target_id: factNode.id,
      type: 'PRODUCED',
      properties: { fact_key: fact.key },
      student_id: studentId,
    });
  }
}

/**
 * Infer optimal parameters from successful tool usage.
 */
function inferOptimalParams(
  toolName: string,
  input: Record<string, unknown>,
  output: Record<string, unknown>
): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  if (toolName === 'web_search' && typeof input.max_results === 'number') {
    // If output was good with this max_results, remember it
    params.max_results = input.max_results;
  }

  if (toolName === 'syllabus_query' && input.exam_board) {
    params.preferred_exam_board = input.exam_board;
  }

  return params;
}