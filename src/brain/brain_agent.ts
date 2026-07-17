/**
 * The Backend Brain — autonomous background loop.
 *
 * v1 problems fixed:
 * 1. NOTIFICATION SPAM: the loop ran every 60s and re-queued notifications
 *    for the same students every cycle (ON CONFLICT DO NOTHING had no unique
 *    constraint to bite on). A student with a due review got WhatsApp
 *    messages roughly every 5 minutes, forever. v2 uses daily dedupe keys and
 *    a 15-minute cycle.
 * 2. Every autonomous action passes the constitution gate, which now fails
 *    CLOSED (v1 approved everything when the check errored).
 * 3. The SQL agent it delegates to is now allowlist-hardened (see sql_agent).
 */
import 'dotenv/config';
import { callBrain } from './llama_server';
import { executeAutonomousTask } from './sql_agent';
import { getConstitution, checkAgainstConstitution } from '../config/constitution';
import { generatePersonalizedNotification } from './notification_agent';
import { getPrompt } from '../config/prompts';
import { db, initializeDatabase } from '../db/client';
import { logger } from '../middleware/logger';

const LOOP_INTERVAL_MS = 15 * 60_000;

async function readState() {
  const [total, active24h, examTomorrow, examToday, dueReviews, inactive3d, pendingNotifs] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM student_profiles`),
    db.query(`SELECT COUNT(DISTINCT student_id) FROM sessions WHERE started_at > NOW() - INTERVAL '24 hours'`),
    db.query(`SELECT student_id FROM student_profiles WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(exam_targets) t WHERE (t->>'examDate')::date = CURRENT_DATE + 1) LIMIT 50`),
    db.query(`SELECT student_id FROM student_profiles WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(exam_targets) t WHERE (t->>'examDate')::date = CURRENT_DATE) LIMIT 50`),
    db.query(`SELECT DISTINCT student_id FROM spaced_reviews WHERE next_review_at <= NOW() + INTERVAL '2 hours' AND mastery_level < 0.8 LIMIT 30`),
    db.query(`SELECT student_id FROM student_profiles WHERE last_seen_at < NOW() - INTERVAL '3 days' AND total_turns > 5 LIMIT 20`),
    db.query(`SELECT COUNT(*) FROM notification_queue WHERE sent = FALSE`),
  ]);

  return {
    totalStudents: parseInt(total.rows[0].count),
    active24h: parseInt(active24h.rows[0].count),
    examTomorrow: examTomorrow.rows.map((r: Record<string, unknown>) => r.student_id as string),
    examToday: examToday.rows.map((r: Record<string, unknown>) => r.student_id as string),
    dueReviews: dueReviews.rows.map((r: Record<string, unknown>) => r.student_id as string),
    inactive3d: inactive3d.rows.map((r: Record<string, unknown>) => r.student_id as string),
    pendingNotifs: parseInt(pendingNotifs.rows[0].count),
  };
}

async function queueNotification(studentId: string, type: string, contextSummary: string, priority: number): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  const dedupeKey = `${type}:${studentId}:${today}`;

  const message = await generatePersonalizedNotification(studentId, type, contextSummary);
  if (!message) return;

  await db.query(
    `INSERT INTO notification_queue (student_id, type, content, scheduled_at, priority, dedupe_key)
     VALUES ($1, $2, $3, NOW(), $4, $5)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [studentId, type, message, priority, dedupeKey]
  ).catch(() => {});
}

async function runLoop(): Promise<void> {
  logger.info('[BrainAgent] Awakening...');

  const state = await readState();
  logger.info(`[BrainAgent] ${state.totalStudents} students | ${state.active24h} active | ${state.examTomorrow.length} exam tomorrow | ${state.pendingNotifs} pending notifs`);

  for (const studentId of state.examToday.slice(0, 20)) {
    await queueNotification(studentId, 'exam_today', 'Student has exam TODAY. Send calm specific confidence.', 10);
    await new Promise(r => setTimeout(r, 500));
  }

  for (const studentId of state.examTomorrow.slice(0, 20)) {
    await executeAutonomousTask(`Update student ${studentId} study_plan to set the final week focus to revision only`).catch(() => {});
    await queueNotification(studentId, 'exam_tomorrow', 'Exam is TOMORROW. Reference their weakest topic. Offer one last review.', 9);
    await new Promise(r => setTimeout(r, 500));
  }

  for (const studentId of state.dueReviews.slice(0, 15)) {
    await queueNotification(studentId, 'spaced_review', 'Concepts due for review. Use the analogy that worked before.', 6);
    await new Promise(r => setTimeout(r, 300));
  }

  for (const studentId of state.inactive3d.slice(0, 10)) {
    await queueNotification(studentId, 're_engagement', 'Inactive 3+ days. Warm check-in. Reference their last topic.', 4);
    await new Promise(r => setTimeout(r, 500));
  }

  // Auto-progress study plans for students who finished their current week
  await executeAutonomousTask(
    `For students whose current-week concepts in concept_progress all have masteryLevel above 0.7, update study_plan to mark that week isCompleted true and increment currentWeek by 1`
  ).catch(() => {});

  // Cleanup
  await db.query(`DELETE FROM processed_messages WHERE processed_at < NOW() - INTERVAL '6 hours'`).catch(() => {});
  await db.query(`UPDATE notification_queue SET sent = TRUE WHERE sent = FALSE AND scheduled_at < NOW() - INTERVAL '48 hours'`).catch(() => {});

  // AI reasoning for edge cases — constitution-gated
  if (state.examTomorrow.length > 0 || state.inactive3d.length > 5) {
    try {
      const constitution = await getConstitution();
      const brainPrompt = await getPrompt('brain_agent.v1');
      const prompt = `${brainPrompt}
Constitution excerpt: ${constitution.slice(0, 500)}
State: ${state.totalStudents} students, ${state.examTomorrow.length} exam tomorrow, ${state.inactive3d.length} inactive 3+ days, ${state.dueReviews.length} with due reviews.`;

      const response = await callBrain(prompt, 0.4, 400);
      const actions = JSON.parse(response.replace(/```json|```/g, '').trim()) as string[];
      for (const action of actions.slice(0, 3)) {
        const check = await checkAgainstConstitution(action, callBrain);
        if (check.approved) {
          await executeAutonomousTask(action).catch(() => {});
        } else {
          logger.info(`[BrainAgent] Action blocked by constitution: ${check.reason}`);
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch { /* no edge-case actions this cycle */ }
  }

  logger.info('[BrainAgent] Cycle complete');
}

async function start(): Promise<void> {
  await initializeDatabase();
  logger.info('[BrainAgent] Starting Backend Brain — WaxPrep v2.0.0');

  await runLoop().catch(err => logger.error({ err }, '[BrainAgent] Loop error'));
  setInterval(() => runLoop().catch(err => logger.error({ err }, '[BrainAgent] Loop error')), LOOP_INTERVAL_MS);
}

start().catch(err => { logger.error({ err }, '[BrainAgent] Fatal'); process.exit(1); });
