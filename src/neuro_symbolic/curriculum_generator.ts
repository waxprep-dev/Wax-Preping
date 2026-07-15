// The Neuro-Symbolic Curriculum Generator.
// Creates a fully personalized curriculum from minimal data.
// Input: class level, exam board, subjects, days until exam, error diary.
// Output: a dynamic week-by-week plan grounded in the symbolic knowledge graph.

import { callBrain } from '../brain/llama_server';
import { getStudentKnowledgeGraph } from './knowledge_graph';
import { db } from '../db/client';
import { logger } from '../middleware/logger';
import type { StudyPlan, WeeklyTarget } from '../types/student';

interface CurriculumInput {
  studentId: string;
  classLevel: string;
  examBoard: string;
  subjects: string[];
  examDate: Date;
  schoolType?: string;
  location?: string;
}

export async function generateNeuroSymbolicCurriculum(
  input: CurriculumInput
): Promise<StudyPlan> {
  const graph = await getStudentKnowledgeGraph(input.studentId);
  const weeksUntilExam = Math.max(1, Math.ceil(
    (input.examDate.getTime() - Date.now()) / (7 * 24 * 60 * 60 * 1000)
  ));

  const effectiveWeeks = Math.min(weeksUntilExam, 16);

  const profileResult = await db.query(
    `SELECT error_diary, memory_blocks FROM student_profiles WHERE student_id = $1`,
    [input.studentId]
  );

  const errorDiary = profileResult.rows[0]?.error_diary || [];
  const memBlocks = profileResult.rows[0]?.memory_blocks || {};
  const progressBlock = memBlocks.progress || 'No progress history';

  const prompt = `You are a master curriculum designer for Nigerian secondary school students.

STUDENT KNOWLEDGE STATE:
- Mastered concepts: ${graph.masteredConcepts.join(', ') || 'none yet'}
- Struggling with: ${graph.confusedConcepts.join(', ') || 'none detected'}
- Blocked by missing prerequisites: ${graph.blockedConcepts.join(', ') || 'none'}
- Ready to learn next: ${graph.readyConcepts.join(', ') || 'undetermined'}
- Error patterns: ${errorDiary.map((e: { concept: string; count: number }) => `${e.concept} (${e.count}x)`).join(', ') || 'none recorded'}
- Progress notes: ${progressBlock.slice(0, 200)}

EXAM DETAILS:
- Exam Board: ${input.examBoard}
- Class Level: ${input.classLevel}
- Subjects: ${input.subjects.join(', ')}
- Exam Date: ${input.examDate.toDateString()} (${effectiveWeeks} weeks away)
- School type: ${input.schoolType || 'general secondary'}
- Location: ${input.location || 'Nigeria'}

CURRICULUM DESIGN PRINCIPLES:
1. Fix prerequisite gaps FIRST — do not teach quadratics before algebra
2. Address error patterns early — recurring mistakes must be resolved
3. Match ${input.examBoard} syllabus priorities — high-weightage topics get more time
4. Last 2 weeks = revision only, no new topics
5. Maximum 3 concepts per week (cognitive load management)
6. Week 1 starts with a mastered topic to build confidence
7. Intersperse easy wins with challenging topics to maintain motivation

Generate a ${effectiveWeeks}-week curriculum plan.
Respond in JSON:
{
  "weeklyTargets": [
    {
      "week": 1,
      "concepts": ["concept1", "concept2"],
      "focus": "brief description of this week's theme",
      "rationale": "why these concepts at this time",
      "isCompleted": false
    }
  ]
}`;

  try {
    const response = await callBrain(prompt, 0.3, 1500);
    const cleaned = response.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned) as { weeklyTargets: WeeklyTarget[] };

    const plan: StudyPlan = {
      createdAt: new Date(),
      examDate: input.examDate,
      subject: input.subjects.join(', '),
      weeklyTargets: parsed.weeklyTargets,
      currentWeek: 1,
    };

    await db.query(
      `UPDATE student_profiles SET study_plan = $1 WHERE student_id = $2`,
      [JSON.stringify(plan), input.studentId]
    );

    logger.info(`[CurriculumGenerator] Generated ${parsed.weeklyTargets.length}-week plan for ${input.studentId}`);
    return plan;
  } catch (err) {
    logger.error('[CurriculumGenerator] Failed:', err);
    // Fallback: simple sequential plan
    const topics = [...graph.confusedConcepts, ...graph.readyConcepts];
    const fallbackTargets: WeeklyTarget[] = [];
    for (let w = 1; w <= Math.min(effectiveWeeks, topics.length / 2 + 1); w++) {
      fallbackTargets.push({
        week: w,
        concepts: topics.slice((w - 1) * 2, w * 2),
        isCompleted: false,
      });
    }
    return {
      createdAt: new Date(),
      examDate: input.examDate,
      subject: input.subjects.join(', '),
      weeklyTargets: fallbackTargets,
      currentWeek: 1,
    };
  }
}