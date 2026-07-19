/**
 * Session manager — creates, persists, and retrieves active sessions.
 *
 * v3.1: Dual-process session boundaries replace the hardcoded 30-minute timeout
 * as the primary boundary mechanism. Time gap is only one signal among many
 * (topic drift, emotional shift, cognitive task change, pedagogical transition).
 * The crew pipeline calls evaluateAndMaybeRotateSession after perception so
 * emotional + topical signals are available.
 */
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/client';
import { logger } from '../middleware/logger';
import { evaluateSessionBoundary } from '../cognitive/segmentation';
import { getCognitiveConfig, getSegmentationConfig } from '../config/cognitive';
import type { Session, SessionState } from '../types/student';
import type { BoundaryDecision } from '../types/cognitive';

/** Soft fallback only — used when segmentation is disabled or evaluation fails. */
const FALLBACK_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours, not 30 minutes

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

function rowToSession(row: Record<string, unknown>, isNewSession: boolean): Session {
  return {
    sessionId: row.session_id as string,
    studentId: row.student_id as string,
    startedAt: new Date(row.started_at as string),
    lastActivityAt: new Date(row.last_activity_at as string),
    turnCount: (row.turn_count as number) || 0,
    isActive: true,
    state: { ...DEFAULT_SESSION_STATE, ...((row.state as SessionState) || {}) },
    isNewSession,
  };
}

/**
 * Fetch the most recent active session without rotating.
 * Does not apply time-based termination — that is the segmentation engine's job.
 */
export async function getActiveSession(studentId: string): Promise<Session | null> {
  const result = await db.query(
    `SELECT * FROM sessions
     WHERE student_id = $1 AND is_active = TRUE
     ORDER BY last_activity_at DESC
     LIMIT 1`,
    [studentId]
  );
  if (result.rows.length === 0) return null;
  return rowToSession(result.rows[0], false);
}

export async function createSession(studentId: string, seedState?: Partial<SessionState>): Promise<Session> {
  const sessionId = uuidv4();
  const state = { ...DEFAULT_SESSION_STATE, ...(seedState || {}) };
  await db.query(
    `INSERT INTO sessions (session_id, student_id, started_at, last_activity_at, turn_count, is_active, state)
     VALUES ($1, $2, NOW(), NOW(), 0, TRUE, $3)`,
    [sessionId, studentId, JSON.stringify(state)]
  );
  return {
    sessionId,
    studentId,
    startedAt: new Date(),
    lastActivityAt: new Date(),
    turnCount: 0,
    isActive: true,
    state,
    isNewSession: true,
  };
}

/**
 * Backward-compatible entry: returns active session or creates one.
 * Soft fallback timeout only applies when segmentation is disabled.
 */
export async function getOrCreateSession(studentId: string): Promise<Session> {
  const active = await getActiveSession(studentId);
  if (!active) {
    return createSession(studentId);
  }

  let segmentationEnabled = true;
  try {
    const cfg = await getCognitiveConfig('segmentation');
    segmentationEnabled = cfg.enabled !== false;
  } catch {
    segmentationEnabled = true;
  }

  if (!segmentationEnabled) {
    const lastActivity = active.lastActivityAt.getTime();
    if (Date.now() - lastActivity >= FALLBACK_TIMEOUT_MS) {
      await endSession(active.sessionId);
      return createSession(studentId, {
        currentConcept: active.state.currentConcept,
        currentSubject: active.state.currentSubject,
      });
    }
  }

  return active;
}

export interface SessionRotationInput {
  studentId: string;
  currentMessage: string;
  previousMessage: string | null;
  currentTopic: string | null;
  emotionalSnapshot: Record<string, number>;
  recentContext: string;
  session: Session;
}

export interface SessionRotationResult {
  session: Session;
  boundary: BoundaryDecision | null;
  rotated: boolean;
}

/**
 * Dual-process boundary evaluation. Call after perception so emotion + topic
 * signals are available. Rotates the session when a true cognitive boundary
 * is detected.
 */
export async function evaluateAndMaybeRotateSession(
  input: SessionRotationInput
): Promise<SessionRotationResult> {
  const { studentId, session } = input;

  let segmentationEnabled = true;
  try {
    const cfg = await getCognitiveConfig('segmentation');
    segmentationEnabled = cfg.enabled !== false;
  } catch {
    segmentationEnabled = true;
  }

  if (!segmentationEnabled || session.isNewSession || session.turnCount === 0) {
    return { session, boundary: null, rotated: false };
  }

  const timeGapMinutes = Math.max(
    0,
    (Date.now() - session.lastActivityAt.getTime()) / 60000
  );

  try {
    const boundary = await evaluateSessionBoundary(
      studentId,
      input.currentMessage,
      input.previousMessage,
      input.currentTopic,
      input.emotionalSnapshot,
      input.recentContext,
      timeGapMinutes,
      session.sessionId
    );

    if (!boundary.is_boundary) {
      return { session, boundary, rotated: false };
    }

    logger.info(
      {
        studentId,
        boundaryType: boundary.boundary_type,
        probability: boundary.boundary_probability,
        previousSessionId: session.sessionId,
      },
      '[Session] Cognitive boundary detected — rotating session'
    );

    await endSession(session.sessionId);

    // Continuity: carry concept/subject when boundary is emotional/external, not topic shift
    const carryConcept =
      boundary.boundary_type !== 'TOPIC_SHIFT' &&
      boundary.boundary_type !== 'topic_shift';

    const newSession = await createSession(studentId, {
      currentConcept: carryConcept ? session.state.currentConcept : null,
      currentSubject: carryConcept ? session.state.currentSubject : null,
      foundationGapDisclosed: session.state.foundationGapDisclosed,
      readinessSignal: false,
    });

    // Persist boundary linkage if table supports new_session_id updates
    await db
      .query(
        `UPDATE session_boundaries
         SET new_session_id = $1
         WHERE id = (
           SELECT id FROM session_boundaries
           WHERE student_id = $2
             AND previous_session_id = $3
             AND (new_session_id IS NULL OR new_session_id = '')
           ORDER BY detected_at DESC
           LIMIT 1
         )`,
        [newSession.sessionId, studentId, session.sessionId]
      )
      .catch(() => {
        /* non-fatal — segmentation module may already have inserted */
      });

    return { session: newSession, boundary, rotated: true };
  } catch (err) {
    logger.warn({ err, studentId }, '[Session] Boundary evaluation failed — continuing session');

    // Extreme gap fallback only
    try {
      const seg = await getSegmentationConfig(studentId);
      const gapLimit = (seg.thresholds.time_gap || 180) * 4; // generous multiple
      if (timeGapMinutes > gapLimit) {
        await endSession(session.sessionId);
        const newSession = await createSession(studentId, {
          currentConcept: session.state.currentConcept,
          currentSubject: session.state.currentSubject,
        });
        return { session: newSession, boundary: null, rotated: true };
      }
    } catch {
      /* ignore */
    }

    return { session, boundary: null, rotated: false };
  }
}

export async function touchSession(sessionId: string): Promise<void> {
  await db.query(
    `UPDATE sessions SET last_activity_at = NOW(), turn_count = turn_count + 1 WHERE session_id = $1`,
    [sessionId]
  );
}

export async function updateSessionState(
  sessionId: string,
  updates: Partial<SessionState>
): Promise<void> {
  const result = await db.query(`SELECT state FROM sessions WHERE session_id = $1`, [sessionId]);
  if (result.rows.length === 0) return;
  const current = result.rows[0].state || {};
  const merged = { ...current, ...updates };
  await db.query(`UPDATE sessions SET state = $1 WHERE session_id = $2`, [
    JSON.stringify(merged),
    sessionId,
  ]);
}

export async function endSession(sessionId: string): Promise<void> {
  await db.query(`UPDATE sessions SET is_active = FALSE WHERE session_id = $1`, [sessionId]);
}

export async function isMessageProcessed(messageId: string): Promise<boolean> {
  const result = await db.query(`SELECT 1 FROM processed_messages WHERE message_id = $1`, [
    messageId,
  ]);
  return result.rows.length > 0;
}

export async function markMessageProcessed(messageId: string): Promise<void> {
  await db.query(
    `INSERT INTO processed_messages (message_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [messageId]
  );
}

export async function updateLastSeen(studentId: string): Promise<void> {
  await db.query(`UPDATE student_profiles SET last_seen_at = NOW() WHERE student_id = $1`, [
    studentId,
  ]);
}
