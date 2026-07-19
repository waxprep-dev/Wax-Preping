/**
 * WaxPrep v3.0 — Dual-Process Session Segmentation Engine
 * Replaces the hardcoded 30-minute timeout with an intelligent,
 * AI-driven boundary detector based on Kahneman's dual-process theory.
 */

import { routeAndCall } from '../llm/router';
import { getSegmentationConfig } from '../config/cognitive';
import { logger } from '../middleware/logger';
import { db } from '../db/client';
import type { BoundaryDecision, BoundarySignal, SegmentationConfig, SessionBoundaryRecord } from '../types/cognitive';
import { computeBoundarySignals } from './boundary_signals';

/**
 * Main entry point: evaluate whether the current message creates a session boundary.
 */
export async function evaluateSessionBoundary(
  studentId: string,
  currentMessage: string,
  previousMessage: string | null,
  currentTopic: string | null,
  emotionalSnapshot: Record<string, number>,
  recentContext: string,
  timeGapMinutes: number,
  previousSessionId?: string
): Promise<BoundaryDecision> {
  const config = await getSegmentationConfig(studentId);

  // ===========================================================================
  // STAGE 1: System 1 — Fast Filter
  // ===========================================================================
  const signals = await computeBoundarySignals(
    studentId,
    currentMessage,
    previousMessage,
    emotionalSnapshot,
    timeGapMinutes,
    currentTopic,
    config
  );

  const system1Probability = computeWeightedProbability(signals, config.weights);

  logger.debug(
    { studentId, system1Probability, signals },
    '[Segmentation] System 1 evaluation'
  );

  // If System 1 is very confident there's NO boundary, skip System 2
  if (system1Probability < config.thresholds.system1_trigger) {
    return {
      is_boundary: false,
      boundary_type: 'none',
      boundary_probability: system1Probability,
      signals,
      previous_session_id: previousSessionId,
      continuity_score: 1 - system1Probability,
    };
  }

  // ===========================================================================
  // STAGE 2: System 2 — Deep Reasoning
  // ===========================================================================
  const system2Decision = await runSystem2Deliberation(
    currentMessage,
    previousMessage,
    emotionalSnapshot,
    recentContext,
    timeGapMinutes,
    currentTopic,
    system1Probability,
    config
  );

  const finalProbability = (system1Probability + (system2Decision.is_boundary ? 1 : 0)) / 2;

  const decision: BoundaryDecision = {
    is_boundary: finalProbability > config.thresholds.boundary,
    boundary_type: system2Decision.boundary_type,
    boundary_probability: finalProbability,
    signals,
    llm_reasoning: system2Decision.reasoning,
    previous_session_id: previousSessionId,
    continuity_score: system2Decision.continuity_score,
  };

  // Log the boundary decision for learning
  await logBoundaryDecision(studentId, decision, previousSessionId);

  return decision;
}

/**
 * Compute weighted ensemble probability from signals.
 */
function computeWeightedProbability(
  signals: BoundarySignal,
  weights: SegmentationConfig['weights']
): number {
  function sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
  }

  const topicComponent = weights.topic_drift * sigmoid(signals.topic_drift_score);
  const emotionalComponent = weights.emotional * sigmoid(signals.emotional_delta);
  const cognitiveComponent = weights.cognitive * (signals.cognitive_task_shift ? 1 : 0);
  const timeComponent = weights.time * (signals.time_gap_minutes > 120 ? 1 : sigmoid(signals.time_gap_minutes / 30 - 1));
  const pedagogicalComponent = weights.pedagogical * (signals.pedagogical_transition !== 'none' ? 1 : 0);
  const lexicalComponent = 0.15 * (signals.lexical_shift_detected ? 1 : 0);

  return Math.min(1, topicComponent + emotionalComponent + cognitiveComponent + timeComponent + pedagogicalComponent + lexicalComponent);
}

/**
 * Run System 2 LLM deliberation for boundary classification.
 */
async function runSystem2Deliberation(
  currentMessage: string,
  previousMessage: string | null,
  emotionalSnapshot: Record<string, number>,
  recentContext: string,
  timeGapMinutes: number,
  currentTopic: string | null,
  system1Probability: number,
  config: SegmentationConfig
): Promise<{
  is_boundary: boolean;
  boundary_type: string;
  reasoning: string;
  continuity_score: number;
  cognitive_task_changed: boolean;
  emotional_transition_significant: boolean;
}> {
  const prompt = `
You are the System 2 deliberation layer of Wax, an AI tutor for Nigerian secondary-school students.
Your job: determine whether a SESSION BOUNDARY has occurred.

A session boundary means the student's COGNITIVE TASK has fundamentally shifted.

INPUT:
- Previous message: ${previousMessage || '[none — first message]'}
- Current message: ${currentMessage}
- Time gap: ${timeGapMinutes} minutes
- Current topic: ${currentTopic || 'unknown'}
- Emotional state: ${JSON.stringify(emotionalSnapshot)}
- System 1 boundary probability: ${system1Probability.toFixed(3)}
- Recent context (last 3 turns): ${recentContext}

BOUNDARY TYPES (examples, not constraints — generate your own if needed):
- TOPIC_SHIFT: New subject domain
- EMOTIONAL_RESET: Major emotional transition
- COGNITIVE_BREAK: Solved → explain, or explain → assess
- PEDAGOGICAL_TRANSITION: Teaching → Assessment → Reflection
- EXTERNAL_INTERRUPT: "brb", "I have to go"
- NO_BOUNDARY: Continuation of same thread

OUTPUT FORMAT (JSON only):
{
  "is_boundary": true|false,
  "boundary_type": "string",
  "reasoning": "one sentence",
  "continuity_score": 0.0-1.0,
  "cognitive_task_changed": true|false,
  "emotional_transition_significant": true|false
}

Rules:
- Be conservative. Prefer NO_BOUNDARY unless the shift is clear.
- A follow-up question is NEVER a boundary.
- Frustration about the SAME topic is NOT a boundary.
- "let's do something else" IS a boundary.
- Time gap alone does NOT create a boundary unless > 120 min AND topic shifted.
`;

  try {
    const response = await routeAndCall(
      [
        { role: 'system', content: 'You are a precise session boundary classifier. Respond with JSON only.' },
        { role: 'user', content: prompt },
      ],
      {
        tier: config.model_config.system2_model_tier,
        jsonMode: true,
        maxTokens: 400,
        studentId: 'segmentation_system',
        purpose: 'session_boundary',
      }
    );

    const cleaned = response.content.replace(/```json|```/g, '').trim();
    const result = JSON.parse(cleaned);

    return {
      is_boundary: result.is_boundary === true,
      boundary_type: result.boundary_type || 'unknown',
      reasoning: result.reasoning || 'No reasoning provided',
      continuity_score: Math.max(0, Math.min(1, result.continuity_score || 0.5)),
      cognitive_task_changed: result.cognitive_task_changed === true,
      emotional_transition_significant: result.emotional_transition_significant === true,
    };
  } catch (err) {
    logger.warn({ err }, '[Segmentation] System 2 failed, falling back to System 1');
    return {
      is_boundary: system1Probability > 0.6,
      boundary_type: system1Probability > 0.6 ? 'system1_fallback' : 'none',
      reasoning: 'System 2 failed — using System 1 probability',
      continuity_score: 1 - system1Probability,
      cognitive_task_changed: false,
      emotional_transition_significant: false,
    };
  }
}

/**
 * Log boundary decision for future weight optimization.
 */
async function logBoundaryDecision(
  studentId: string,
  decision: BoundaryDecision,
  previousSessionId?: string
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO session_boundaries (
        student_id, previous_session_id, new_session_id, boundary_type,
        boundary_probability, boundary_signals, llm_reasoning, detected_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        studentId,
        previousSessionId || null,
        previousSessionId || 'pending',
        decision.boundary_type,
        decision.boundary_probability,
        JSON.stringify(decision.signals),
        decision.llm_reasoning || null,
      ]
    );
  } catch (err) {
    logger.debug({ err }, '[Segmentation] Failed to log boundary');
  }
}

/**
 * Update boundary record with the actual new session ID after creation.
 */
export async function linkBoundaryToNewSession(
  boundaryId: string,
  newSessionId: string
): Promise<void> {
  await db.query(
    `UPDATE session_boundaries SET new_session_id = $1 WHERE id = $2`,
    [newSessionId, boundaryId]
  );
}

/**
 * Get recent boundary decisions for a student (for UI/debugging).
 */
export async function getRecentBoundaries(
  studentId: string,
  limit = 10
): Promise<SessionBoundaryRecord[]> {
  const result = await db.query(
    `SELECT * FROM session_boundaries 
     WHERE student_id = $1 
     ORDER BY detected_at DESC 
     LIMIT $2`,
    [studentId, limit]
  );

  return result.rows.map(row => ({
    id: row.id,
    student_id: row.student_id,
    previous_session_id: row.previous_session_id,
    new_session_id: row.new_session_id,
    boundary_type: row.boundary_type,
    boundary_probability: row.boundary_probability,
    boundary_signals: row.boundary_signals,
    llm_reasoning: row.llm_reasoning,
    was_correct: row.was_correct,
    detected_at: new Date(row.detected_at),
  }));
}

/**
 * Provide human feedback on a boundary decision to improve weights.
 */
export async function provideBoundaryFeedback(
  boundaryId: string,
  wasCorrect: boolean
): Promise<void> {
  await db.query(
    `UPDATE session_boundaries SET was_correct = $1 WHERE id = $2`,
    [wasCorrect, boundaryId]
  );

  logger.info(`[Segmentation] Feedback recorded for boundary ${boundaryId}: ${wasCorrect}`);
}