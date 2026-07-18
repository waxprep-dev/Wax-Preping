/**
 * WaxPrep v3.0 — Predictive Functions
 * AI-driven prediction of student needs, not hardcoded heuristics.
 */

import { getGraphAdapter } from '../graph/factory';
import { routeAndCall } from '../llm/router';
import { getCognitiveConfig } from '../config/cognitive';
import { logger } from '../middleware/logger';
import { db } from '../db/client';

/**
 * Predict the next topic a student will engage with.
 */
export async function predictNextTopic(studentId: string): Promise<string | null> {
  try {
    const graph = await getGraphAdapter();

    // Get recent concept history from graph
    const recentConcepts = await graph.searchNodes({
      labels: ['Concept'],
      student_id: studentId,
    }, 10);

    const conceptData = recentConcepts.map(c => ({
      name: c.properties.name as string,
      mastery: c.properties.mastery_estimate as number || 0.1,
      last_practiced: c.properties.last_practiced as string,
    }));

    // Get student goals
    const goalsResult = await db.query(
      `SELECT attribute_value FROM student_attributes
       WHERE student_id = $1 AND attribute_key IN ('subject_interest', 'intended_course', 'exam_type')
       AND is_active = true`,
      [studentId]
    );
    const goals = goalsResult.rows.map(r => r.attribute_value);

    // Get archetype
    const archetypeResult = await db.query(
      `SELECT a.name FROM student_archetypes a
       JOIN student_archetype_memberships m ON a.id = m.archetype_id
       WHERE m.student_id = $1
       ORDER BY m.similarity_score DESC
       LIMIT 1`,
      [studentId]
    );
    const archetype = archetypeResult.rows[0]?.name as string || 'unknown';

    const prompt = `
Based on this student's recent concept history and mastery levels:
${JSON.stringify(conceptData)}

Their stated goals: ${JSON.stringify(goals)}
Their archetype: ${archetype}

Predict what topic they are most likely to engage with next.
Return ONLY JSON: {"predicted_topic": "string", "predicted_subject": "string", "confidence": 0.0-1.0}
`;

    const response = await routeAndCall(
      [
        { role: 'system', content: 'You predict student learning trajectories. Respond with JSON only.' },
        { role: 'user', content: prompt },
      ],
      { tier: 'smart', jsonMode: true, maxTokens: 200, studentId, purpose: 'topic_prediction' }
    );

    const cleaned = response.content.replace(/```json|```/g, '').trim();
    const result = JSON.parse(cleaned);
    return result.predicted_topic || null;
  } catch (err) {
    logger.warn({ err, studentId }, '[Predictive] Topic prediction failed');
    return null;
  }
}

/**
 * Predict concepts where the student is likely struggling.
 */
export async function predictStrugglingConcepts(studentId: string): Promise<string[]> {
  try {
    const result = await db.query(
      `SELECT concept_name, mastery_estimate FROM concept_retention_curves
       WHERE student_id = $1
         AND mastery_estimate < 0.4
         AND (last_reviewed_at IS NULL OR last_reviewed_at < NOW() - INTERVAL '3 days')
       ORDER BY mastery_estimate ASC
       LIMIT 5`,
      [studentId]
    );

    return result.rows.map(r => r.concept_name as string);
  } catch (err) {
    logger.warn({ err, studentId }, '[Predictive] Struggle prediction failed');
    return [];
  }
}

/**
 * Predict frustration level for next session.
 */
export async function predictFrustration(studentId: string): Promise<number> {
  try {
    const graph = await getGraphAdapter();

    // Get recent state nodes
    const stateNodes = await graph.searchNodes({
      labels: ['State'],
      student_id: studentId,
    }, 20);

    const recentFrustration = stateNodes
      .filter(n => n.properties.frustration_level !== undefined)
      .sort((a, b) => b.event_time.getTime() - a.event_time.getTime())
      .slice(0, 5);

    if (recentFrustration.length === 0) return 0.3; // Default mild uncertainty

    const avgFrustration = recentFrustration.reduce((sum, n) => sum + ((n.properties.frustration_level as number) || 0), 0) / recentFrustration.length;

    // Trend: increasing or decreasing?
    const first = recentFrustration[0].properties.frustration_level as number || 0;
    const last = recentFrustration[recentFrustration.length - 1].properties.frustration_level as number || 0;
    const trend = first - last; // Positive = decreasing, Negative = increasing

    // If trend is increasing frustration, predict higher
    const prediction = avgFrustration + (trend < 0 ? 0.2 : 0);
    return Math.min(1, Math.max(0, prediction));
  } catch (err) {
    logger.warn({ err, studentId }, '[Predictive] Frustration prediction failed');
    return 0.3;
  }
}