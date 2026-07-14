import { Pool } from 'pg';
import { logger } from '../middleware/logger';

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export async function initializeDatabase(): Promise<void> {
  await db.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  await db.query(`CREATE EXTENSION IF NOT EXISTS vector`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      last_activity_at TIMESTAMPTZ DEFAULT NOW(),
      turn_count INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE
    )
  `);

  await db.query(`CREATE INDEX IF NOT EXISTS sessions_student_id_idx ON sessions(student_id)`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS conversation_turns (
      turn_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      turn_number INT NOT NULL,
      student_message TEXT,
      tutor_response TEXT,
      emotional_snapshot JSONB,
      planner_force JSONB,
      modality TEXT DEFAULT 'text',
      model_used TEXT,
      latency_ms INT,
      tokens_in INT,
      tokens_out INT,
      cost_usd FLOAT DEFAULT 0,
      tools_used TEXT[],
      embedding VECTOR(384),
      topic TEXT,
      subject TEXT,
      mastery_evidenced BOOLEAN DEFAULT FALSE,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`CREATE INDEX IF NOT EXISTS turns_student_id_idx ON conversation_turns(student_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS turns_session_id_idx ON conversation_turns(session_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS turns_topic_idx ON conversation_turns(topic)`);

  try {
    await db.query(`
      CREATE INDEX IF NOT EXISTS turns_embedding_idx
      ON conversation_turns USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100)
    `);
  } catch { /* Needs enough rows first */ }

  await db.query(`
    CREATE TABLE IF NOT EXISTS student_profiles (
      student_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      total_sessions INT DEFAULT 0,
      total_turns INT DEFAULT 0,
      study_streak INT DEFAULT 0,
      last_study_date DATE,
      profile JSONB DEFAULT '{}',
      memory_blocks JSONB DEFAULT '{}',
      concept_progress JSONB DEFAULT '{}',
      error_diary JSONB DEFAULT '[]',
      analogy_library JSONB DEFAULT '[]',
      exam_targets JSONB DEFAULT '[]',
      cultural_context JSONB DEFAULT '{}',
      study_plan JSONB,
      learning_embedding VECTOR(384)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS past_questions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      exam_board TEXT NOT NULL,
      subject TEXT NOT NULL,
      topic TEXT NOT NULL,
      year INT,
      difficulty FLOAT DEFAULT 0.5,
      question_text TEXT NOT NULL,
      answer TEXT,
      explanation TEXT,
      embedding VECTOR(384),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS spaced_reviews (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      student_id TEXT NOT NULL,
      concept TEXT NOT NULL,
      subject TEXT,
      next_review_at TIMESTAMPTZ NOT NULL,
      interval_days INT DEFAULT 1,
      review_count INT DEFAULT 0,
      mastery_level FLOAT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`CREATE INDEX IF NOT EXISTS spaced_reviews_student_idx ON spaced_reviews(student_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS spaced_reviews_date_idx ON spaced_reviews(next_review_at)`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id TEXT PRIMARY KEY,
      processed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS cost_tracking (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      student_id TEXT NOT NULL,
      model TEXT NOT NULL,
      tokens_in INT NOT NULL,
      tokens_out INT NOT NULL,
      cost_usd FLOAT NOT NULL,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS knowledge_graph (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      student_id TEXT NOT NULL,
      entity TEXT NOT NULL,
      relation TEXT NOT NULL,
      target TEXT NOT NULL,
      confidence FLOAT DEFAULT 1.0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(student_id, entity, relation, target)
    )
  `);

  await db.query(`CREATE INDEX IF NOT EXISTS kg_student_idx ON knowledge_graph(student_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS kg_entity_idx ON knowledge_graph(entity)`);

  logger.info('[DB] All tables initialized');
}