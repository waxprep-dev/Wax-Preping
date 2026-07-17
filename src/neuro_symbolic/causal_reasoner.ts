/**
 * Causal reasoner: when a student is stuck, find the ROOT cause before the
 * next teaching move. Runs rarely (only on confirmed struggle) so its cost
 * is negligible; its output feeds deliberation.
 */
import { callBrain } from '../brain/llama_server';
import { getPrompt } from '../config/prompts';
import { getStudentKnowledgeGraph } from './knowledge_graph';
import { db } from '../db/client';

export interface CausalAnalysis {
  rootCause: string;
  causalChain: string[];
  prerequisiteGaps: string[];
  recommendedIntervention: string;
  estimatedSessionsToFix: number;
}

export async function analyzeCausally(studentId: string, concept: string, subject: string): Promise<CausalAnalysis> {
  const fallback: CausalAnalysis = {
    rootCause: `Missing prerequisite or specific misconception for ${concept}`,
    causalChain: [],
    prerequisiteGaps: [],
    recommendedIntervention: `Rebuild ${concept} from a concrete, familiar example`,
    estimatedSessionsToFix: 2,
  };

  try {
    const graph = await getStudentKnowledgeGraph(studentId);
    const recentTurns = await db.query(
      `SELECT student_message FROM conversation_turns WHERE student_id = $1 AND (topic ILIKE $2 OR subject ILIKE $3) ORDER BY timestamp DESC LIMIT 5`,
      [studentId, `%${concept}%`, `%${subject}%`]
    ).catch(() => ({ rows: [] }));

    const instruction = await getPrompt('causal_reasoner.v1');
    const prompt = `${instruction}

Concept: "${concept}" in ${subject}.
Student has mastered: ${graph.masteredConcepts.join(', ') || 'nothing yet'}
Student struggles with: ${graph.confusedConcepts.join(', ') || 'nothing recorded'}
Recent messages on this concept:
${recentTurns.rows.map((t: Record<string, unknown>) => `"${(t.student_message as string).slice(0, 80)}"`).join('\n') || 'none'}`;

    const response = await callBrain(prompt, 0.3, 400);
    return { ...fallback, ...JSON.parse(response.replace(/```json|```/g, '').trim()) };
  } catch {
    return fallback;
  }
}
