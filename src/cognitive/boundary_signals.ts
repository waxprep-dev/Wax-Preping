/**
 * WaxPrep v3.0 — Boundary Signal Computation
 * System 1 fast filter: computes raw signals from message pairs.
 * Subject-agnostic: works for any topic, any subject.
 */

import { embed } from '../memory/embeddings';
import { logger } from '../middleware/logger';
import type { BoundarySignal, SegmentationConfig } from '../types/cognitive';

/**
 * Compute all boundary signals for a message pair.
 */
export async function computeBoundarySignals(
  studentId: string,
  currentMessage: string,
  previousMessage: string | null,
  emotionalSnapshot: Record<string, number>,
  timeGapMinutes: number,
  currentTopic: string | null,
  config: SegmentationConfig
): Promise<BoundarySignal> {
  const features = config.features;

  const signals: Partial<BoundarySignal> = {
    time_gap_minutes: timeGapMinutes,
  };

  // Topic drift via embedding similarity
  if (features.use_embedding_drift && previousMessage) {
    signals.embedding_cosine_distance = await computeEmbeddingDrift(previousMessage, currentMessage);
    signals.topic_drift_score = signals.embedding_cosine_distance;
  } else {
    signals.embedding_cosine_distance = 0;
    signals.topic_drift_score = 0;
  }

  // Emotional delta
  if (features.use_emotional_delta) {
    signals.emotional_delta = computeEmotionalDelta(emotionalSnapshot);
  } else {
    signals.emotional_delta = 0;
  }

  // Lexical shift detection
  if (features.use_lexical_shift) {
    signals.lexical_shift_detected = detectLexicalShift(previousMessage, currentMessage, currentTopic);
  } else {
    signals.lexical_shift_detected = false;
  }

  // Cognitive task shift (heuristic based on message patterns)
  if (features.use_cognitive_task_detection) {
    signals.cognitive_task_shift = detectCognitiveTaskShift(previousMessage, currentMessage);
  } else {
    signals.cognitive_task_shift = false;
  }

  // Pedagogical transition
  if (features.use_pedagogical_transition) {
    signals.pedagogical_transition = detectPedagogicalTransition(currentMessage);
  } else {
    signals.pedagogical_transition = 'none';
  }

  return signals as BoundarySignal;
}

/**
 * Compute embedding cosine distance between two messages.
 * Higher distance = more different = higher drift.
 */
async function computeEmbeddingDrift(msg1: string, msg2: string): Promise<number> {
  try {
    const [emb1, emb2] = await Promise.all([embed(msg1), embed(msg2)]);

    // Cosine similarity
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;
    for (let i = 0; i < emb1.vector.length; i++) {
      dotProduct += emb1.vector[i] * emb2.vector[i];
      norm1 += emb1.vector[i] * emb1.vector[i];
      norm2 += emb2.vector[i] * emb2.vector[i];
    }

    const similarity = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2) || 1);
    // Return distance (1 - similarity), scaled
    return Math.max(0, 1 - similarity) * 5; // Scale to 0-5 range
  } catch (err) {
    logger.debug({ err }, '[BoundarySignals] Embedding drift failed');
    return 0;
  }
}

/**
 * Compute emotional delta from snapshot.
 * Returns a signed value: negative = valence dropped, positive = valence rose.
 */
function computeEmotionalDelta(emotionalSnapshot: Record<string, number>): number {
  const valence = emotionalSnapshot.valence ?? 0.5;
  const frustration = emotionalSnapshot.frustration ?? 0;
  const selfEfficacy = emotionalSnapshot.selfEfficacy ?? 0.5;

  const delta = (valence - 0.5) * 2 - frustration + (selfEfficacy - 0.5);
  return delta;
}

/**
 * Detect if the student switched to a completely different lexical domain.
 */
function detectLexicalShift(
  previousMessage: string | null,
  currentMessage: string,
  currentTopic: string | null
): boolean {
  if (!previousMessage) return false;

  const prev = previousMessage.toLowerCase();
  const curr = currentMessage.toLowerCase();

  const domainIndicators: Record<string, string[]> = {
    math: ['calculate', 'solve', 'equation', 'formula', 'derivative', 'integral', 'algebra', 'geometry', 'statistics'],
    science: ['experiment', 'hypothesis', 'molecule', 'cell', 'organism', 'reaction', 'force', 'energy'],
    english: ['essay', 'grammar', 'poem', 'literature', 'comprehension', 'vocabulary', 'syntax'],
    social: ['history', 'government', 'economics', 'geography', 'civic', 'politics'],
    meta: ['help', 'explain', 'don\'t understand', 'confused', 'stuck', 'example', 'practice'],
  };

  let prevDomain: string | null = null;
  let currDomain: string | null = null;

  for (const [domain, keywords] of Object.entries(domainIndicators)) {
    if (keywords.some(k => prev.includes(k))) prevDomain = domain;
    if (keywords.some(k => curr.includes(k))) currDomain = domain;
  }

  if (prevDomain && currDomain && prevDomain !== currDomain) return true;

  if (currentTopic) {
    const topicWords = currentTopic.toLowerCase().split(/\s+/);
    const hasTopicOverlap = topicWords.some(w => curr.includes(w));
    if (!hasTopicOverlap && curr.length > 20) {
      const allKeywords = Object.values(domainIndicators).flat();
      const newDomainWords = allKeywords.filter(k => curr.includes(k) && !prev.includes(k));
      if (newDomainWords.length >= 2) return true;
    }
  }

  return false;
}

/**
 * Detect if the student's cognitive task has shifted.
 */
function detectCognitiveTaskShift(
  previousMessage: string | null,
  currentMessage: string
): boolean {
  if (!previousMessage) return false;

  const prev = previousMessage.toLowerCase();
  const curr = currentMessage.toLowerCase();

  const explaining = ['explain', 'how does', 'why is', 'what is', 'tell me about', 'teach me'];
  const solving = ['solve', 'calculate', 'find', 'what is the answer', 'compute', 'evaluate'];
  const assessing = ['quiz', 'test', 'question', 'exam', 'past question', 'practice'];
  const reflecting = ['review', 'summarize', 'what did we', 'recap', 'remember'];

  const prevTask = explaining.some(p => prev.includes(p)) ? 'explain'
    : solving.some(p => prev.includes(p)) ? 'solve'
    : assessing.some(p => prev.includes(p)) ? 'assess'
    : reflecting.some(p => prev.includes(p)) ? 'reflect'
    : 'unknown';

  const currTask = explaining.some(p => curr.includes(p)) ? 'explain'
    : solving.some(p => curr.includes(p)) ? 'solve'
    : assessing.some(p => curr.includes(p)) ? 'assess'
    : reflecting.some(p => curr.includes(p)) ? 'reflect'
    : 'unknown';

  if (prevTask === 'solve' && currTask === 'explain') return true;
  if (prevTask === 'assess' && currTask === 'explain') return true;
  if (prevTask === 'explain' && currTask === 'assess') return true;

  if (/got it|understood|i see|makes sense/.test(prev) && explaining.some(p => curr.includes(p))) return true;

  return false;
}

/**
 * Detect pedagogical transition in the current message.
 */
function detectPedagogicalTransition(currentMessage: string): string {
  const msg = currentMessage.toLowerCase();

  if (/quiz|test me|question|exam|past question/.test(msg)) return 'assessment';
  if (/explain|teach|how|why|what is/.test(msg)) return 'explanation';
  if (/review|recap|summarize|what did we/.test(msg)) return 'reflection';
  if (/practice|try|exercise|problem/.test(msg)) return 'practice';
  if (/brb|be right back|later|go|leave|stop|pause/.test(msg)) return 'external_interrupt';

  return 'none';
}