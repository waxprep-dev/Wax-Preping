// The Backend Brain. The most important file in WaxPrep.
// This runs 24/7 as a separate process.
// It is not a cron job. It is an autonomous agent.
// Every 60 seconds it wakes, reads the database state,
// reasons about what needs to happen, and acts.
// No hardcoded rules. No templates. The AI decides everything.

import 'dotenv/config';
import { callBrain } from './llama_server';
import { executeAutonomousTask } from './sql_agent';
import { getConstitution, checkAgainstConstitution } from './constitution';
import { db, initializeDatabase } from '../db/client';
import { logger } from '../middleware/logger';

const BRAIN_LOOP_INTERVAL_MS = 60_000;

interface DatabaseState {
  totalStudents: number;
  activeStudentsLast24h: number;
  studentsWithExamTomorrow: string[];
  studentsWithExamToday: string[];
  studentsWithDueReviews: string[];
  studentsWhoHaventStudiedIn3Days: string[];
  studentsInFlowLastSession: string[];
  studentsWithHighShameLastSession: string[];
  pendingNotifications: number;
  unsentReviews: number;
}

async function readDatabaseState(): Promise<DatabaseState> {
  const [
    totalStudents,
    activeStudents,
    examTomorrow,
    examToday,
    dueReviews,
    inactiveStudents,
    pendingNotifs,
  ] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM student_profiles`),
    db.query(`SELECT COUNT(DISTINCT student_id) FROM sessions WHERE started_at > NOW() - INTERVAL '24 hours'`),
    db.query(`
      SELECT student_id FROM student_profiles
      WHERE exam_targets @> '[{}]'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(exam_targets) t
        WHERE (t->>'examDate')::date = CURRENT_DATE + 1
      )
    `),
    db.query(`
      SELECT student_id FROM student_profiles
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements(exam_targets) t
        WHERE (t->>'examDate')::date = CURRENT_DATE
      )
    `),
    db.query(`
      SELECT DISTINCT student_id FROM spaced_reviews
      WHERE next_review_at <= NOW() + INTERVAL '2 hours' AND mastery_level < 0.8
    `),
    db.query(`
      SELECT student_id FROM student_profiles
      WHERE last_seen_at < NOW() - INTERVAL '3 days'
      AND total_turns > 5
    `),
    db.query(`SELECT COUNT(*) FROM notification_queue WHERE sent = FALSE`),
  ]);

  return {
    totalStudents: parseInt(totalStudents.rows[0].count),
    activeStudentsLast24h: parseInt(activeStudents.rows[0].count),
    studentsWithExamTomorrow: examTomorrow.rows.map((r: Record<string, unknown>) => r.student_id as string),
    studentsWithExamToday: examToday.rows.map((r: Record<string, unknown>) => r.student_id as string),
    studentsWithDueReviews: dueReviews.rows.map((r: Record<string, unknown>) => r.student_id as string),
    studentsWhoHaventStudiedIn3Days: inactiveStudents.rows.map((r: Record<string, unknown>) => r.student_id as string),
    studentsInFlowLastSession: [],
    studentsWithHighShameLastSession: [],
    pendingNotifications: parseInt(pendingNotifs.rows[0].count),
    unsentReviews: 0,
  };
}

async function reasonAboutState(state: DatabaseState): Promise<string[]> {
  const constitution = await getConstitution();

  const prompt = `You are the Backend Brain of WaxPrep, an AI tutoring system for Nigerian students.

CONSTITUTION (your guiding principles):
${constitution}

CURRENT DATABASE STATE:
- Total students: ${state.totalStudents}
- Active students (last 24h): ${state.activeStudentsLast24h}
- Students with exam TOMORROW: ${state.studentsWithExamTomorrow.length} students [IDs: ${state.studentsWithExamTomorrow.slice(0, 5).join(', ')}]
- Students with exam TODAY: ${state.studentsWithExamToday.length} students [IDs: ${state.studentsWithExamToday.slice(0, 5).join(', ')}]
- Students with overdue spaced reviews: ${state.studentsWithDueReviews.length}
- Students inactive for 3+ days: ${state.studentsWhoHaventStudiedIn3Days.length}
- Pending unsent notifications: ${state.pendingNotifications}

YOUR JOB RIGHT NOW:
Look at this state and decide what actions need to happen. Think like a caring school administrator who knows every student personally.

What should be done for:
1. Students with exam today?
2. Students with exam tomorrow?
3. Students inactive for 3+ days?
4. Students with overdue reviews?

Generate a list of SPECIFIC ACTIONS. Each action should be:
- A clear database task OR a notification to queue
- Constitutional (check against the principles)
- Specific to the student situation

Respond with a JSON array of action strings:
[
  "For student 234x: Queue an exam-day confidence message that references their strongest topic",
  "For all students with exam tomorrow: Update their study_plan status to final_review and queue personalized confidence messages",
  "For 3-day inactive students: Queue a gentle re-engagement message that references what we last worked on"
]`;

  try {
    const response = await callBrain(prompt, 0.4, 800);
    const cleaned = response.replace(/```json|```/g, '').trim();
    const actions = JSON.parse(cleaned) as string[];
    return actions;
  } catch {
    logger.warn('[BrainAgent] Failed to parse reasoning output');
    return [];
  }
}

async function executeAction(action: string, state: DatabaseState): Promise<void> {
  // Constitutional check before executing
  const check = await checkAgainstConstitution(action, callBrain);

  if (!check.approved) {
    logger.warn(`[BrainAgent] Action blocked by Constitution: ${action}`);
    logger.warn(`[BrainAgent] Reason: ${check.reason}`);

    if (check.suggestedRevision) {
      logger.info(`[BrainAgent] Using revised action: ${check.suggestedRevision}`);
      await executeAutonomousTask(check.suggestedRevision);
    }
    return;
  }

  await executeAutonomousTask(action);
}

async function queuePersonalizedNotification(
  studentId: string,
  type: string,
  contextSummary: string
): Promise<void> {
  const { generatePersonalizedNotification } = await import('./notification_agent');
  const content = await generatePersonalizedNotification(studentId, type, contextSummary);

  if (!content) return;

  await db.query(
    `INSERT INTO notification_queue (id, student_id, type, content, scheduled_at, priority, context)
     VALUES (gen_random_uuid(), $1, $2, $3, NOW(), $4, $5)
     ON CONFLICT DO NOTHING`,
    [studentId, type, content, getPriority(type), JSON.stringify({ contextSummary })]
  );
}

function getPriority(type: string): number {
  const priorities: Record<string, number> = {
    exam_today: 10,
    exam_tomorrow: 9,
    shame_recovery: 8,
    frustration_recovery: 7,
    spaced_review: 6,
    streak_milestone: 5,
    re_engagement: 4,
    study_plan_progress: 3,
    weekly_summary: 2,
    general: 1,
  };
  return priorities[type] || 1;
}

async function handleExamDayStudents(studentIds: string[]): Promise<void> {
  for (const studentId of studentIds.slice(0, 50)) {
    await queuePersonalizedNotification(
      studentId,
      'exam_today',
      'Student has exam today. Send them a personalized confidence message that references their specific strengths and weakest area for one last quick review.'
    );
    await new Promise(r => setTimeout(r, 500));
  }
}

async function handleExamTomorrowStudents(studentIds: string[]): Promise<void> {
  for (const studentId of studentIds.slice(0, 50)) {
    // Update study plan to final_review phase
    await executeAutonomousTask(
      `Update student ${studentId}'s study plan to final_review phase and set current_week to last week`
    );

    await queuePersonalizedNotification(
      studentId,
      'exam_tomorrow',
      'Student has exam tomorrow. Reference their weakest topic from error_diary and offer one last review session. Also remind them about sleep and food.'
    );
    await new Promise(r => setTimeout(r, 500));
  }
}

async function handleInactiveStudents(studentIds: string[]): Promise<void> {
  for (const studentId of studentIds.slice(0, 20)) {
    await queuePersonalizedNotification(
      studentId,
      're_engagement',
      'Student has been inactive for 3+ days. Reference what we last worked on and ask how they are doing. Make it personal and warm, not a reminder about studying.'
    );
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function handleDueReviews(studentIds: string[]): Promise<void> {
  for (const studentId of studentIds.slice(0, 30)) {
    await queuePersonalizedNotification(
      studentId,
      'spaced_review',
      'Student has concepts due for spaced repetition review. Reference a specific concept using the analogy we used when they first learned it.'
    );
    await new Promise(r => setTimeout(r, 500));
  }
}

async function progressStudyPlans(): Promise<void> {
  await executeAutonomousTask(
    'Check all students whose current week concepts are all mastered (masteryLevel > 0.7 in concept_progress) and advance their study_plan currentWeek by 1. Insert a notification into notification_queue to tell them they unlocked the next week.'
  );
}

async function cleanupOldData(): Promise<void> {
  await db.query(
    `DELETE FROM processed_messages WHERE processed_at < NOW() - INTERVAL '6 hours'`
  );
  await db.query(
    `UPDATE notification_queue SET sent = TRUE WHERE sent = FALSE AND scheduled_at < NOW() - INTERVAL '24 hours'`
  );
}

async function runBrainLoop(): Promise<void> {
  logger.info('[BrainAgent] Awakening...');

  const state = await readDatabaseState();
  logger.info(`[BrainAgent] State: ${state.totalStudents} students, ${state.activeStudentsLast24h} active, ${state.studentsWithExamTomorrow.length} with exam tomorrow`);

  // Execute priority actions
  const actions = await Promise.allSettled([
    handleExamDayStudents(state.studentsWithExamToday),
    handleExamTomorrowStudents(state.studentsWithExamTomorrow),
    handleInactiveStudents(state.studentsWhoHaventStudiedIn3Days),
    handleDueReviews(state.studentsWithDueReviews),
    progressStudyPlans(),
    cleanupOldData(),
  ]);

  const failed = actions.filter(a => a.status === 'rejected').length;
  if (failed > 0) {
    logger.warn(`[BrainAgent] ${failed} actions failed`);
  }

  // Run AI reasoning for edge cases
  if (state.studentsWithExamTomorrow.length > 0 || state.studentsWhoHaventStudiedIn3Days.length > 0) {
    const reasonedActions = await reasonAboutState(state);
    logger.info(`[BrainAgent] AI reasoned ${reasonedActions.length} additional actions`);

    for (const action of reasonedActions.slice(0, 5)) {
      await executeAction(action, state).catch(err =>
        logger.error('[BrainAgent] Action failed:', err)
      );
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  logger.info('[BrainAgent] Cycle complete. Sleeping...');
}

async function startBrainAgent(): Promise<void> {
  logger.info('[BrainAgent] Starting Backend Brain...');
  await initializeDatabase();

  // Run immediately then loop
  await runBrainLoop().catch(err => logger.error('[BrainAgent] Loop error:', err));

  setInterval(() => {
    runBrainLoop().catch(err => logger.error('[BrainAgent] Loop error:', err));
  }, BRAIN_LOOP_INTERVAL_MS);
}

startBrainAgent().catch(err => {
  logger.error('[BrainAgent] Fatal:', err);
  process.exit(1);
});