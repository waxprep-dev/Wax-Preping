/**
 * Spaced repetition (SM-2 style). v1 algorithm preserved — it was correct.
 * v2: scheduleConceptReview now reads the existing row's interval/count
 * instead of resetting them on every call (v1 always passed currentInterval=1,
 * reviewCount=0, so intervals never grew past day 1/6).
 */
import { db } from '../db/client';

export function calculateNextReview(
  currentInterval: number,
  masteryLevel: number,
  reviewCount: number
): { nextInterval: number; nextReviewAt: Date } {
  const quality = Math.round(masteryLevel * 5);
  let nextInterval: number;

  if (quality < 3) {
    nextInterval = 1;
  } else if (reviewCount === 0) {
    nextInterval = 1;
  } else if (reviewCount === 1) {
    nextInterval = 6;
  } else {
    const easeFactor = Math.max(1.3, 2.5 + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
    nextInterval = Math.round(currentInterval * easeFactor);
  }

  const nextReviewAt = new Date();
  nextReviewAt.setDate(nextReviewAt.getDate() + nextInterval);
  return { nextInterval, nextReviewAt };
}

export async function scheduleConceptReview(
  studentId: string,
  concept: string,
  subject: string,
  masteryLevel: number
): Promise<void> {
  const existing = await db.query(
    `SELECT interval_days, review_count FROM spaced_reviews WHERE student_id = $1 AND concept = $2`,
    [studentId, concept]
  ).catch(() => ({ rows: [] }));

  const currentInterval = (existing.rows[0]?.interval_days as number) || 1;
  const reviewCount = (existing.rows[0]?.review_count as number) || 0;
  const { nextInterval, nextReviewAt } = calculateNextReview(currentInterval, masteryLevel, reviewCount);

  await db.query(
    `INSERT INTO spaced_reviews (student_id, concept, subject, next_review_at, interval_days, review_count, mastery_level)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (student_id, concept) DO UPDATE SET
       next_review_at = EXCLUDED.next_review_at,
       interval_days = EXCLUDED.interval_days,
       review_count = EXCLUDED.review_count,
       mastery_level = EXCLUDED.mastery_level`,
    [studentId, concept, subject, nextReviewAt.toISOString(), nextInterval, reviewCount + 1, masteryLevel]
  );
}

export async function getDueReviews(
  studentId: string
): Promise<{ concept: string; subject: string; urgency: string }[]> {
  const result = await db.query(
    `SELECT concept, subject, next_review_at, mastery_level
     FROM spaced_reviews
     WHERE student_id = $1 AND next_review_at <= NOW() + INTERVAL '1 day'
     ORDER BY next_review_at ASC LIMIT 10`,
    [studentId]
  ).catch(() => ({ rows: [] }));

  return result.rows.map((r: Record<string, unknown>) => ({
    concept: r.concept as string,
    subject: (r.subject as string) || 'general',
    urgency: (r.mastery_level as number) < 0.5 ? 'critical' : 'soon',
  }));
}
