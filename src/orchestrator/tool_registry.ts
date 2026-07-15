// The tool registry. The AI discovers tools through descriptions.
// Nothing is hardcoded about when to use a tool.
// The AI reads the descriptions and decides.

import { searchForCurriculum, findPastExamQuestions } from '../tools/search';
import { getDueReviews } from '../features/spaced_repetition';
import { generateStudyPlan } from '../features/study_plan';
import { logger } from '../middleware/logger';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'search_curriculum',
    description: 'Search WAEC, JAMB, NECO, or Post-UTME curriculum and syllabus for a topic. Use when student asks about exam topics, what to study, past questions, or when you need to verify curriculum coverage.',
    parameters: {
      query: { type: 'string', description: 'The topic or concept to search', required: true },
      examBoard: { type: 'string', description: 'The exam board: WAEC, JAMB, NECO, or general', required: false },
    },
  },
  {
    name: 'search_past_questions',
    description: 'Find relevant past exam questions for a topic. Use when student is preparing for exams, wants practice questions, or when reinforcing a mastered concept.',
    parameters: {
      topic: { type: 'string', description: 'The topic to find past questions for', required: true },
      examBoard: { type: 'string', description: 'WAEC, JAMB, NECO', required: false },
    },
  },
  {
    name: 'get_due_reviews',
    description: 'Check which concepts the student has scheduled for spaced repetition review. Use at the start of sessions or when transitioning between topics.',
    parameters: {
      studentId: { type: 'string', description: 'The student ID', required: true },
    },
  },
  {
    name: 'generate_study_plan',
    description: 'Create a week-by-week study plan for the student. Use when student asks for a plan, mentions an exam date, or when there is significant time pressure.',
    parameters: {
      studentId: { type: 'string', description: 'The student ID', required: true },
      subject: { type: 'string', description: 'The subject to plan for', required: true },
      examDate: { type: 'string', description: 'ISO date string of exam date', required: true },
      conceptGaps: { type: 'string', description: 'Comma-separated list of concepts the student needs to learn', required: false },
    },
  },
  {
    name: 'recall_past_moments',
    description: 'Search episodic memory for relevant past conversations about a topic. Use when student returns to a previously discussed topic or when you want to build on past work.',
    parameters: {
      query: { type: 'string', description: 'What to search for in past conversations', required: true },
      studentId: { type: 'string', description: 'The student ID', required: true },
    },
  },
  {
    name: 'get_symbolic_knowledge',
    description: 'Retrieve the AI\'s symbolic belief state about what the student understands, confuses, or has not seen. Use when planning what to teach next or detecting if prerequisites are missing.',
    parameters: {
      studentId: { type: 'string', description: 'The student ID', required: true },
      concept: { type: 'string', description: 'The concept to check beliefs about', required: false },
    },
  },
];

export function getToolDescriptionsForPrompt(): string {
  return TOOL_DEFINITIONS.map(t =>
    `- ${t.name}: ${t.description}\n  Parameters: ${Object.entries(t.parameters).map(([k, v]) => `${k} (${v.required ? 'required' : 'optional'}): ${v.description}`).join(', ')}`
  ).join('\n\n');
}

export async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  studentId: string
): Promise<string> {
  logger.info(`[ToolRegistry] Executing: ${toolName}`, { params });

  try {
    switch (toolName) {
      case 'search_curriculum': {
        const result = await searchForCurriculum(
          params.query as string,
          (params.examBoard as string) || 'WAEC'
        );
        return result || 'No curriculum information found for this topic.';
      }

      case 'search_past_questions': {
        const result = await findPastExamQuestions(
          params.topic as string,
          (params.examBoard as string) || 'WAEC'
        );
        return result || 'No past questions found for this topic.';
      }

      case 'get_due_reviews': {
        const reviews = await getDueReviews(studentId);
        if (reviews.length === 0) return 'No concepts are due for review right now.';
        return `Due for review: ${reviews.map(r => `${r.concept} (${r.urgency})`).join(', ')}`;
      }

      case 'generate_study_plan': {
        const plan = await generateStudyPlan(
          studentId,
          params.subject as string,
          new Date(params.examDate as string),
          ((params.conceptGaps as string) || '').split(',').map(s => s.trim()).filter(Boolean),
          []
        );
        return `Study plan created: ${plan.weeklyTargets.length} weeks, starting with ${plan.weeklyTargets[0]?.concepts.join(', ')}`;
      }

      case 'recall_past_moments': {
        const { recallRelevantEpisodes } = await import('../memory/episodic');
        const episodes = await recallRelevantEpisodes(studentId, params.query as string, 3);
        if (episodes.length === 0) return 'No relevant past conversations found.';
        return episodes.map(e =>
          `Past turn: Student said "${e.studentMessage.slice(0, 80)}", Tutor responded "${e.tutorResponse.slice(0, 80)}"`
        ).join('\n');
      }

      case 'get_symbolic_knowledge': {
        const { getStudentProfile } = await import('../memory/semantic');
        const profile = await getStudentProfile(studentId);
        const concept = params.concept as string;

        if (concept) {
          const cp = profile.conceptProgress[concept];
          if (!cp) return `No knowledge recorded for "${concept}" yet.`;
          return `Symbolic beliefs for "${concept}": mastery=${(cp.masteryLevel * 100).toFixed(0)}%, beliefs=${JSON.stringify(cp.symbolicBeliefs?.slice(0, 3))}`;
        }

        const allConcepts = Object.entries(profile.conceptProgress)
          .map(([k, v]) => `${k}: ${(v.masteryLevel * 100).toFixed(0)}%`)
          .join(', ');
        return allConcepts || 'No concept knowledge recorded yet.';
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    logger.error(`[ToolRegistry] Tool ${toolName} failed:`, err);
    return `Tool ${toolName} failed: ${(err as Error).message}`;
  }
}