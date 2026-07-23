/**
 * WaxPrep v3.0 — Predictive Memory Pre-Load Engine
 * Warms up working memory before the student sends a message.
 * Runs on a schedule and before predicted session starts.
 */

import { getRedis } from '../db/redis';
import { getCognitiveConfig } from '../config/cognitive';
import { getForgettingParams } from '../config/cognitive';
import { logger } from '../middleware/logger';
import { db } from '../db/client';
import type { PreloadContext, PredictivePreload, ForgettingParams } from '../types/cognitive';
import { predictNextTopic, predictFrustration, predictStrugglingConcepts } from './predictors';
import { getArchetypePromptModifier } from '../student_profile/archetypes';

/**
 * Main predictive pre-load function.
 */
export async function predictivePreLoad(studentId: string): Promise<PreloadContext | null> {
  const config = await getCognitiveConfig('prediction');
  if (!config.enabled) return null;

  const now = new Date();

  try {
    // 1. Forgetting curve predictions
    const dueForReview = await getConceptsDueForReview(studentId);

    // 2. BKT mastery predictions
    const likelyStruggling = await predictStrugglingConcepts(studentId);

    // 3. Session context prediction
    const predictedTopic = await predictNextTopic(studentId);

    // 4. Emotional state prediction
    const predictedFrustration = await predictFrustration(studentId);

    // 5. Pre-compute pedagogical assets
    const preComputedHints: Record<string, string> = {};
    const preComputedAnalogies: Record<string, string> = {};

    if (predictedTopic) {
      preComputedHints[predictedTopic] = await preComputeHint(predictedTopic, studentId);
      preComputedAnalogies[predictedTopic] = await preComputeAnalogy(predictedTopic, studentId);
    }

    // 6. Archetype modifier
    const archetypeModifier = await getArchetypePromptModifier(studentId) || null;

    const context: PreloadContext = {
      student_id: studentId,
      computed_at: now,
      review_queue: dueForReview.slice(0, 3),
      predicted_struggle: likelyStruggling.slice(0, 2),
      predicted_topic: predictedTopic,
      emotional_prep: predictedFrustration > 0.6 ? 'frustration_mitigation' : predictedFrustration < 0.2 ? 'celebration_ready' : 'normal',
      pre_computed_hints: preComputedHints,
      pre_computed_analogies: preComputedAnalogies,
      archetype_prompt_modifier: archetypeModifier,
      recommended_strategies: await predictRecommendedStrategies(studentId, predictedTopic),
    };

    // Store in cache
    await cachePreload(studentId, context, config.preload_ttl_seconds || 21600);

    // Also store in PostgreSQL for persistence
    await persistPreload(studentId, context);

    logger.info({ studentId, predictedTopic }, '[Predictive] Pre-load complete');
    return context;
  } catch (err) {
    logger.error({ err, studentId }, '[Predictive] Pre-load failed');
    return null;
  }
}

/**
 * Check cache for pre-loaded context on message receipt.
 */
export async function checkPreloadCache(studentId: string): Promise<PreloadContext | null> {
  const redis = await getRedis();
  if (!redis) {
    // Fallback to PostgreSQL
    return getPersistedPreload(studentId);
  }

  try {
    const cached = await redis.get(`preload:${studentId}`);
    if (cached) {
      const context = JSON.parse(cached) as PreloadContext;
      // Update hit count
      await redis.incr(`preload_hits:${studentId}`);
      return context;
    }
  } catch (err) {
    logger.debug({ err }, '[Predictive] Cache read failed');
  }

  // Miss — update miss count and fall back to DB
  if (redis) {
    await redis.incr(`preload_misses:${studentId}`);
  }
  return getPersistedPreload(studentId);
}

/**
 * Cache pre-load context in Redis.
 */
async function cachePreload(studentId: string, context: PreloadContext, ttlSeconds: number): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;

  try {
    await redis.setEx(`preload:${studentId}`, ttlSeconds, JSON.stringify(context));
  } catch (err) {
    logger.debug({ err }, '[Predictive] Cache write failed');
  }
}

/**
 * Persist pre-load context in PostgreSQL.
 */
async function persistPreload(studentId: string, context: PreloadContext): Promise<void> {
  const expiresAt = new Date();
  expiresAt.setSeconds(expiresAt.getSeconds() + 21600);

  await db.query(
    `INSERT INTO predictive_preloads (student_id, context, computed_at, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (student_id) DO UPDATE SET
       context = EXCLUDED.context,
       computed_at = EXCLUDED.computed_at,
       expires_at = EXCLUDED.expires_at,
       hit_count = predictive_preloads.hit_count + 1`,
    [studentId, JSON.stringify(context), context.computed_at, expiresAt]
  );
}

/**
 * Get persisted pre-load from PostgreSQL.
 */
async function getPersistedPreload(studentId: string): Promise<PreloadContext | null> {
  const result = await db.query(
    `SELECT context FROM predictive_preloads 
     WHERE student_id = $1 AND expires_at > NOW()
     LIMIT 1`,
    [studentId]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  await db.query(
    `UPDATE predictive_preloads SET miss_count = miss_count + 1 WHERE student_id = $1`,
    [studentId]
  );

  return row.context as PreloadContext;
}

/**
 * Get concepts due for review based on retention curves.
 */
async function getConceptsDueForReview(studentId: string): Promise<string[]> {
  const result = await db.query(
    `SELECT concept_name FROM concept_retention_curves
     WHERE student_id = $1
       AND (next_predicted_review IS NULL OR next_predicted_review <= NOW())
     ORDER BY retention_estimate ASC
     LIMIT 10`,
    [studentId]
  );

  return result.rows.map(r => r.concept_name as string);
}

/**
 * Pre-compute a hint for a predicted topic.
 */
async function preComputeHint(topic: string, studentId: string): Promise<string> {
  return `Consider breaking ${topic} into smaller steps. What do you know about the fundamentals?`;
}

/**
 * Pre-compute an analogy for a predicted topic.
 */
async function preComputeAnalogy(topic: string, studentId: string): Promise<string> {
  return `Think of ${topic} like something familiar in your daily life.`;
}

/**
 * Predict recommended strategies for upcoming session.
 */
async function predictRecommendedStrategies(studentId: string, predictedTopic: string | null): Promise<string[]> {
  const strategies: string[] = [];

  if (!predictedTopic) return ['direct_explanation'];

  // Check if student has struggled with this topic before
  const struggleHistory = await db.query(
    `SELECT COUNT(*) as count FROM memory_access_logs
     WHERE student_id = $1 AND query ILIKE $2 AND was_retrieved = true`,
    [studentId, `%${predictedTopic}%`]
  );

  const hasStruggled = (struggleHistory.rows[0]?.count as number || 0) > 2;

  if (hasStruggled) {
    strategies.push('scaffolded_steps');
    strategies.push('prerequisite_first');
  } else {
    strategies.push('socratic');
  }

  // Check archetype
  const archetypeResult = await db.query(
    `SELECT a.name FROM student_archetypes a
     JOIN student_archetype_memberships m ON a.id = m.archetype_id
     WHERE m.student_id = $1
     ORDER BY m.similarity_score DESC
     LIMIT 1`,
    [studentId]
  );

  const archetype = archetypeResult.rows[0]?.name as string;
  if (archetype === 'panic_crammer') strategies.push('retrieval_practice');
  if (archetype === 'deep_diver') strategies.push('elaborative_interrogation');
  if (archetype === 'confidence_seeker') strategies.push('celebration');

  return strategies.length > 0 ? strategies : ['direct_explanation'];
}