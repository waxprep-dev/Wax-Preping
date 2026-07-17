/**
 * Study plan generation. v1 logic preserved; v2 prompt is DB-configurable,
 * skips strengths properly, and validates weeks against the exam window.
 */
import { routeAndCall } from '../llm/router';
import { getPrompt } from '../config/prompts';
import { db } from '../db/client';
import { logger } from '../middleware/logger';
import type { StudyPlan, WeeklyTarget } from '../types/student';

export async function generateStudyPlan(
  studentId: string,
  subject: string,
  examDate: Date,
  conceptGaps: string[],
  strengths: string[]
): Promise<StudyPlan> {
  const weeksUntilExam = Math.max(1, Math.ceil(
    (examDate.getTime() - Date.now()) / (7 * 24 * 60 * 60 * 1000)
  ));
  const effectiveWeeks = Math.min(weeksUntilExam, 12);

  let weeklyTargets: WeeklyTarget[] = [];

  try {
    const instruction = await getPrompt('study_plan.v1');
    const response = await routeAndCall([
      { role: 'system', content: instruction },
      {
        role: 'user',
        content: `Subject: ${subject}
Exam: ${examDate.toDateString()} (${effectiveWeeks} weeks away)
Gaps to close: ${conceptGaps.join(', ') || 'general revision'}
Already strong (skip these): ${strengths.join(', ') || 'none'}
Create the ${effectiveWeeks}-week plan.`,
      },
    ], { tier: 'smart', jsonMode: true, maxTokens: 1200, temperature: 0.4, studentId, purpose: 'study_plan' });

    const parsed = JSON.parse(response.content.replace(/```json|```/g, '').trim());
    weeklyTargets = (parsed.weeklyTargets || []).slice(0, effectiveWeeks);
  } catch (err) {
    logger.warn({ err }, '[StudyPlan] Generation failed — building fallback plan');
    conceptGaps.slice(0, effectiveWeeks * 3).forEach((concept, i) => {
      const week = Math.floor(i / 3) + 1;
      if (!weeklyTargets[week - 1]) weeklyTargets[week - 1] = { week, concepts: [], isCompleted: false };
      weeklyTargets[week - 1].concepts.push(concept);
    });
  }

  const plan: StudyPlan = {
    createdAt: new Date(),
    examDate,
    subject,
    weeklyTargets,
    currentWeek: 1,
  };

  await db.query(
    `UPDATE student_profiles SET study_plan = $1 WHERE student_id = $2`,
    [JSON.stringify(plan), studentId]
  );

  return plan;
}
