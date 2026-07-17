import 'dotenv/config';
import cron from 'node-cron';
import { db, initializeDatabase } from '../db/client';
import { evolveComponent } from '../reflection/evolution';
import { logger } from '../middleware/logger';

async function evolveAll(): Promise<void> {
  const result = await db.query(`SELECT component_id, content FROM prompt_components`).catch(() => ({ rows: [] }));
  logger.info(`[PromptEvolution] Checking ${result.rows.length} components`);

  for (const row of result.rows) {
    await evolveComponent(row.component_id, row.content).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
  }
}

initializeDatabase().then(() => {
  cron.schedule('0 2 * * 0', () => evolveAll().catch(() => {}));
  logger.info('[PromptEvolution] Started — Sundays at 2am UTC');
  if (process.argv.includes('--now')) evolveAll().catch(() => {});
});
