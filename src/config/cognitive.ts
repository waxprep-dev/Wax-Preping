/**
 * WaxPrep v3.0 — Cognitive Configuration Manager
 * All cognitive parameters are database-driven, not hardcoded.
 * This is the single source of truth for runtime cognitive tuning.
 */

import { db } from '../db/client';
import { logger } from '../middleware/logger';
import type { CognitiveSystemConfig, CognitiveConfigMap, SegmentationConfig, ForgettingParams } from '../types/cognitive';

const CACHE_TTL_MS = 30_000;
const configCache: Map<string, { value: Record<string, unknown>; expiresAt: number }> = new Map();

export async function getCognitiveConfig<K extends keyof CognitiveConfigMap>(
  key: K
): Promise<CognitiveConfigMap[K]> {
  const cached = configCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value as CognitiveConfigMap[K];
  }

  try {
    const result = await db.query(
      `SELECT value FROM cognitive_system_config WHERE key = $1 LIMIT 1`,
      [key]
    );

    if (result.rows.length === 0) {
      logger.warn(`[CognitiveConfig] Missing config for key: ${key}, using empty default`);
      return {} as CognitiveConfigMap[K];
    }

    const value = result.rows[0].value as Record<string, unknown>;
    configCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value as CognitiveConfigMap[K];
  } catch (err) {
    logger.warn({ err }, `[CognitiveConfig] Failed to load ${key}`);
    return {} as CognitiveConfigMap[K];
  }
}

export async function setCognitiveConfig<K extends keyof CognitiveConfigMap>(
  key: K,
  value: Partial<CognitiveConfigMap[K]>
): Promise<void> {
  const existing = await getCognitiveConfig(key).catch(() => ({} as CognitiveConfigMap[K]));
  const merged = { ...existing, ...value };

  await db.query(
    `INSERT INTO cognitive_system_config (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(merged)]
  );

  configCache.set(key, { value: merged, expiresAt: Date.now() + CACHE_TTL_MS });
  logger.info(`[CognitiveConfig] Updated ${key}`);
}

export async function getSegmentationConfig(studentId?: string): Promise<SegmentationConfig> {
  try {
    const query = studentId
      ? `SELECT * FROM segmentation_config WHERE student_id = $1 LIMIT 1`
      : `SELECT * FROM segmentation_config WHERE student_id IS NULL LIMIT 1`;
    const params = studentId ? [studentId] : [];
    const result = await db.query(query, params);

    if (result.rows.length > 0) {
      const row = result.rows[0];
      return {
        id: row.id,
        student_id: row.student_id,
        weights: row.weights,
        thresholds: row.thresholds,
        features: row.features,
        model_config: row.model_config,
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at),
      };
    }

    // Fall back to global default
    if (studentId) {
      return getSegmentationConfig(undefined);
    }

    // Ultimate fallback — should never happen if migration ran
    return {
      id: 'default',
      student_id: null,
      weights: { topic_drift: 0.35, emotional: 0.25, cognitive: 0.25, time: 0.10, pedagogical: 0.05 },
      thresholds: { boundary: 0.6, time_gap: 30, system1_trigger: 0.3 },
      features: {
        use_embedding_drift: true,
        use_emotional_delta: true,
        use_lexical_shift: true,
        use_cognitive_task_detection: true,
        use_pedagogical_transition: true,
      },
      model_config: { system1_model_tier: 'fast', system2_model_tier: 'smart' },
      created_at: new Date(),
      updated_at: new Date(),
    };
  } catch (err) {
    logger.warn({ err }, '[CognitiveConfig] Failed to load segmentation config');
    return getSegmentationConfig(undefined);
  }
}

export async function updateSegmentationWeights(
  studentId: string | null,
  weights: Partial<SegmentationConfig['weights']>
): Promise<void> {
  const existing = await getSegmentationConfig(studentId || undefined);
  const merged = { ...existing.weights, ...weights };

  await db.query(
    `INSERT INTO segmentation_config (student_id, weights, thresholds, features, model_config)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (student_id) DO UPDATE SET
       weights = EXCLUDED.weights,
       updated_at = NOW()`,
    [
      studentId,
      JSON.stringify(merged),
      JSON.stringify(existing.thresholds),
      JSON.stringify(existing.features),
      JSON.stringify(existing.model_config),
    ]
  );
}

export async function getForgettingParams(studentId: string): Promise<ForgettingParams> {
  try {
    const result = await db.query(
      `SELECT * FROM forgetting_params WHERE student_id = $1 LIMIT 1`,
      [studentId]
    );

    if (result.rows.length > 0) {
      const row = result.rows[0];
      return {
        id: row.id,
        student_id: row.student_id,
        decay_rate: row.decay_rate,
        decay_temperature: row.decay_temperature,
        retrieval_threshold: row.retrieval_threshold,
        emotional_salience_weight: row.emotional_salience_weight,
        contextual_boost_weight: row.contextual_boost_weight,
        noise_stddev: row.noise_stddev,
        oblivion_threshold: row.oblivion_threshold,
        uncertainty_threshold: row.uncertainty_threshold,
        top_k_retrieval: row.top_k_retrieval,
        updated_at: new Date(row.updated_at),
      };
    }

    // Create default params for this student
    const global = await getCognitiveConfig('forgetting');
    const defaults = await db.query(
      `INSERT INTO forgetting_params (
        student_id, decay_rate, decay_temperature, retrieval_threshold,
        emotional_salience_weight, contextual_boost_weight, noise_stddev,
        oblivion_threshold, uncertainty_threshold, top_k_retrieval
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        studentId,
        global.default_decay_rate ?? 0.5,
        global.default_decay_temperature ?? 1.0,
        global.default_retrieval_threshold ?? 0.3,
        1.5, 2.0, 0.3, 0.1, 0.4, 5,
      ]
    );

    const row = defaults.rows[0];
    return {
      id: row.id,
      student_id: row.student_id,
      decay_rate: row.decay_rate,
      decay_temperature: row.decay_temperature,
      retrieval_threshold: row.retrieval_threshold,
      emotional_salience_weight: row.emotional_salience_weight,
      contextual_boost_weight: row.contextual_boost_weight,
      noise_stddev: row.noise_stddev,
      oblivion_threshold: row.oblivion_threshold,
      uncertainty_threshold: row.uncertainty_threshold,
      top_k_retrieval: row.top_k_retrieval,
      updated_at: new Date(row.updated_at),
    };
  } catch (err) {
    logger.warn({ err }, `[CognitiveConfig] Failed to load forgetting params for ${studentId}`);
    // Return hard fallback
    return {
      id: 'fallback',
      student_id: studentId,
      decay_rate: 0.5,
      decay_temperature: 1.0,
      retrieval_threshold: 0.3,
      emotional_salience_weight: 1.5,
      contextual_boost_weight: 2.0,
      noise_stddev: 0.3,
      oblivion_threshold: 0.1,
      uncertainty_threshold: 0.4,
      top_k_retrieval: 5,
      updated_at: new Date(),
    };
  }
}

export async function updateForgettingParams(
  studentId: string,
  updates: Partial<Omit<ForgettingParams, 'id' | 'student_id' | 'updated_at'>>
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = $${idx}`);
      values.push(value);
      idx++;
    }
  }

  if (fields.length === 0) return;

  values.push(studentId);
  await db.query(
    `UPDATE forgetting_params SET ${fields.join(', ')}, updated_at = NOW() WHERE student_id = $${idx}`,
    values
  );
}

export function invalidateConfigCache(): void {
  configCache.clear();
  logger.info('[CognitiveConfig] Cache invalidated');
}