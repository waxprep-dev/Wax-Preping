/**
 * Session manager — creates, persists, and retrieves active sessions.
 * Extended for v3.0: onboarding state is tracked per student, not per session.
 */
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/client';
import { logger } from '../middleware/logger';
import { incrementSessions } from '../memory/semantic';
import type { Session, SessionState } from '../types/student';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const DEFAULT_SESSION_STATE: SessionState = {
  currentConcept: null,
  currentSubject: null,
  hintLevel: 0,
  approachesTried: [],
  struggleCount: 0,
  lastStrategy: null,
  bloomLevel: null,
  unresolvedQuestion: null,
  consecutiveQuestions: 0,
  questionsThisSession: 0,
  lastTutorAskedQuestion: false,
  turnsSinceLastTeach: 0,
  lastMove: null,
  readinessSignal: false,
  foundationGapDisclosed: false,
};

export async function getOrCreateSession(studentId: string): Promise<Session> {
  const result = await db.query(
    `SELECT * FROM sessions
     WHERE student_id = $1 AND is_active = TRUE
     ORDER BY last_activity_at DESC
     LIMIT 1`,
    [studentId]
  );

  if (result.rows.length > 0) {
    const row = result.rows[0];
    const lastActivity = new Date(row.last_activity_at).getTime();
    if (Date.now() - lastActivity < SESSION_TIMEOUT_MS) {
      return {
        sessionId: row.session_id,
        studentId: row.student_id,
        startedAt: new Date(row.started_at),
        lastActivityAt: new Date(row.last_activity_at),
        turnCount: row.turn_count,
        isActive: true,
        state: { ...DEFAULT_SESSION_STATE, ...(row.state || {}) },
        isNewSession: false,
      };
    }
  }

  const sessionId = uuidv4();
  await db.query(
    `INSERT INTO sessions (session_id, student_id, started_at, last_activity_at, turn_count, is_active, state)
     VALUES ($1, $2, NOW(), NOW(), 0, TRUE, $3)`,
    [sessionId, studentId, JSON.stringify(DEFAULT_SESSION_STATE)]
  );
  await incrementSessions(studentId);

  return {
    sessionId,
    studentId,
    startedAt: new Date(),
    lastActivityAt: new Date(),
    turnCount: 0,
    isActive: true,
    state: { ...DEFAULT_SESSION_STATE },
    isNewSession: true,
  };
}

export async function touchSession(sessionId: string): Promise<void> {
  await db.query(
    `UPDATE sessions SET last_activity_at = NOW(), turn_count = turn_count + 1 WHERE session_id = $1`,
    [sessionId]
  );
}

export async function updateSessionState(sessionId: string, updates: Partial<SessionState>): Promise<void> {
  const result = await db.query(`SELECT state FROM sessions WHERE session_id = $1`, [sessionId]);
  if (result.rows.length === 0) return;
  const current = result.rows[0].state || {};
  const merged = { ...current, ...updates };
  await db.query(`UPDATE sessions SET state = $1 WHERE session_id = $2`, [JSON.stringify(merged), sessionId]);
}

export async function endSession(sessionId: string): Promise<void> {
  await db.query(`UPDATE sessions SET is_active = FALSE WHERE session_id = $1`, [sessionId]);
}

export async function isMessageProcessed(messageId: string): Promise<boolean> {
  const result = await db.query(`SELECT 1 FROM processed_messages WHERE message_id = $1`, [messageId]);
  return result.rows.length > 0;
}

export async function markMessageProcessed(messageId: string): Promise<void> {
  await db.query(
    `INSERT INTO processed_messages (message_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [messageId]
  );
}

export async function updateLastSeen(studentId: string): Promise<void> {
  await db.query(`UPDATE student_profiles SET last_seen_at = NOW() WHERE student_id = $1`, [studentId]);
}
