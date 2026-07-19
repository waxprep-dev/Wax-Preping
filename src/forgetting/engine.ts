/**
 * WaxPrep v3.0 — Forgetting Engine Orchestrator
 * Coordinates ACT-R activation, Oblivion gating, and retrieval.
 */

import { embed } from '../memory/embeddings';
import { getGraphAdapter } from '../graph/factory';
import { getForgettingParams } from '../config/cognitive';
import { computeActivation, estimateUncertainty, cosineSimilarity } from '../cognitive/forgetting/activation';
import { passesOblivionGate, strengthenMemory } from '../cognitive/forgetting/oblivion';
import { logger } from '../middleware/logger';
import { db } from '../db/client';
import type { MemoryChunk, ForgettingParams, GraphNode } from '../types/cognitive';

/**
 * Main retrieval pipeline.
 */
export async function retrieveMemories(
  query: string,
  studentId: string,
  workingMemoryContext: string,
  options: {
    limit?: number;
    nodeLabels?: string[];
    minActivation?: number;
  } = {}
): Promise<MemoryChunk[]> {
  const params = await getForgettingParams(studentId);
  const limit = options.limit || params.top_k_retrieval;

  // ===========================================================================
  // STAGE 1: Oblivion Uncertainty Gating
  // ===========================================================================
  const uncertainty = estimateUncertainty(query, workingMemoryContext);

  if (uncertainty < params.uncertainty_threshold) {
    logger.debug(
      { studentId, uncertainty, threshold: params.uncertainty_threshold },
      '[Forgetting] Working memory sufficient — skipping long-term retrieval'
    );
    return [];
  }

  // ===========================================================================
  // STAGE 2: Candidate selection from graph
  // ===========================================================================
  const graph = await getGraphAdapter();
  const queryEmbedding = (await embed(query)).vector;

  const candidates = await graph.findSimilar({
    embedding: queryEmbedding,
    limit: 200,
    studentId,
    nodeLabels: options.nodeLabels || ['Episode', 'Fact', 'Concept'],
    minSimilarity: 0.15,
  });

  // ===========================================================================
  // STAGE 3: Compute activation for all candidates
  // ===========================================================================
  const scored = candidates.map(node => ({
    node,
    chunk: graphNodeToMemoryChunk(node, params),
    activation: computeActivation(graphNodeToMemoryChunk(node, params), queryEmbedding, params),
  }));

  // ===========================================================================
  // STAGE 4: Filter by retrieval threshold AND Oblivion recall probability
  // ===========================================================================
  const now = new Date();
  const aboveThreshold = scored.filter(({ chunk, activation }) => {
    const passesActivation = activation > chunk.retrieval_threshold;
    const passesOblivion = passesOblivionGate(chunk, now, params);
    return passesActivation && passesOblivion;
  });

  // ===========================================================================
  // STAGE 5: Return top-K by activation (NOT just similarity!)
  // ===========================================================================
  const results = aboveThreshold
    .sort((a, b) => b.activation - a.activation)
    .slice(0, limit);

  // ===========================================================================
  // STAGE 6: Update access statistics
  // ===========================================================================
  for (const { node, chunk } of results) {
    const strengthened = strengthenMemory(chunk, true);
    await updateGraphNodeAccess(node.id, strengthened);
    await logMemoryAccess(studentId, node.id, node.labels[0], query, chunk.activation, true, results.indexOf({ node, chunk, activation: chunk.activation }));
  }

  logger.debug(
    { studentId, query: query.slice(0, 50), candidates: candidates.length, retrieved: results.length },
    '[Forgetting] Memory retrieval complete'
  );

  return results.map(r => r.chunk);
}

/**
 * Convert a graph node to a MemoryChunk for activation computation.
 */
function graphNodeToMemoryChunk(node: GraphNode, params: ForgettingParams): MemoryChunk {
  const props = node.properties;

  return {
    id: node.id,
    content: props.student_message as string || props.attribute_key as string || props.name as string || JSON.stringify(props),
    embedding: node.embedding || [],
    memory_type: node.labels.includes('Episode') ? 'episode'
      : node.labels.includes('Fact') ? 'fact'
      : node.labels.includes('Concept') ? 'concept'
      : 'state',

    base_activation: 0,
    last_accessed: new Date(props.last_accessed as string || node.event_time),
    access_count: (props.access_count as number) || 1,

    semantic_similarity_to_query: 0,
    decay_rate: params.decay_rate,
    retrieval_threshold: params.retrieval_threshold,

    emotional_salience: (props.emotional_salience as number) || (props.emotional_valence as number) || 0.3,

    usage_count: (props.usage_count as number) || 1,
    feedback_score: (props.feedback_score as number) || 0,
    decay_temperature: params.decay_temperature,
    activation: 0,
  };
}

/**
 * Update graph node with new access statistics.
 */
async function updateGraphNodeAccess(nodeId: string, chunk: MemoryChunk): Promise<void> {
  const graph = await getGraphAdapter();
  await graph.updateNode(nodeId, {
    properties: {
      last_accessed: chunk.last_accessed.toISOString(),
      access_count: chunk.access_count,
      feedback_score: chunk.feedback_score,
      usage_count: chunk.usage_count,
    },
  });
}

/**
 * Log memory access for learning and observability.
 */
async function logMemoryAccess(
  studentId: string,
  memoryId: string,
  memoryType: string,
  query: string,
  activationScore: number,
  wasRetrieved: boolean,
  retrievalRank: number
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO memory_access_logs (
        student_id, memory_id, memory_type, query,
        activation_score, was_retrieved, retrieval_rank, accessed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [studentId, memoryId, memoryType, query.slice(0, 500), activationScore, wasRetrieved, retrievalRank]
    );
  } catch (err) {
    logger.debug({ err }, '[Forgetting] Failed to log memory access');
  }
}

/**
 * Provide feedback on a retrieved memory to strengthen or weaken it.
 */
export async function provideMemoryFeedback(
  memoryId: string,
  wasUseful: boolean
): Promise<void> {
  const graph = await getGraphAdapter();
  const node = await graph.getNode(memoryId);
  if (!node) return;

  const currentFeedback = (node.properties.feedback_score as number) || 0;
  const newFeedback = currentFeedback + (wasUseful ? 0.2 : -0.1);

  await graph.updateNode(memoryId, {
    properties: {
      ...node.properties,
      feedback_score: Math.max(-1, Math.min(1, newFeedback)),
    },
  });
}