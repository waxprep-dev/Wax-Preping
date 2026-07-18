/**
 * Curriculum engine — v3.0: decoupled from hardcoded packs.
 *
 * The old bootstrapCurriculum() and recommendConcept() functions that depended
 * on JSON pack files have been removed. The curriculum engine now:
 * 1. Assesses student performance against syllabus content
 * 2. Relies on the AI navigator (src/navigation/ai_navigator.ts) for topic selection
 * 3. Uses the syllabus vector store for content lookup
 *
 * This file is preserved for backward compatibility with the assessCurriculum
 * function, which is still called by the crew's post-turn pipeline.
 */
import { db } from '../db/client';
import { logger } from '../middleware/logger';
import { routeAndCall } from '../llm/router';
import { getPrompt } from '../config/prompts';
import { searchSyllabus } from '../syllabus/store';
import type { StudentProfile } from '../types/student';

export interface CurriculumAssessment {
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

/**
 * Assess curriculum progress for a concept.
 * v3.0: Uses syllabus vector store to verify the concept exists and get context.
 */
export async function assessCurriculum(
  concept: string,
  subject: string,
  studentMessage: string,
  tutorResponse: string,
  masterySignal: string,
  examBoard: string,
  studentId: string
): Promise<CurriculumAssessment | null> {
  try {
    // v3.0: Verify concept exists in syllabus before assessing
    const syllabusResults = await searchSyllabus({
      query: concept,
      subject: subject !== 'general' ? subject : undefined,
      examBoard,
      limit: 1,
    });

    const syllabusContext = syllabusResults.length > 0
      ? `Syllabus context: ${syllabusResults[0].topic} / ${syllabusResults[0].subTopic} — ${syllabusResults[0].objectives.join('; ')}`
      : 'No syllabus entry found for this concept. Assessment is based on conversation evidence only.';

    const instruction = await getPrompt('curriculum.v1');

    const response = await routeAndCall([
      { role: 'system', content: instruction },
      {
        role: 'user',
        content: [
          `Concept: ${concept}`,
          `Subject: ${subject}`,
          `Exam board: ${examBoard}`,
          syllabusContext,
          `Student said: "${studentMessage.slice(0, 400)}"`,
          `Tutor replied: "${tutorResponse.slice(0, 400)}"`,
          `Mastery signal from perception: ${masterySignal}`,
        ].join('\n\n'),
      },
    ], { tier: 'smart', jsonMode: true, maxTokens: 400, temperature: 0.2, studentId, purpose: 'curriculum_assessment' });

    const parsed = JSON.parse(response.content.replace(/```json|```/g, '').trim());
    return {
      masteryAssessment: parsed.masteryAssessment || 'unknown',
      nextConcept: parsed.nextConcept || null,
      paceRecommendation: parsed.paceRecommendation || 'maintain',
      conceptBelief: parsed.conceptBelief || null,
      curriculumNote: parsed.curriculumNote || '',
      scheduleReview: parsed.scheduleReview === true,
    };
  } catch (err) {
    logger.warn({ err }, `[Curriculum] Assessment failed for ${concept}`);
    return null;
  }
}
