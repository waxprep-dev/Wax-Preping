import 'dotenv/config';
import cron from 'node-cron';
import { db, initializeDatabase } from '../db/client';
import { compressOldEpisodes } from '../memory/compressor';
import { logger } from '../middleware/logger';

async function compressAll(): Promise<void> {
  const result = await db.query(
    `SELECT DISTINCT student_id FROM conversation_turns WHERE timestamp < NOW() - INTERVAL '90 days'`
  ).catch(() => ({ rows: [] }));
  logger.info(`[Compressor] Compressing ${result.rows.length} students`);

  for (const row of result.rows) {
    await compressOldEpisodes(row.student_id, 90).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
  }
}

initializeDatabase().then(() => {
  cron.schedule('0 3 * * 0', () => compressAll().catch(() => {}));
  logger.info('[Compressor] Started — Sundays at 3am UTC (90-day horizon)');
});
