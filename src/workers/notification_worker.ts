import 'dotenv/config';
import { initializeDatabase } from '../db/client';
import { processPendingNotifications } from '../brain/notification_agent';
import { logger } from '../middleware/logger';

async function run(): Promise<void> {
  await initializeDatabase();
  logger.info('[NotificationWorker] Started');

  const cycle = () => processPendingNotifications().catch(err => logger.error({ err }, '[NotificationWorker] Cycle error'));
  await cycle();
  setInterval(cycle, 5 * 60 * 1000);
}

run().catch(err => { logger.error({ err }, '[NotificationWorker] Fatal'); process.exit(1); });
