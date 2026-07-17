/**
 * Autonomous SQL agent — HARDENED.
 *
 * v1 executed LLM-generated SQL with only a regex guard that blocked
 * "DROP TABLE", "TRUNCATE" and "DELETE ... WHERE 1=1" — while letting a bare
 * "DELETE FROM students" straight through. v2 enforces:
 *   1. Statement-type allowlist: SELECT and UPDATE only. Everything else is
 *      refused before the database ever sees it.
 *   2. UPDATE must contain a WHERE clause.
 *   3. Single statement per query (no stacked ";" injection).
 *   4. Table allowlist derived from the known schema.
 *   5. The constitution gate in brain_agent now fails closed.
 */
import { callBrain } from './llama_server';
import { db } from '../db/client';
import { logger } from '../middleware/logger';

const DB_SCHEMA = `
student_profiles: student_id, total_sessions, total_turns, study_streak, last_study_date, memory_blocks JSONB, concept_progress JSONB, error_diary JSONB, exam_targets JSONB, study_plan JSONB
conversation_turns: turn_id, session_id, student_id, turn_number, student_message, tutor_response, topic, subject, mastery_evidenced, timestamp
sessions: session_id, student_id, started_at, last_activity_at, turn_count, is_active, state JSONB
spaced_reviews: id, student_id, concept, subject, next_review_at, interval_days, review_count, mastery_level
notification_queue: id, student_id, type, content, scheduled_at, sent, priority, dedupe_key
world_model_state: student_id, predicted_next_mistake, predicted_forget_concepts, predicted_frustration_probability, predicted_exam_score, model_updated_at
`;

const ALLOWED_TABLES = [
  'student_profiles', 'conversation_turns', 'sessions',
  'spaced_reviews', 'notification_queue', 'world_model_state',
];

async function generateSQL(task: string): Promise<string[]> {
  const prompt = `You are a PostgreSQL expert. Generate SQL for this task using the schema below.
Schema: ${DB_SCHEMA}
Task: ${task}
Rules: SELECT or UPDATE only. UPDATE must have a WHERE clause. One statement per string. No DELETE, INSERT, DROP, ALTER, TRUNCATE.
Respond with JSON array of SQL strings only: ["SQL1", "SQL2"]`;

  const response = await callBrain(prompt, 0.2, 600);
  try {
    return JSON.parse(response.replace(/```json|```/g, '').trim()) as string[];
  } catch {
    const matches = response.match(/(SELECT|UPDATE)[^;]+/gi);
    return matches || [];
  }
}

/** Static safety validation — runs on every generated statement, no exceptions. */
function validateStatement(sql: string): { safe: boolean; reason: string } {
  const normalized = sql.trim().replace(/\s+/g, ' ');
  const upper = normalized.toUpperCase();

  if (normalized.includes(';') && normalized.indexOf(';') !== normalized.length - 1) {
    return { safe: false, reason: 'Stacked statements are not allowed' };
  }

  const forbidden = /\b(DELETE|INSERT|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|EXECUTE|CALL|VACUUM|pg_sleep)\b/i;
  if (forbidden.test(upper)) return { safe: false, reason: 'Statement type not allowed (SELECT/UPDATE only)' };

  if (!/^(SELECT|UPDATE)\b/i.test(upper)) return { safe: false, reason: 'Statement must begin with SELECT or UPDATE' };

  if (/^UPDATE\b/i.test(upper) && !/\bWHERE\b/i.test(upper)) {
    return { safe: false, reason: 'UPDATE without WHERE is not allowed' };
  }

  const tablesMentioned = ALLOWED_TABLES.filter(t => new RegExp(`\\b${t}\\b`, 'i').test(normalized));
  if (tablesMentioned.length === 0) return { safe: false, reason: 'Statement references no known table' };

  const unknownTableMatch = normalized.match(/\b(?:FROM|UPDATE|JOIN)\s+([a-z_][a-z0-9_]*)/gi);
  if (unknownTableMatch) {
    for (const mention of unknownTableMatch) {
      const table = mention.replace(/\b(?:FROM|UPDATE|JOIN)\s+/i, '').toLowerCase();
      if (!ALLOWED_TABLES.includes(table)) {
        return { safe: false, reason: `Table "${table}" is not in the allowed set` };
      }
    }
  }

  return { safe: true, reason: '' };
}

export async function executeAutonomousTask(task: string): Promise<{ success: boolean; rowsAffected: number; errors: string[] }> {
  logger.info(`[SQLAgent] Task: ${task.slice(0, 100)}`);

  const generated = await generateSQL(task);
  if (generated.length === 0) return { success: false, rowsAffected: 0, errors: ['No SQL generated'] };

  const errors: string[] = [];
  let totalRows = 0;

  for (const sql of generated.slice(0, 3)) {
    const validation = validateStatement(sql);
    if (!validation.safe) {
      errors.push(validation.reason);
      logger.warn(`[SQLAgent] Blocked: ${validation.reason} — ${sql.slice(0, 80)}`);
      continue;
    }

    try {
      const result = await db.query(sql);
      totalRows += result.rowCount || 0;
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(msg);
      logger.warn(`[SQLAgent] SQL failed: ${sql.slice(0, 100)} — ${msg}`);
    }
  }

  return { success: errors.length === 0, rowsAffected: totalRows, errors };
}
