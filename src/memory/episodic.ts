/**
 * Episodic memory: every turn, embedded and searchable.
 *
 * v1 stored episodes but never recalled them in the main pipeline (recall was
 * only reachable through a little-used tool). v2 wires recall directly into
 * context assembly: the tutor remembers relevant past moments across
 * sessions. Recall is restricted to the query's embedding provider space
 * (see embeddings.ts) and cross-session by design.
 */
import { db } from '../db/client';
import { embed } from './embeddings';
import { logger } from '../middleware/logger';
import type { ConversationTurn } from '../types/student';

export async function saveEpisode(turn: ConversationTurn): Promise<void> {
  const textToEmbed = `${turn.studentMessage} ${turn.tutorResponse}`;
  const { vector, provider } = await embed(textToEmbed);
  const embeddingStr = `[${vector.join(',')}]`;

  await db.query(
    `INSERT INTO conversation_turns (
      turn_id, session_id, student_id, turn_number,
      student_message, tutor_response, ai_analysis, modality,
      model_used, latency_ms, tokens_in, tokens_out, cost_usd,
      tools_used, embedding, embedding_provider, topic, subject, mastery_evidenced, timestamp
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::vector,$16,$17,$18,$19,$20)
    ON CONFLICT (turn_id) DO NOTHING`,
    [
      turn.turnId, turn.sessionId, turn.studentId, turn.turnNumber,
      turn.studentMessage, turn.tutorResponse,
      JSON.stringify(turn.aiAnalysis || {}),
      turn.modality || 'text', turn.modelUsed,
      turn.latencyMs, turn.tokensIn, turn.tokensOut, turn.costUsd,
      turn.toolsUsed || [],
      embeddingStr, provider,
      turn.topic || null, turn.subject || null,
      turn.masteryEvidenced || false,
      turn.timestamp,
    ]
  );
}

export async function recallRelevantEpisodes(
  studentId: string,
  query: string,
  limit = 4,
  excludeSessionId?: string
): Promise<ConversationTurn[]> {
  const { vector, provider } = await embed(query);
  const embeddingStr = `[${vector.join(',')}]`;

  try {
    const result = await db.query(
      `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
       FROM conversation_turns
       WHERE student_id = $2
         AND embedding IS NOT NULL
         AND embedding_provider = $3
         AND ($4::text IS NULL OR session_id <> $4)
       ORDER BY embedding <=> $1::vector
       LIMIT $5`,
      [embeddingStr, studentId, provider, excludeSessionId || null, limit]
    );

    // Similarity floor: do not "remember" things that are not actually related
    // (context pollution guard — retrieval must be relevant, not just nearest).
    const rows = result.rows.filter((r: Record<string, unknown>) => (r.similarity as number) > 0.25);
    return mapRows(rows);
  } catch (err) {
    logger.debug({ err }, '[Episodic] Vector recall failed — recency fallback');
    const result = await db.query(
      `SELECT * FROM conversation_turns WHERE student_id = $1 ORDER BY timestamp DESC LIMIT $2`,
      [studentId, limit]
    );
    return mapRows(result.rows);
  }
}

export async function getRecentHistory(sessionId: string, limit = 12): Promise<ConversationTurn[]> {
  const result = await db.query(
    `SELECT * FROM conversation_turns WHERE session_id = $1 ORDER BY turn_number DESC LIMIT $2`,
    [sessionId, limit]
  );
  return mapRows(result.rows).reverse();
}

/** Last sessions' turns across ALL sessions — used for cross-session continuity. */
export async function getCrossSessionHistory(studentId: string, limit = 6, beforeSessionId?: string): Promise<ConversationTurn[]> {
  const result = await db.query(
    `SELECT * FROM conversation_turns
     WHERE student_id = $1 AND ($2::text IS NULL OR session_id <> $2)
     ORDER BY timestamp DESC LIMIT $3`,
    [studentId, beforeSessionId || null, limit]
  );
  return mapRows(result.rows).reverse();
}

function mapRows(rows: Record<string, unknown>[]): ConversationTurn[] {
  return rows.map(row => ({
    turnId: row.turn_id as string,
    sessionId: row.session_id as string,
    studentId: row.student_id as string,
    turnNumber: row.turn_number as number,
    studentMessage: row.student_message as string,
    tutorResponse: row.tutor_response as string,
    aiAnalysis: (row.ai_analysis as Partial<import('../types/student').AIAnalysis>) || {},
    modality: (row.modality as string) || 'text',
    modelUsed: (row.model_used as string) || 'unknown',
    latencyMs: (row.latency_ms as number) || 0,
    tokensIn: (row.tokens_in as number) || 0,
    tokensOut: (row.tokens_out as number) || 0,
    costUsd: (row.cost_usd as number) || 0,
    toolsUsed: (row.tools_used as string[]) || [],
    topic: row.topic as string | undefined,
    subject: row.subject as string | undefined,
    masteryEvidenced: (row.mastery_evidenced as boolean) || false,
    reflectionScore: row.reflection_score as number | undefined,
    timestamp: new Date(row.timestamp as string),
  }));
}
