/**
 * WaxPrep v3.0 — Sleep Mode Scheduler
 * Cron-based nightly consolidation.
 */

import cron from 'node-cron';
import { runSleepModeBatch } from './pipeline';
import { getCognitiveConfig } from '../config/cognitive';
import { logger } from '../middleware/logger';
import { db } from '../db/client';

let scheduledTask: cron.ScheduledTask | null = null;

/**
 * Start the sleep mode scheduler.
 */
export async function startSleepScheduler(): Promise<void> {
  const config = await getCognitiveConfig('sleep_mode');
  if (!config.enabled) {
    logger.info('[SleepScheduler] Sleep mode disabled');
    return;
  }

  const cronExpression = config.schedule_cron || '0 2 * * *';

  if (scheduledTask) {
    scheduledTask.stop();
  }

  scheduledTask = cron.schedule(cronExpression, async () => {
    logger.info('[SleepScheduler] Starting nightly consolidation');
    await runNightlyConsolidation(config.max_students_per_night || 100);
  });

  logger.info(`[SleepScheduler] Scheduled for ${cronExpression}`);
}

/**
 * Stop the scheduler.
 */
export function stopSleepScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}

/**
 * Run consolidation for a batch of students.
 */
export async function runNightlyConsolidation(maxStudents: number): Promise<void> {
  try {
    // Find students who were active in the last 7 days
    const result = await db.query(
      `SELECT DISTINCT student_id FROM conversation_turns
       WHERE timestamp > NOW() - INTERVAL '7 days'
       ORDER BY timestamp DESC
       LIMIT $1`,
      [maxStudents]
    );

    const studentIds = result.rows.map(r => r.student_id as string);

    if (studentIds.length === 0) {
      logger.info('[SleepScheduler] No active students to consolidate');
      return;
    }

    logger.info(`[SleepScheduler] Consolidating ${studentIds.length} students`);

    // Process in batches of 5 to avoid overwhelming the system
    const batchSize = 5;
    for (let i = 0; i < studentIds.length; i += batchSize) {
      const batch = studentIds.slice(i, i + batchSize);
      await runSleepModeBatch(batch);

      // Brief pause between batches
      if (i + batchSize < studentIds.length) {
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    logger.info('[SleepScheduler] Nightly consolidation complete');
  } catch (err) {
    logger.error({ err }, '[SleepScheduler] Nightly consolidation failed');
  }
}

/**
 * Manually trigger sleep mode for a specific student.
 */
export async function triggerSleepModeForStudent(studentId: string): Promise<void> {
  const { runSleepMode } = await import('./pipeline');
  await runSleepMode(studentId);
}