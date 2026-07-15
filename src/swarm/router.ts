// The Swarm Router. Uses Llama 3.2 1B (ultra-fast, 50ms) to classify
// every incoming message and route to the right agent combination.
// This runs before anything else. It determines who takes control.

import { callRouter } from '../brain/llama_server';
import { logger } from '../middleware/logger';

export interface RoutingDecision {
  primaryAgent: 'emotional' | 'pedagogy' | 'cultural' | 'curriculum';
  supportingAgents: string[];
  urgency: 'critical' | 'high' | 'normal' | 'low';
  emotionalFlag: 'shame' | 'frustration' | 'flow' | 'anxiety' | 'neutral';
  requiresChain: boolean;
  requiresTools: boolean;
  sessionPhase: 'greeting' | 'learning' | 'struggling' | 'mastery' | 'exam_prep' | 'emotional';
}

export async function routeMessage(
  message: string,
  stuckCount: number,
  lastShamePotential: number,
  lastFlowIndicator: number,
  modality: string
): Promise<RoutingDecision> {
  const prompt = `Classify this student message for an AI tutoring system.
Message: "${message.slice(0, 200)}"
Context: stuck_count=${stuckCount}, recent_shame=${lastShamePotential.toFixed(2)}, recent_flow=${lastFlowIndicator.toFixed(2)}, modality=${modality}

Respond with ONLY this JSON (no other text):
{"primary":"emotional|pedagogy|cultural|curriculum","supporting":[],"urgency":"critical|high|normal|low","emotion":"shame|frustration|flow|anxiety|neutral","chain":true|false,"tools":true|false,"phase":"greeting|learning|struggling|mastery|exam_prep|emotional"}`;

  try {
    const response = await callRouter(prompt, 128);
    const cleaned = response.replace(/```json|```/g, '').trim();
    const r = JSON.parse(cleaned);

    return {
      primaryAgent: r.primary || 'pedagogy',
      supportingAgents: r.supporting || [],
      urgency: r.urgency || 'normal',
      emotionalFlag: r.emotion || 'neutral',
      requiresChain: r.chain || false,
      requiresTools: r.tools || false,
      sessionPhase: r.phase || 'learning',
    };
  } catch {
    // Fast fallback based on simple rules
    return {
      primaryAgent: lastShamePotential > 0.6 ? 'emotional' : 'pedagogy',
      supportingAgents: ['cultural'],
      urgency: stuckCount >= 3 ? 'high' : 'normal',
      emotionalFlag: lastShamePotential > 0.6 ? 'shame' : lastFlowIndicator > 0.6 ? 'flow' : 'neutral',
      requiresChain: stuckCount >= 3,
      requiresTools: /waec|jamb|syllabus|past question/.test(message.toLowerCase()),
      sessionPhase: stuckCount >= 3 ? 'struggling' : 'learning',
    };
  }
}