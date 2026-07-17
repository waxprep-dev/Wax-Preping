/**
 * Curriculum assessment: honest mastery evaluation + what comes next.
 * Runs async after the response (off the critical path), feeding the
 * knowledge-tracing update, spaced repetition, and the progress record.
 */
import { routeAndCall } from '../llm/router';
import { getPrompt } from '../config/prompts';
import { logger } from '../middleware/logger';

export interface CurriculumDecision {
  masteryAssessment: 'mastered' | 'progressing' | 'struggling' | 'surface_learned';
  nextConcept: string | null;
  paceRecommendation: 'accelerate' | 'maintain' | 'slow_down';
  conceptBelief: {
    claim: string;
    status: 'MASTERS' | 'UNDERSTANDS' | 'CONFUSES' | 'HAS_NOT_SEEN';
    confidence: 'high' | 'medium' | 'low';
    evidence: string;
  } | null;
  curriculumNote: string;
  scheduleReview: boolean;
}

export async function assessCurriculum(
  currentConcept: string,
  subject: string,
  studentMessage: string,
  tutorResponse: string,
  masterySignal: string,
  examBoard: string,
  studentId?: string
): Promise<CurriculumDecision> {
  const fallback: CurriculumDecision = {
    masteryAssessment: masterySignal === 'strong' ? 'mastered' : 'progressing',
    nextConcept: null,
    paceRecommendation: 'maintain',
    conceptBelief: null,
    curriculumNote: `Covered ${currentConcept} in ${subject}.`,
    scheduleReview: masterySignal === 'strong',
  };

  try {
    const instruction = await getPrompt('curriculum.v1');
    const response = await routeAndCall([
      { role: 'system', content: instruction },
      {
        role: 'user',
        content: `Concept: ${currentConcept} | Subject: ${subject} | Exam board: ${examBoard}
Student: "${studentMessage.slice(0, 300)}"
Tutor: "${tutorResponse.slice(0, 300)}"
Mastery signal from perception: ${masterySignal}

Make your curriculum assessment.`,
      },
    ], { tier: 'fast', jsonMode: true, maxTokens: 400, temperature: 0.2, studentId, purpose: 'curriculum' });

    const parsed = JSON.parse(response.content.replace(/```json|```/g, '').trim());
    return { ...fallback, ...parsed };
  } catch (err) {
    logger.debug({ err }, '[Curriculum] Assessment failed — fallback');
    return fallback;
  }
}
