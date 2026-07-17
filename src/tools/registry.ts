/**
 * Tool registry: the tutor's hands. v2 dispatches tools named by the
 * deliberation plan (needsTools) instead of v1's rigid "exam_prep phase =>
 * always search" rule, so tools run when reasoning says they help.
 */
import { searchForCurriculum, findPastExamQuestions } from './search';
import { getDueReviews } from '../features/spaced_repetition';
import { generateStudyPlan } from '../features/study_plan';
import { logger } from '../middleware/logger';

export interface ToolDefinition {
  name: string;
  description: string;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: 'search_curriculum', description: 'Search WAEC/JAMB/NECO syllabus info for a topic' },
  { name: 'search_past_questions', description: 'Find past exam questions for a topic' },
  { name: 'get_due_reviews', description: 'Concepts the student has due for spaced review' },
  { name: 'generate_study_plan', description: 'Create a week-by-week study plan' },
  { name: 'recall_past_moments', description: 'Semantically recall relevant past conversations' },
];

export async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  studentId: string
): Promise<string> {
  logger.info(`[ToolRegistry] Executing: ${toolName}`);

  switch (toolName) {
    case 'search_curriculum':
      return await searchForCurriculum(params.query as string, (params.examBoard as string) || 'WAEC') || 'No curriculum info found.';

    case 'search_past_questions':
      return await findPastExamQuestions(params.topic as string, (params.examBoard as string) || 'WAEC') || 'No past questions found.';

    case 'get_due_reviews': {
      const reviews = await getDueReviews(studentId);
      return reviews.length === 0
        ? 'No concepts due for review.'
        : `Due: ${reviews.map(r => `${r.concept} (${r.urgency})`).join(', ')}`;
    }

    case 'generate_study_plan': {
      const plan = await generateStudyPlan(
        studentId,
        params.subject as string,
        new Date(params.examDate as string),
        ((params.conceptGaps as string) || '').split(',').map(s => s.trim()).filter(Boolean),
        []
      );
      return `Study plan created: ${plan.weeklyTargets.length} weeks, first week: ${plan.weeklyTargets[0]?.concepts.join(', ') || 'revision'}`;
    }

    case 'recall_past_moments': {
      const { recallRelevantEpisodes } = await import('../memory/episodic');
      const episodes = await recallRelevantEpisodes(studentId, params.query as string, 3);
      if (episodes.length === 0) return 'No relevant past conversations found.';
      return episodes.map(e =>
        `Past: Student said "${e.studentMessage.slice(0, 80)}" | Tutor: "${e.tutorResponse.slice(0, 80)}"`
      ).join('\n');
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}
