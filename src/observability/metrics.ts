/**
 * Lightweight teaching-quality metrics.
 *
 * Tracks the signals that actually matter for WaxPrep:
 *   - question rate vs teach rate
 *   - policy moves used
 *   - defense hits
 *   - latency
 *
 * Schema lives in db/client.ts initializeDatabase().
 */

import { db } from '../db/client';
import { logger } from '../middleware/logger';

export interface TurnMetric {
  studentId: string;
  sessionId: string;
  turnNumber: number;
  askedQuestion: boolean;
  taughtContent: boolean;
  policyMove?: string | null;
  strategy?: string | null;
  defenseIssues?: number;
  latencyMs?: number;
}

export async function recordTurnMetric(m: TurnMetric): Promise<void> {
  try {
    await db.query(
      `INSERT INTO teaching_metrics
       (student_id, session_id, turn_number, asked_question, taught_content, policy_move, strategy, defense_issues, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        m.studentId,
        m.sessionId,
        m.turnNumber,
        m.askedQuestion,
        m.taughtContent,
        m.policyMove || null,
        m.strategy || null,
        m.defenseIssues || 0,
        m.latencyMs || null,
      ]
    );
  } catch (err) {
    logger.debug({ err }, '[Metrics] record failed');
  }
}

export async function getStudentTeachStats(
  studentId: string,
  lastN = 50
): Promise<{ questionRate: number; teachRate: number; samples: number }> {
  try {
    const r = await db.query(
      `SELECT asked_question, taught_content FROM teaching_metrics
       WHERE student_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [studentId, lastN]
    );
    const n = r.rows.length || 1;
    const q = r.rows.filter((x: { asked_question: boolean }) => x.asked_question).length;
    const t = r.rows.filter((x: { taught_content: boolean }) => x.taught_content).length;
    return { questionRate: q / n, teachRate: t / n, samples: r.rows.length };
  } catch {
    return { questionRate: 0, teachRate: 0, samples: 0 };
  }
}
