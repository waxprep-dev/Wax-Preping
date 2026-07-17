/**
 * Self-reflection: the tutor critiques its own turn (async, off the response
 * path). Lessons feed back into future deliberation context — the
 * Reflexion pattern, applied to tutoring.
 *
 * v1 preserved; v2 publishes the reflection.stored event it declared but
 * never emitted, and the prompt is DB-evolvable.
 */
import { v4 as uuidv4 } from 'uuid';
import { routeAndCall } from '../llm/router';
import { getPrompt } from '../config/prompts';
import { db } from '../db/client';
import { eventBus } from '../events/bus';
import { logger } from '../middleware/logger';
import type { ReflectionStored } from '../types/events';

export interface ReflectionResult {
  critique: string;
  improvement: string;
  confidenceScore: number;
  wouldDoDifferently: string;
  pedagogicalRating: number;
  emotionalRating: number;
  culturalRating: number;
}

export async function runReflection(
  studentId: string,
  sessionId: string,
  turnNumber: number,
  studentMessage: string,
  tutorResponse: string,
  analysis: Record<string, unknown>
): Promise<ReflectionResult | null> {
  try {
    const instruction = await getPrompt('reflection.v1');
    const response = await routeAndCall([
      { role: 'system', content: instruction },
      {
        role: 'user',
        content: `Student message: "${studentMessage.slice(0, 400)}"
Tutor response: "${tutorResponse.slice(0, 400)}"
Pipeline analysis: ${JSON.stringify(analysis).slice(0, 250)}

Evaluate this response.`,
      },
    ], { tier: 'deep', jsonMode: true, maxTokens: 450, temperature: 0.3, studentId, purpose: 'reflection' });

    const reflection = JSON.parse(response.content.replace(/```json|```/g, '').trim()) as ReflectionResult;

    await db.query(
      `INSERT INTO ai_reflections
       (student_id, session_id, turn_number, student_message, tutor_response, critique, improvement, confidence_score, would_do_differently)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        studentId, sessionId, turnNumber,
        studentMessage.slice(0, 500), tutorResponse.slice(0, 500),
        reflection.critique, reflection.improvement,
        reflection.confidenceScore, reflection.wouldDoDifferently,
      ]
    ).catch(() => {});

    const event: ReflectionStored = {
      id: uuidv4(),
      type: 'reflection.stored',
      studentId,
      sessionId,
      timestamp: new Date(),
      critique: reflection.critique || '',
      confidenceScore: reflection.confidenceScore || 0,
      improvement: reflection.improvement || '',
    };
    await eventBus.publish(event).catch(() => {});

    return reflection;
  } catch (err) {
    logger.debug({ err }, '[Reflection] Failed');
    return null;
  }
}

export async function getReflectionSummary(studentId: string): Promise<string> {
  const result = await db.query(
    `SELECT improvement FROM ai_reflections WHERE student_id = $1 ORDER BY timestamp DESC LIMIT 5`,
    [studentId]
  ).catch(() => ({ rows: [] }));

  const improvements = result.rows.map((r: Record<string, unknown>) => r.improvement as string).filter(Boolean);
  return improvements.length > 0
    ? `LESSONS FROM YOUR RECENT SELF-REVIEWS (apply them now):\n${improvements.slice(0, 3).map((imp, i) => `${i + 1}. ${imp}`).join('\n')}`
    : '';
}
