import { db } from '../db/client';
import { embed } from './embeddings';
import type { ConversationTurn } from '../types/student';

export async function saveEpisode(turn: ConversationTurn): Promise<void> {
  const textToEmbed = `${turn.studentMessage} ${turn.tutorResponse}`;
  const embedding = await embed(textToEmbed);
  const embeddingStr = `[${embedding.join(',')}]`;

  await db.query(
    `INSERT INTO conversation_turns (
      turn_id, session_id, student_id, turn_number,
      student_message, tutor_response, emotional_snapshot,
      planner_force, modality, model_used, latency_ms, tokens_in,
      tokens_out, cost_usd, tools_used, embedding, topic, subject,
      mastery_evidenced, timestamp
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::vector,$17,$18,$19,$20)
    ON CONFLICT (turn_id) DO NOTHING`,
    [
      turn.turnId, turn.sessionId, turn.studentId, turn.turnNumber,
      turn.studentMessage, turn.tutorResponse,
      JSON.stringify(turn.emotionalSnapshot),
      turn.plannerForce ? JSON.stringify(turn.plannerForce) : null,
      turn.modality || 'text', turn.modelUsed,
      turn.latencyMs, turn.tokensIn, turn.tokensOut, turn.costUsd,
      turn.toolsUsed, embeddingStr,
      turn.topic || null, turn.subject || null,
      turn.masteryEvidenced || false,
      turn.timestamp,
    ]
  );
}

export async function recallRelevantEpisodes(
  studentId: string,
  query: string,
  limit = 5
): Promise<ConversationTurn[]> {
  const embedding = await embed(query);
  const embeddingStr = `[${embedding.join(',')}]`;

  const result = await db.query(
    `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
     FROM conversation_turns
     WHERE student_id = $2 AND embedding IS NOT NULL
     ORDER BY similarity DESC
     LIMIT $3`,
    [embeddingStr, studentId, limit]
  );

  return mapRows(result.rows);
}

export async function recallByTopic(
  studentId: string,
  topic: string,
  limit = 10
): Promise<ConversationTurn[]> {
  const result = await db.query(
    `SELECT * FROM conversation_turns
     WHERE student_id = $1 AND topic ILIKE $2
     ORDER BY timestamp DESC LIMIT $3`,
    [studentId, `%${topic}%`, limit]
  );
  return mapRows(result.rows);
}

export async function recallMasteryMoments(
  studentId: string,
  limit = 5
): Promise<ConversationTurn[]> {
  const result = await db.query(
    `SELECT * FROM conversation_turns
     WHERE student_id = $1 AND mastery_evidenced = TRUE
     ORDER BY timestamp DESC LIMIT $2`,
    [studentId, limit]
  );
  return mapRows(result.rows);
}

export async function getRecentHistory(
  sessionId: string,
  limit = 12
): Promise<ConversationTurn[]> {
  const result = await db.query(
    `SELECT * FROM conversation_turns
     WHERE session_id = $1
     ORDER BY turn_number DESC LIMIT $2`,
    [sessionId, limit]
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
    emotionalSnapshot: row.emotional_snapshot as ConversationTurn['emotionalSnapshot'],
    plannerForce: row.planner_force as ConversationTurn['plannerForce'],
    modality: (row.modality as string) || 'text',
    modelUsed: row.model_used as string,
    latencyMs: row.latency_ms as number,
    tokensIn: row.tokens_in as number,
    tokensOut: row.tokens_out as number,
    costUsd: (row.cost_usd as number) || 0,
    toolsUsed: (row.tools_used as string[]) || [],
    topic: row.topic as string | undefined,
    subject: row.subject as string | undefined,
    masteryEvidenced: (row.mastery_evidenced as boolean) || false,
    timestamp: new Date(row.timestamp as string),
  }));
}