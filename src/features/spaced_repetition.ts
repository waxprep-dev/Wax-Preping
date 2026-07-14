import { db } from '../db/client';
import type { ConceptProgress } from '../types/student';

// SM-2 algorithm (used by Anki, proven effective for long-term retention)
export function calculateNextReview(
  currentInterval: number,
  masteryLevel: number,
  reviewCount: number
): { nextInterval: number; nextReviewAt: Date } {
  // Quality rating based on mastery level (0-5 scale)
  const quality = Math.round(masteryLevel * 5);

  let nextInterval: number;

  if (quality < 3) {
    // Reset — not mastered
    nextInterval = 1;
  } else if (reviewCount === 0) {
    nextInterval = 1;
  } else if (reviewCount === 1) {
    nextInterval = 6;
  } else {
    // SM-2 formula
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
  masteryLevel: number,
  currentInterval = 1,
  reviewCount = 0
): Promise<void> {
  const { nextInterval, nextReviewAt } = calculateNextReview(currentInterval, masteryLevel, reviewCount);

  await db.query(
    `INSERT INTO spaced_reviews (student_id, concept, subject, next_review_at, interval_days, review_count, mastery_level)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [studentId, concept, subject, nextReviewAt.toISOString(), nextInterval, reviewCount + 1, masteryLevel]
  );
}

export async function getDueReviews(studentId: string): Promise<{ concept: string; subject: string; urgency: string }[]> {
  const result = await db.query(
    `SELECT concept, subject, next_review_at, mastery_level
     FROM spaced_reviews
     WHERE student_id = $1 AND next_review_at <= NOW() + INTERVAL '1 day'
     ORDER BY next_review_at ASC
     LIMIT 10`,
    [studentId]
  );

  return result.rows.map((r: Record<string, unknown>) => ({
    concept: r.concept as string,
    subject: r.subject as string,
    urgency: (r.mastery_level as number) < 0.5 ? 'critical' : 'soon',
  }));
}

export function formatSpacedReviewMessage(
  dueItems: { concept: string; subject: string; urgency: string }[]
): string {
  if (dueItems.length === 0) return '';

  const critical = dueItems.filter(i => i.urgency === 'critical');
  const soon = dueItems.filter(i => i.urgency === 'soon');

  const lines = ['🔁 *Review time!* These concepts are fading from your memory:\n'];

  if (critical.length > 0) {
    lines.push(`🔴 Needs urgent review: ${critical.map(i => i.concept).join(', ')}`);
  }

  if (soon.length > 0) {
    lines.push(`🟡 Review soon: ${soon.map(i => i.concept).join(', ')}`);
  }

  lines.push('\nReply "review [concept]" to start.');
  return lines.join('\n');
}