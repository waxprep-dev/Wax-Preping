/**
 * PostgreSQL client + schema v2.
 *
 * Schema changes vs v1 (all additive and migration-safe — CREATE IF NOT EXISTS
 * and ALTER ... IF NOT EXISTS only):
 * - sessions gains a `state` JSONB column (persistent per-session teaching
 *   state: current concept, hint level, approaches tried, struggle count).
 * - conversation_turns gains `embedding_provider` so vector recall never mixes
 *   real model embeddings with the deterministic fallback in one search space.
 * - student_facts: NEW table — structured extracted facts about the learner.
 * - notification_queue gains `dedupe_key` with a UNIQUE index. v1 had
 *   ON CONFLICT DO NOTHING with no constraint, so the brain agent queued
 *   duplicate WhatsApp messages every 60 seconds. This was the spam bug.
 * - cost_tracking gains `purpose` (which part of the pipeline spent it).
 */
import { Pool } from 'pg';
import { logger } from '../middleware/logger';

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export async function initializeDatabase(): Promise<void> {
  await db.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  await db.query(`CREATE EXTENSION IF NOT EXISTS vector`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS system_config (
      key TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      last_activity_at TIMESTAMPTZ DEFAULT NOW(),
      turn_count INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      state JSONB DEFAULT '{}'::JSONB
    )
  `);
  await db.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS state JSONB DEFAULT '{}'::JSONB`);
  await db.query(`CREATE INDEX IF NOT EXISTS sessions_student_idx ON sessions(student_id)`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS conversation_turns (
      turn_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      turn_number INT NOT NULL,
      student_message TEXT,
      tutor_response TEXT,
      ai_analysis JSONB DEFAULT '{}',
      modality TEXT DEFAULT 'text',
      model_used TEXT,
      latency_ms INT,
      tokens_in INT DEFAULT 0,
      tokens_out INT DEFAULT 0,
      cost_usd FLOAT DEFAULT 0,
      tools_used TEXT[] DEFAULT '{}',
      embedding VECTOR(384),
      embedding_provider TEXT,
      topic TEXT,
      subject TEXT,
      mastery_evidenced BOOLEAN DEFAULT FALSE,
      reflection_score FLOAT,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`ALTER TABLE conversation_turns ADD COLUMN IF NOT EXISTS embedding_provider TEXT`);
  await db.query(`CREATE INDEX IF NOT EXISTS turns_student_idx ON conversation_turns(student_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS turns_session_idx ON conversation_turns(session_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS turns_timestamp_idx ON conversation_turns(timestamp DESC)`);

  try {
    await db.query(`
      CREATE INDEX IF NOT EXISTS turns_embedding_idx
      ON conversation_turns USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100)
    `);
  } catch { /* ivfflat needs rows first — recreated by the compressor worker later */ }

  await db.query(`
    CREATE TABLE IF NOT EXISTS student_profiles (
      student_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      total_sessions INT DEFAULT 0,
      total_turns INT DEFAULT 0,
      study_streak INT DEFAULT 0,
      last_study_date DATE,
      memory_blocks JSONB DEFAULT '{}',
      concept_progress JSONB DEFAULT '{}',
      error_diary JSONB DEFAULT '[]',
      analogy_library JSONB DEFAULT '[]',
      exam_targets JSONB DEFAULT '[]',
      cultural_context JSONB DEFAULT '{}',
      study_plan JSONB,
      symbolic_knowledge JSONB DEFAULT '{}'
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS student_facts (
      student_id TEXT NOT NULL,
      fact_key TEXT NOT NULL,
      fact_value TEXT NOT NULL,
      confidence FLOAT DEFAULT 0.7,
      source TEXT DEFAULT 'conversation',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (student_id, fact_key)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS notification_queue (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      scheduled_at TIMESTAMPTZ DEFAULT NOW(),
      sent BOOLEAN DEFAULT FALSE,
      sent_at TIMESTAMPTZ,
      priority INT DEFAULT 5,
      context JSONB DEFAULT '{}',
      dedupe_key TEXT
    )
  `);
  await db.query(`ALTER TABLE notification_queue ADD COLUMN IF NOT EXISTS dedupe_key TEXT`);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS notif_dedupe_idx
    ON notification_queue(dedupe_key) WHERE dedupe_key IS NOT NULL
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS notif_unsent_idx ON notification_queue(sent, scheduled_at) WHERE sent = FALSE`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS world_model_state (
      student_id TEXT PRIMARY KEY,
      predicted_next_mistake TEXT,
      predicted_forget_concepts TEXT[] DEFAULT '{}',
      predicted_frustration_probability FLOAT DEFAULT 0,
      predicted_flow_probability FLOAT DEFAULT 0,
      predicted_exam_score FLOAT DEFAULT 0,
      predicted_exam_score_trend TEXT DEFAULT 'stable',
      model_updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS spaced_reviews (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      concept TEXT NOT NULL,
      subject TEXT,
      next_review_at TIMESTAMPTZ NOT NULL,
      interval_days INT DEFAULT 1,
      review_count INT DEFAULT 0,
      mastery_level FLOAT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (student_id, concept)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS spaced_student_idx ON spaced_reviews(student_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS spaced_date_idx ON spaced_reviews(next_review_at)`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id TEXT PRIMARY KEY,
      processed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS cost_tracking (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      model TEXT NOT NULL,
      tokens_in INT NOT NULL,
      tokens_out INT NOT NULL,
      cost_usd FLOAT NOT NULL,
      purpose TEXT,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`ALTER TABLE cost_tracking ADD COLUMN IF NOT EXISTS purpose TEXT`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS defense_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      layer TEXT NOT NULL,
      severity TEXT NOT NULL,
      issue TEXT,
      original_response TEXT,
      revised_response TEXT,
      was_fixed BOOLEAN DEFAULT FALSE,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_reflections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_number INT NOT NULL,
      student_message TEXT,
      tutor_response TEXT,
      critique TEXT,
      improvement TEXT,
      confidence_score FLOAT,
      would_do_differently TEXT,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS prompt_components (
      component_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      weight FLOAT DEFAULT 1.0,
      priority INT DEFAULT 50,
      version INT DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS prompt_performance (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      component_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_number INT NOT NULL,
      student_engagement FLOAT DEFAULT 0,
      mastery_signal BOOLEAN DEFAULT FALSE,
      shame_spike BOOLEAN DEFAULT FALSE,
      frustration_spike BOOLEAN DEFAULT FALSE,
      flow_maintained BOOLEAN DEFAULT FALSE,
      answer_leak BOOLEAN DEFAULT FALSE,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS prompt_evolution_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      component_id TEXT NOT NULL,
      old_content TEXT,
      new_content TEXT,
      old_fitness FLOAT,
      new_fitness FLOAT,
      reason TEXT,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  logger.info('[DB] Schema v2 initialized');
}
