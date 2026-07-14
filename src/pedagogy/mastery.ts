import type { ConversationTurn } from '../types/student';

export type MasteryEvidence =
  | 'self_explanation'
  | 'novel_application'
  | 'transfer'
  | 'teach_back'
  | 'none';

export function detectMasterySignal(
  message: string,
  history: ConversationTurn[]
): { detected: boolean; evidence: MasteryEvidence; level: number } {
  const m = message.toLowerCase();

  // Self-explanation: student explains in their own words
  if (/so basically|in other words|what you mean is|so what's happening is|that means|so the reason/.test(m) && message.length > 80) {
    return { detected: true, evidence: 'self_explanation', level: 0.65 };
  }

  // Teach-back: student explains to the AI
  if (/let me explain|so basically you see|i'll try to explain|ok so what happens/.test(m) && message.length > 100) {
    return { detected: true, evidence: 'teach_back', level: 0.8 };
  }

  // Novel application: student applies to new situation
  if (/what about|does that mean for|so would that apply to|in that case|so if i change/.test(m) && message.length > 60) {
    return { detected: true, evidence: 'novel_application', level: 0.7 };
  }

  // Transfer: student connects to other concepts
  if (/this is like|same as|similar to|reminds me of|connects to|so it's the same principle/.test(m)) {
    return { detected: true, evidence: 'transfer', level: 0.75 };
  }

  // Confidence spike after confusion
  const recentHistory = history.slice(-5);
  const wasConfused = recentHistory.some(t => /don't get|confused|don't understand/.test(t.studentMessage.toLowerCase()));
  const nowConfident = /got it|makes sense|oh i see|now i understand|clicked/.test(m);
  if (wasConfused && nowConfident) {
    return { detected: true, evidence: 'self_explanation', level: 0.6 };
  }

  return { detected: false, evidence: 'none', level: 0 };
}

export function detectCognitiveLoad(
  message: string,
  history: ConversationTurn[]
): 'overloaded' | 'high' | 'optimal' | 'low' {
  const messageComplexity = message.length > 200 ? 0.3 : 0.6;
  const recentMessages = history.slice(-4).map(t => t.studentMessage);

  const errorCount = recentMessages.filter(m => /wrong|mistake|not right|error/.test(m.toLowerCase())).length;
  const confusionCount = recentMessages.filter(m => /don't get|confused|lost/.test(m.toLowerCase())).length;

  if (confusionCount >= 3 || errorCount >= 3) return 'overloaded';
  if (confusionCount >= 2 || errorCount >= 2) return 'high';
  if (messageComplexity < 0.4 && message.length > 150) return 'low';
  return 'optimal';
}