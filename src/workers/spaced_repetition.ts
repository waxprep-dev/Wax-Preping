/**
 * Daily spaced-repetition nudges. v2: dedupe keys so a student gets at most
 * one review nudge per day no matter how often this worker runs.
 */
import 'dotenv/config';
import cron from 'node-cron';
import { db, initializeDatabase } from '../db/client';
import { getDueReviews } from '../features/spaced_repetition';
import { generatePersonalizedNotification } from '../brain/notification_agent';
import { sendTextMessage } from '../whatsapp/sender';
import { logger } from '../middleware/logger';

const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!;

async function sendDueReviews(): Promise<void> {
  const result = await db.query(
    `SELECT DISTINCT student_id FROM spaced_reviews WHERE next_review_at <= NOW() + INTERVAL '2 hours'`
  ).catch(() => ({ rows: [] }));

  for (const row of result.rows) {
    const reviews = await getDueReviews(row.student_id);
    if (reviews.length === 0) continue;

    const today = new Date().toISOString().split('T')[0];
    const dedupeKey = `spaced_review_worker:${row.student_id}:${today}`;

    const claimed = await db.query(
      `INSERT INTO notification_queue (student_id, type, content, scheduled_at, priority, dedupe_key)
       VALUES ($1, 'spaced_review', $2, NOW(), 6, $3)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [row.student_id, `Due reviews: ${reviews.map(r => r.concept).join(', ')}`, dedupeKey]
    ).catch(() => ({ rows: [] }));

    if (claimed.rows.length === 0) continue; // already nudged today

    const message = await generatePersonalizedNotification(
      row.student_id, 'spaced_review',
      `Due reviews: ${reviews.map(r => r.concept).join(', ')}`
    );

    if (message && phoneNumberId) {
      await sendTextMessage(phoneNumberId, row.student_id, message);
      await db.query(`UPDATE notification_queue SET sent = TRUE, sent_at = NOW() WHERE dedupe_key = $1`, [dedupeKey]).catch(() => {});
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

initializeDatabase().then(() => {
  cron.schedule('0 8 * * *', () => sendDueReviews().catch(() => {}));
  logger.info('[SpacedRep] Started — daily at 8am');
});
