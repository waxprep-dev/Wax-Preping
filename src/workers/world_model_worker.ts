import 'dotenv/config';
import cron from 'node-cron';
import { db, initializeDatabase } from '../db/client';
import { runWorldModel } from '../world_model/predictive_model';
import { logger } from '../middleware/logger';

async function runForAllActive(): Promise<void> {
  const result = await db.query(
    `SELECT student_id FROM student_profiles WHERE last_seen_at > NOW() - INTERVAL '7 days' AND total_turns > 3 ORDER BY last_seen_at DESC`
  ).catch(() => ({ rows: [] }));
  logger.info(`[WorldModelWorker] Running for ${result.rows.length} students`);

  for (const row of result.rows) {
    await runWorldModel(row.student_id).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
  }
}

initializeDatabase().then(() => {
  cron.schedule('0 */2 * * *', () => runForAllActive().catch(() => {}));
  logger.info('[WorldModelWorker] Started — every 2 hours');
  runForAllActive().catch(() => {});
});
