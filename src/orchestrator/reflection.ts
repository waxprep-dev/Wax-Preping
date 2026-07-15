// The self-reflection engine.
// After every response, the AI critiques its own work.
// These reflections are stored and fed back into future orchestrations.
// The AI literally learns from its own mistakes over time.

import { routeAndCall } from '../llm/router';
import { db } from '../db/client';
import { logger } from '../middleware/logger';
import type { LLMMessage } from '../types/llm';

export interface ReflectionResult {
  critique: string;
  improvement: string;
  confidenceScore: number;
  wouldDoDifferently: string;
  pedagogicalRating: number;
  emotionalRating: number;
  culturalRating: number;
}

const REFLECTION_SYSTEM = `You are a master pedagogue reviewing an AI tutor's response to a Nigerian student.

Evaluate the response on these dimensions:
1. PEDAGOGICAL: Did it teach effectively? Did it check understanding? Did it avoid giving answers directly?
2. EMOTIONAL: Did it read the student's emotional state correctly? Did it handle shame/frustration well?
3. CULTURAL: Did it use appropriate Nigerian context and analogies?
4. CLARITY: Was it clear and appropriately concise?
5. AUTHENTIC: Did it sound like a real person, not a bot?

Identify: What worked? What didn't? What would have been better?

Respond in JSON:
{
  "critique": "What the tutor did wrong or suboptimally",
  "improvement": "Specific improvement for next time",
  "confidenceScore": 0.0-1.0,
  "wouldDoDifferently": "What a master teacher would have done instead",
  "pedagogicalRating": 0.0-1.0,
  "emotionalRating": 0.0-1.0,
  "culturalRating": 0.0-1.0
}`;

export async function runReflection(
  studentId: string,
  sessionId: string,
  turnNumber: number,
  studentMessage: string,
  tutorResponse: string,
  analysis: Record<string, unknown>
): Promise<ReflectionResult | null> {
  try {
    const messages: LLMMessage[] = [
      { role: 'system', content: REFLECTION_SYSTEM },
      {
        role: 'user',
        content: `Student message: "${studentMessage}"

Tutor response: "${tutorResponse}"

AI's own analysis of the situation:
- Emotional state detected: ${JSON.stringify(analysis.emotionalReading || {})}
- Intent detected: ${analysis.primaryIntent || 'unknown'}
- Strategy chosen: ${analysis.pedagogicalStrategy || 'unknown'}
- Misconception detected: ${analysis.hasMisconception ? analysis.misconceptionDescription : 'none'}

Evaluate this response.`,
      },
    ];

    const response = await routeAndCall(messages, { jsonMode: true, maxTokens: 600 });
    const reflection = JSON.parse(response.content) as ReflectionResult;

    // Store reflection for future use
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
    );

    return reflection;
  } catch (err) {
    logger.warn('[Reflection] Reflection failed:', err);
    return null;
  }
}

export async function getRecentReflections(
  studentId: string,
  limit = 5
): Promise<ReflectionResult[]> {
  const result = await db.query(
    `SELECT critique, improvement, confidence_score, would_do_differently
     FROM ai_reflections
     WHERE student_id = $1
     ORDER BY timestamp DESC
     LIMIT $2`,
    [studentId, limit]
  );

  return result.rows.map((r: Record<string, unknown>) => ({
    critique: r.critique as string,
    improvement: r.improvement as string,
    confidenceScore: r.confidence_score as number,
    wouldDoDifferently: r.would_do_differently as string,
    pedagogicalRating: 0.7,
    emotionalRating: 0.7,
    culturalRating: 0.7,
  }));
}

export async function getReflectionSummary(studentId: string): Promise<string> {
  const reflections = await getRecentReflections(studentId, 5);
  if (reflections.length === 0) return '';

  const improvements = reflections
    .map(r => r.improvement)
    .filter(Boolean)
    .slice(0, 3);

  return improvements.length > 0
    ? `LESSONS FROM RECENT SESSIONS:\n${improvements.map((imp, i) => `${i + 1}. ${imp}`).join('\n')}`
    : '';
}