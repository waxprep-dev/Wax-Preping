// The text encoder converts a raw WhatsApp message into a pedagogical intent object.
// The Planner never sees raw text. It sees intent.
// When we add image or voice encoders later, they produce the same PedagogicalIntent shape.
// The Planner code never needs to change.

import type { PedagogicalIntent, EmotionalSnapshot } from "../types/events";

function inferPrimaryIntent(message: string): PedagogicalIntent["primaryIntent"] {
  const m = message.toLowerCase().trim();

  if (/^(hi|hello|hey|good (morning|afternoon|evening)|yo|sup)\b/.test(m)) {
    return "casual_greeting";
  }

  if (/(don't get|don't understand|confused|lost|not sure|make no sense|i'm stuck)/.test(m)) {
    return "expressing_confusion";
  }

  if (/(why|how|what|when|explain|can you|could you|tell me).*\?/.test(m)) {
    return "seeking_clarification";
  }

  if (/(example|show me|can you show|like for instance|give me)/.test(m)) {
    return "requesting_example";
  }

  if (/(so basically|i think i get|got it|makes sense|i understand|i see now|oh okay)/.test(m)) {
    return "showing_understanding";
  }

  if (/(hate this|this is hard|i give up|i can't|too hard|stupid|useless|doesn't work)/.test(m)) {
    return "expressing_frustration";
  }

  if (/(tried|if i|what if|let me try|so does that mean|therefore|because)/.test(m)) {
    return "applying_knowledge";
  }

  if (/(\?|wonder|interesting|what about|curious|wait so)/.test(m)) {
    return "exploring_curiosity";
  }

  return "unknown";
}

function detectMisconception(message: string): { has: boolean; description?: string } {
  const m = message.toLowerCase();

  const misconceptionPatterns = [
    { pattern: /current.*positive.*negative|positive.*negative.*current/, description: "May believe conventional current flows from + to -" },
    { pattern: /heavier.*fall faster|faster.*heavier/, description: "May believe heavier objects fall faster" },
    { pattern: /plants.*food.*soil|soil.*food.*plants/, description: "May believe plants get food from soil rather than photosynthesis" },
    { pattern: /evolution.*purpose|evolved.*to|evolution.*plan/, description: "May believe evolution has purpose or direction" },
    { pattern: /antibiotics.*virus|virus.*antibiotics/, description: "May believe antibiotics treat viral infections" },
    { pattern: /add.*multiply.*bigger|multiply.*add.*bigger/, description: "May have misconception about multiplication/addition relationship" },
  ];

  for (const { pattern, description } of misconceptionPatterns) {
    if (pattern.test(m)) {
      return { has: true, description };
    }
  }

  return { has: false };
}

function inferKnowledgeLevel(message: string): number {
  const m = message.toLowerCase();
  let score = 0.3; // Start at baseline unknown

  // Technical vocabulary increases inferred level
  const technicalTerms = [
    "derivative", "integral", "electromagnetic", "velocity", "acceleration",
    "hypothesis", "theorem", "coefficient", "polynomial", "logarithm",
    "osmosis", "mitochondria", "photosynthesis", "valence", "covalent",
    "simultaneous", "quadratic", "matrix", "vector", "gradient"
  ];

  const foundTerms = technicalTerms.filter((term) => m.includes(term));
  score += Math.min(foundTerms.length * 0.1, 0.4);

  // Simple vocabulary or confusion markers decrease inferred level
  if (/what is a|what does|what are|what's the meaning|i don't know what/.test(m)) {
    score -= 0.1;
  }

  // Question structure suggests engagement with the material
  if (m.includes("?") && m.length > 30) {
    score += 0.05;
  }

  return Math.max(0.0, Math.min(1.0, score));
}

function inferTemporalPressure(message: string): PedagogicalIntent["temporalPressure"] {
  const m = message.toLowerCase();
  if (/tomorrow|tonight|few hours|right now|urgent|last minute|exam is|test is today/.test(m)) {
    return "high";
  }
  if (/this week|in \d+ days|next week|soon|preparing/.test(m)) {
    return "medium";
  }
  if (/eventually|someday|trying to learn|want to understand|curious/.test(m)) {
    return "low";
  }
  return "none";
}

function inferEmotionalSignals(message: string): EmotionalSnapshot {
  const m = message.toLowerCase();

  // Shame signals: self-deprecation, hedging, apology
  const shamePotential =
    /(i'm stupid|i'm dumb|i don't get anything|everyone else|i never|i can't|i give up|maybe i just|idk|i think|maybe|not sure i|probably wrong)/.test(m)
      ? 0.7
      : 0.2;

  // Curiosity signals: follow-up questions, wonder words
  const curiosity =
    /(why|how|what if|interesting|curious|wonder|but then|so does that|wait|oh)/.test(m)
      ? 0.7
      : 0.3;

  // Frustration / negative valence
  const negative =
    /(hate|stupid|annoying|doesn't work|why is|so hard|too much|i give up|useless)/.test(m)
      ? 0.8
      : 0.3;

  // Anxiety: urgency + negative
  const anxiety = negative > 0.5 && inferTemporalPressure(message) === "high" ? 0.8 : 0.3;

  // Self-efficacy: confidence markers
  const selfEfficacy =
    /(i got it|i understand|makes sense|i can do|so basically|that means)/.test(m)
      ? 0.7
      : 0.4;

  return {
    valence: 1.0 - negative,
    arousal: anxiety > 0.6 ? 0.7 : 0.4,
    dominance: selfEfficacy,
    shamePotential,
    curiosity,
    selfEfficacy,
    flowIndicator: curiosity > 0.6 && shamePotential < 0.4 ? 0.6 : 0.2,
  };
}

// Main encoder function.
// Takes raw WhatsApp text and returns structured pedagogical intent.
export function encodeTextMessage(rawMessage: string): PedagogicalIntent {
  const misconception = detectMisconception(rawMessage);

  return {
    primaryIntent: inferPrimaryIntent(rawMessage),
    hasMisconception: misconception.has,
    misconceptionDescription: misconception.description,
    inferredKnowledgeLevel: inferKnowledgeLevel(rawMessage),
    inferredTopic: undefined, // LLM will infer the specific topic better
    temporalPressure: inferTemporalPressure(rawMessage),
    rawMessage,
    emotionalSignals: inferEmotionalSignals(rawMessage),
  };
}