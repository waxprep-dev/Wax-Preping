/**
 * Session management with persistent per-session teaching state.
 *
 * v1: SessionState did not exist; teaching state was re-derived from regexes
 * every turn. v1 also incremented total_sessions per message. Both fixed:
 * state lives in sessions.state (JSONB) and total_sessions increments only
 * when a new session row is created.
 */
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/client';
import type { Session, ConversationTurn, SessionState } from '../types/student';

const SESSION_TIMEOUT_MINUTES = 45;

export const EMPTY_SESSION_STATE: SessionState = {
  currentConcept: null,
  currentSubject: null,
  hintLevel: 0,
  approachesTried: [],
  struggleCount: 0,
  lastStrategy: null,
  bloomLevel: null,
  unresolvedQuestion: null,
};

export async function getOrCreateSession(studentId: string): Promise<Session> {
  const result = await db.query(
    `SELECT * FROM sessions
     WHERE student_id = $1 AND last_activity_at > NOW() - INTERVAL '${SESSION_TIMEOUT_MINUTES} minutes' AND is_active = TRUE
     ORDER BY last_activity_at DESC LIMIT 1`,
    [studentId]
  );

  if (result.rows.length > 0) {
    const row = result.rows[0];
    return {
      sessionId: row.session_id,
      studentId: row.student_id,
      startedAt: new Date(row.started_at),
      lastActivityAt: new Date(row.last_activity_at),
      turnCount: row.turn_count,
      isActive: true,
      state: { ...EMPTY_SESSION_STATE, ...(row.state || {}) },
      isNewSession: false,
    };
  }

  await db.query(`UPDATE sessions SET is_active = FALSE WHERE student_id = $1 AND is_active = TRUE`, [studentId]);

  const sessionId = uuidv4();
  await db.query(
    `INSERT INTO sessions (session_id, student_id, state) VALUES ($1, $2, $3)`,
    [sessionId, studentId, JSON.stringify(EMPTY_SESSION_STATE)]
  );

  const { incrementSessions } = await import('../memory/semantic');
  await incrementSessions(studentId).catch(() => {});

  return {
    sessionId,
    studentId,
    startedAt: new Date(),
    lastActivityAt: new Date(),
    turnCount: 0,
    isActive: true,
    state: { ...EMPTY_SESSION_STATE },
    isNewSession: true,
  };
}

export async function updateSessionState(sessionId: string, patch: Partial<SessionState>): Promise<SessionState> {
  const result = await db.query(`SELECT state FROM sessions WHERE session_id = $1`, [sessionId]);
  const current: SessionState = { ...EMPTY_SESSION_STATE, ...((result.rows[0]?.state as Partial<SessionState>) || {}) };
  const next = { ...current, ...patch };
  await db.query(`UPDATE sessions SET state = $1 WHERE session_id = $2`, [JSON.stringify(next), sessionId]);
  return next;
}

export async function touchSession(sessionId: string): Promise<void> {
  await db.query(`UPDATE sessions SET last_activity_at = NOW(), turn_count = turn_count + 1 WHERE session_id = $1`, [sessionId]);
}

export async function saveTurn(turn: ConversationTurn): Promise<void> {
  await db.query(
    `INSERT INTO conversation_turns (turn_id, session_id, student_id, turn_number, student_message, tutor_response, ai_analysis, modality, model_used, latency_ms, tokens_in, tokens_out, cost_usd, tools_used, topic, subject, mastery_evidenced, timestamp)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (turn_id) DO NOTHING`,
    [turn.turnId, turn.sessionId, turn.studentId, turn.turnNumber, turn.studentMessage, turn.tutorResponse, JSON.stringify(turn.aiAnalysis || {}), turn.modality, turn.modelUsed, turn.latencyMs, turn.tokensIn, turn.tokensOut, turn.costUsd, turn.toolsUsed || [], turn.topic, turn.subject, turn.masteryEvidenced, turn.timestamp]
  );
}

export async function isMessageProcessed(messageId: string): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM processed_messages WHERE message_id = $1`, [messageId]);
  return r.rows.length > 0;
}

export async function markMessageProcessed(messageId: string): Promise<void> {
  await db.query(`INSERT INTO processed_messages (message_id) VALUES ($1) ON CONFLICT DO NOTHING`, [messageId]);
  await db.query(`DELETE FROM processed_messages WHERE processed_at < NOW() - INTERVAL '3 hours'`);
}

export async function updateLastSeen(studentId: string): Promise<void> {
  await db.query(
    `INSERT INTO student_profiles (student_id) VALUES ($1) ON CONFLICT (student_id) DO UPDATE SET last_seen_at = NOW()`,
    [studentId]
  );
}
