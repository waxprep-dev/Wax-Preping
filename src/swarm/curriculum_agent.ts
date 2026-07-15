// The Curriculum Agent. Specialist in long-term learning path management.
// Updates the neuro-symbolic knowledge graph after every session.
// Decides what comes next in the learning journey.

import { routeAndCall } from '../llm/router';
import { getStudentKnowledgeGraph, suggestNextConcept } from '../neuro_symbolic/knowledge_graph';
import { analyzeCausally } from '../neuro_symbolic/causal_reasoner';
import type { LLMMessage } from '../types/llm';

const CURRICULUM_SYSTEM = `You are the Curriculum Agent for WaxPrep.

Your specialization: Long-term learning path optimization.
You see every session as one step in a longer journey.
Your job is to update the curriculum graph and decide what comes next.

KEY DECISIONS YOU MAKE:
1. Has the student truly mastered this concept, or just surface-learned it?
2. Are there prerequisite gaps causing this struggle?
3. What concept should come next given the current mastery state?
4. Should we slow down or accelerate the curriculum pace?
5. Is the current study plan still on track for the exam?`;

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
}

export async function runCurriculumAgent(
  studentId: string,
  currentConcept: string,
  subject: string,
  studentMessage: string,
  tutorResponse: string,
  masterySignalDetected: boolean,
  examBoard: string
): Promise<CurriculumDecision> {
  const graph = await getStudentKnowledgeGraph(studentId);
  const nextConcept = await suggestNextConcept(studentId, subject, examBoard);

  const messages: LLMMessage[] = [
    { role: 'system', content: CURRICULUM_SYSTEM },
    {
      role: 'system',
      content: `Knowledge graph state:
Mastered: ${graph.masteredConcepts.join(', ') || 'none'}
Struggling: ${graph.confusedConcepts.join(', ') || 'none'}
Suggested next: ${nextConcept || 'none determined'}`,
    },
    {
      role: 'user',
      content: `Current concept: ${currentConcept}
Subject: ${subject}
Student message: "${studentMessage.slice(0, 300)}"
Tutor response: "${tutorResponse.slice(0, 300)}"
Mastery signal detected: ${masterySignalDetected}

Make your curriculum decisions. Respond in JSON:
{
  "masteryAssessment": "mastered|progressing|struggling|surface_learned",
  "nextConcept": "${nextConcept || 'null'}",
  "paceRecommendation": "accelerate|maintain|slow_down",
  "conceptBelief": {
    "claim": "what the student now believes about ${currentConcept}",
    "status": "MASTERS|UNDERSTANDS|CONFUSES|HAS_NOT_SEEN",
    "confidence": "high|medium|low",
    "evidence": "what evidence from this turn supports this"
  },
  "curriculumNote": "one sentence for the progress memory block"
}`,
    },
  ];

  try {
    const response = await routeAndCall(messages, { jsonMode: true, maxTokens: 500 });
    const cleaned = response.content.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned) as CurriculumDecision;
  } catch {
    return {
      masteryAssessment: masterySignalDetected ? 'mastered' : 'progressing',
      nextConcept,
      paceRecommendation: 'maintain',
      conceptBelief: null,
      curriculumNote: `Covered ${currentConcept} in ${subject}.`,
    };
  }
}