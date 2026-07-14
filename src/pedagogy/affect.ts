// The empathetic sub-system.
// Reads the student's emotional state from their message and conversation history.
// Outputs an emotional alert if something needs immediate attention.
// The output shapes the force vector the Planner will emit.

import type { EmotionalSnapshot, EmotionalAlert } from "../types/events";
import type { ConversationTurn } from "../types/student";

export function detectEmotionalState(
  currentMessage: string,
  history: ConversationTurn[]
): EmotionalSnapshot {
  const m = currentMessage.toLowerCase();

  // Message length trend (getting shorter = disengaging)
  const recentLengths = history.slice(-5).map((t) => t.studentMessage.length);
  const lengthTrend =
    recentLengths.length > 1
      ? recentLengths[recentLengths.length - 1] - recentLengths[0]
      : 0;

  // Response time (proxy — we don't have exact times but we can infer from session patterns)
  const currentLength = currentMessage.length;
  const avgPreviousLength =
    recentLengths.length > 0
      ? recentLengths.reduce((a, b) => a + b, 0) / recentLengths.length
      : currentLength;

  // Shame detection
  let shamePotential = 0.2;
  if (/i think|maybe|not sure|i don't know|probably|idk|sorry/.test(m)) shamePotential += 0.2;
  if (/i'm stupid|i'm dumb|i'll never|can't do this|everyone else/.test(m)) shamePotential += 0.4;
  if (currentLength < 15 && history.length > 3) shamePotential += 0.1;
  if (lengthTrend < -50) shamePotential += 0.15;

  // Curiosity detection
  let curiosity = 0.3;
  if (/\?/.test(currentMessage) && currentLength > 25) curiosity += 0.3;
  if (/why|how|what if|but then|so that means|interesting|oh wait/.test(m)) curiosity += 0.2;
  if (currentLength > avgPreviousLength * 1.5) curiosity += 0.15;

  // Self-efficacy
  let selfEfficacy = 0.4;
  if (/i get it|i understand|makes sense|got it|i see|oh so/.test(m)) selfEfficacy += 0.3;
  if (/so basically|therefore|that means|which means/.test(m)) selfEfficacy += 0.2;
  if (shamePotential > 0.5) selfEfficacy -= 0.2;

  // Frustration
  let frustrationLevel = 0.2;
  if (/hate|useless|stupid|doesn't work|why is it|so hard|i give up/.test(m)) {
    frustrationLevel += 0.5;
  }
  if (recentLengths.every((l) => l < 20) && history.length > 5) frustrationLevel += 0.2;

  const valence = 1.0 - frustrationLevel;
  const arousal = frustrationLevel > 0.5 ? 0.7 : 0.4;
  const flowIndicator =
    curiosity > 0.6 && shamePotential < 0.3 && selfEfficacy > 0.5 ? 0.7 : 0.2;

  return {
    valence: Math.max(0, Math.min(1, valence)),
    arousal: Math.max(0, Math.min(1, arousal)),
    dominance: Math.max(0, Math.min(1, selfEfficacy)),
    shamePotential: Math.max(0, Math.min(1, shamePotential)),
    curiosity: Math.max(0, Math.min(1, curiosity)),
    selfEfficacy: Math.max(0, Math.min(1, selfEfficacy)),
    flowIndicator: Math.max(0, Math.min(1, flowIndicator)),
  };
}

// Check if the emotional state requires an immediate alert
export function checkForEmotionalAlert(
  state: EmotionalSnapshot,
  studentId: string,
  sessionId: string
): EmotionalAlert | null {
  if (state.shamePotential > 0.75) {
    return {
      id: "",
      type: "emotional.alert",
      studentId,
      sessionId,
      timestamp: new Date(),
      emotion: "shame_spike",
      confidence: state.shamePotential,
      urgency: "immediate",
      recommendedAction: "invisible_scaffolding",
    };
  }

  if (state.arousal > 0.7 && state.valence < 0.3) {
    return {
      id: "",
      type: "emotional.alert",
      studentId,
      sessionId,
      timestamp: new Date(),
      emotion: "anxiety_rising",
      confidence: state.arousal,
      urgency: "immediate",
      recommendedAction: "ground_and_reassure",
    };
  }

  if (state.curiosity < 0.2 && state.flowIndicator < 0.2) {
    return {
      id: "",
      type: "emotional.alert",
      studentId,
      sessionId,
      timestamp: new Date(),
      emotion: "boredom",
      confidence: 1.0 - state.curiosity,
      urgency: "monitor",
      recommendedAction: "pivot_to_curiosity_hook",
    };
  }

  if (state.flowIndicator > 0.65) {
    return {
      id: "",
      type: "emotional.alert",
      studentId,
      sessionId,
      timestamp: new Date(),
      emotion: "flow_detected",
      confidence: state.flowIndicator,
      urgency: "low",
      recommendedAction: "maintain_and_deepen",
    };
  }

  return null;
}