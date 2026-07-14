import type { EmotionalSnapshot, PedagogicalIntent, WorkingMemorySnapshot, StudentProfile } from '../types/student';
import type { ForceVector } from '../types/events';

export function computeForceVector(
  emotional: EmotionalSnapshot,
  intent: PedagogicalIntent,
  wm: WorkingMemorySnapshot,
  profile: StudentProfile
): ForceVector {
  let warmth = 0.5, scaffolding = 0.5, pacing = 0.0, curiosityBait = 0.5;
  let safetyEmphasis = 0.3, directness = 0.5, useAnalogy = 0.5, checkIn = 0.3;
  let metacognitive = 0.2, socratic = 0.2, culturalGrounding = 0.4, hintLevel = 0.0;

  // --- SHAME ---
  if (emotional.shamePotential > 0.65) {
    warmth = Math.min(1, warmth + 0.4); safetyEmphasis = Math.min(1, safetyEmphasis + 0.45);
    scaffolding = Math.min(1, scaffolding + 0.3); pacing = Math.max(-1, pacing - 0.45);
    directness = Math.max(0, directness - 0.25); useAnalogy = Math.min(1, useAnalogy + 0.3);
  }

  // --- FRUSTRATION ---
  if (emotional.frustration > 0.65) {
    warmth = Math.min(1, warmth + 0.35); safetyEmphasis = Math.min(1, safetyEmphasis + 0.3);
    pacing = Math.max(-1, pacing - 0.3); directness = Math.max(0, directness - 0.15);
  }

  // --- ANXIETY ---
  if (emotional.arousal > 0.7 && emotional.valence < 0.4) {
    warmth = Math.min(1, warmth + 0.3); pacing = Math.max(-1, pacing - 0.5);
    safetyEmphasis = Math.min(1, safetyEmphasis + 0.5); scaffolding = Math.min(1, scaffolding + 0.35);
  }

  // --- FLOW ---
  if (emotional.flowIndicator > 0.6) {
    curiosityBait = Math.min(1, curiosityBait + 0.3); pacing = Math.min(1, pacing + 0.2);
    checkIn = Math.max(0, checkIn - 0.25); metacognitive = Math.min(1, metacognitive + 0.2);
  }

  // --- BOREDOM ---
  if (emotional.curiosity < 0.25 && emotional.flowIndicator < 0.25) {
    curiosityBait = Math.min(1, curiosityBait + 0.5); pacing = Math.min(1, pacing + 0.3);
    useAnalogy = Math.min(1, useAnalogy + 0.4); culturalGrounding = Math.min(1, culturalGrounding + 0.3);
  }

  // --- LOW SELF-EFFICACY ---
  if (emotional.selfEfficacy < 0.35) {
    scaffolding = Math.min(1, scaffolding + 0.4); useAnalogy = Math.min(1, useAnalogy + 0.3);
    warmth = Math.min(1, warmth + 0.2); checkIn = Math.min(1, checkIn + 0.3);
  }

  // --- TIREDNESS ---
  if (emotional.tiredness > 0.6) {
    pacing = Math.max(-1, pacing - 0.3); scaffolding = Math.min(1, scaffolding + 0.2);
    directness = Math.min(1, directness + 0.2); // Be clearer when tired
    warmth = Math.min(1, warmth + 0.15);
  }

  // --- INTENT ---
  switch (intent.primaryIntent) {
    case 'expressing_confusion':
      scaffolding = Math.min(1, scaffolding + 0.3); pacing = Math.max(-1, pacing - 0.2);
      useAnalogy = Math.min(1, useAnalogy + 0.35);
      hintLevel = wm.hintLevelCurrent / 100;
      break;
    case 'seeking_clarification':
      directness = Math.min(1, directness + 0.2); checkIn = Math.min(1, checkIn + 0.2);
      break;
    case 'exploring_curiosity':
      curiosityBait = Math.min(1, curiosityBait + 0.4); pacing = Math.min(1, pacing + 0.2);
      directness = Math.max(0, directness - 0.15); metacognitive = Math.min(1, metacognitive + 0.2);
      break;
    case 'expressing_frustration':
      warmth = Math.min(1, warmth + 0.45); safetyEmphasis = Math.min(1, safetyEmphasis + 0.35);
      pacing = Math.max(-1, pacing - 0.35); culturalGrounding = Math.min(1, culturalGrounding + 0.3);
      break;
    case 'showing_understanding':
      pacing = Math.min(1, pacing + 0.25); curiosityBait = Math.min(1, curiosityBait + 0.35);
      metacognitive = Math.min(1, metacognitive + 0.3); // "Can you explain why?"
      break;
    case 'exam_prep':
      directness = Math.min(1, directness + 0.3); pacing = Math.min(1, pacing + 0.2);
      warmth = Math.min(1, warmth + 0.15); metacognitive = Math.min(1, metacognitive + 0.2);
      break;
    case 'brain_dump':
      scaffolding = Math.max(0, scaffolding - 0.2); directness = Math.min(1, directness + 0.3);
      metacognitive = Math.min(1, metacognitive + 0.4);
      break;
    case 'teach_back':
      scaffolding = Math.max(0, scaffolding - 0.3); socratic = Math.min(1, socratic + 0.4);
      metacognitive = Math.min(1, metacognitive + 0.5); checkIn = Math.min(1, checkIn + 0.3);
      break;
    case 'requesting_summary':
      pacing = Math.min(1, pacing + 0.3); directness = Math.min(1, directness + 0.4);
      scaffolding = Math.max(0, scaffolding - 0.2);
      break;
    case 'casual_greeting':
      warmth = Math.min(1, warmth + 0.4); directness = Math.max(0, directness - 0.3);
      pacing = Math.max(-1, pacing - 0.1);
      break;
  }

  if (intent.hasMisconception) {
    scaffolding = Math.min(1, scaffolding + 0.3); useAnalogy = Math.min(1, useAnalogy + 0.4);
    directness = Math.max(0, directness - 0.2); safetyEmphasis = Math.min(1, safetyEmphasis + 0.25);
  }

  if (intent.temporalPressure === 'exam_today' || intent.temporalPressure === 'exam_tomorrow') {
    directness = Math.min(1, directness + 0.4); warmth = Math.min(1, warmth + 0.2);
    pacing = Math.min(1, pacing + 0.25); metacognitive = Math.min(1, metacognitive + 0.25);
  }

  // --- WORKING MEMORY ---
  if (wm.unresolvedQuestion) { checkIn = Math.min(1, checkIn + 0.3); scaffolding = Math.min(1, scaffolding + 0.2); }
  if (wm.turnsInCurrentTopic > 10) { curiosityBait = Math.min(1, curiosityBait + 0.3); useAnalogy = Math.min(1, useAnalogy + 0.2); }
  if (wm.studentLeadingConversation) { directness = Math.max(0, directness - 0.15); curiosityBait = Math.min(1, curiosityBait + 0.2); }
  if (wm.stuckRepetitionCount >= 2) {
    useAnalogy = Math.min(1, useAnalogy + 0.4); culturalGrounding = Math.min(1, culturalGrounding + 0.4);
    hintLevel = Math.min(1, (wm.stuckRepetitionCount / 5));
  }

  // --- PROFILE ---
  if (profile.learningStyle.prefersAnalogies) useAnalogy = Math.min(1, useAnalogy + 0.25);
  if (profile.learningStyle.toleratesAbstraction < 0.4) useAnalogy = Math.min(1, useAnalogy + 0.2);
  if (profile.emotionalProfile.shameThreshold < 0.4) { safetyEmphasis = Math.min(1, safetyEmphasis + 0.25); warmth = Math.min(1, warmth + 0.2); }
  if (profile.learningStyle.prefersSocratic) socratic = Math.min(1, socratic + 0.35);
  if (profile.learningStyle.respondsToHumor && emotional.valence > 0.5) curiosityBait = Math.min(1, curiosityBait + 0.15);
  if (profile.learningStyle.prefersShortAnswers) pacing = Math.min(1, pacing + 0.2);
  if (profile.emotionalProfile.needsExplicitValidation) warmth = Math.min(1, warmth + 0.15);

  // Cultural grounding — Nigeria-aware
  if (profile.culturalContext.country === 'Nigeria') culturalGrounding = Math.min(1, culturalGrounding + 0.15);

  const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
  return {
    warmth: clamp(warmth),
    scaffolding: clamp(scaffolding),
    pacing: clamp(pacing, -1, 1),
    curiosityBait: clamp(curiosityBait),
    safetyEmphasis: clamp(safetyEmphasis),
    directness: clamp(directness),
    useAnalogy: clamp(useAnalogy),
    checkIn: clamp(checkIn),
    metacognitive: clamp(metacognitive),
    socratic: clamp(socratic),
    culturalGrounding: clamp(culturalGrounding),
    hintLevel: clamp(hintLevel),
  };
}