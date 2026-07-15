import 'dotenv/config';
import { initializeDatabase } from '../db/client';
import { processPendingNotifications, generatePersonalizedNotification } from '../brain/notification_agent';
import { sendTextMessage } from '../whatsapp/sender';
import { logger } from '../middleware/logger';

const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!;

async function sendNotification(studentId: string, content: string): Promise<void> {
  if (!content || content.length < 5) return;

  // If content is a task description (from brain agent), generate the actual message
  if (content.length > 100 && content.includes('Student') && !content.includes('?') && !content.startsWith('"')) {
    const generated = await generatePersonalizedNotification(studentId, 'general', content);
    if (generated) {
      await sendTextMessage(phoneNumberId, studentId, generated);
    }
    return;
  }

  await sendTextMessage(phoneNumberId, studentId, content);
}

async function run(): Promise<void> {
  await initializeDatabase();
  logger.info('[NotificationWorker] Starting...');

  // Run every 5 minutes
  const runCycle = async () => {
    await processPendingNotifications(sendNotification).catch(err =>
      logger.error('[NotificationWorker] Cycle error:', err)
    );
  };

  await runCycle();
  setInterval(runCycle, 5 * 60 * 1000);
}

run().catch(err => {
  logger.error('[NotificationWorker] Fatal:', err);
  process.exit(1);
});