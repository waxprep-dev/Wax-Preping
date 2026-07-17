-- WaxPrep v1.0 — one-time database setup
-- The app also runs initializeDatabase() on startup, which is idempotent and
-- handles everything below including v1→v2 migrations (ALTER IF NOT EXISTS).

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- Sessions (v2: +state JSONB for persistent per-session teaching state)
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),
  turn_count INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  state JSONB DEFAULT '{}'::JSONB
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS state JSONB DEFAULT '{}'::JSONB;
CREATE INDEX IF NOT EXISTS sessions_student_id_idx ON sessions (student_id);
CREATE INDEX IF NOT EXISTS sessions_last_activity_idx ON sessions (last_activity_at);

-- Conversation turns / episodic memory (v2: +embedding_provider)
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
);
ALTER TABLE conversation_turns ADD COLUMN IF NOT EXISTS embedding_provider TEXT;
CREATE INDEX IF NOT EXISTS turns_student_id_idx ON conversation_turns (student_id);
CREATE INDEX IF NOT EXISTS turns_session_id_idx ON conversation_turns (session_id);

-- Student profiles (semantic + procedural memory)
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
);

-- NEW in v2: structured facts extracted from conversation
CREATE TABLE IF NOT EXISTS student_facts (
  student_id TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  confidence FLOAT DEFAULT 0.7,
  source TEXT DEFAULT 'conversation',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (student_id, fact_key)
);

-- Notification queue (v2: +dedupe_key UNIQUE — fixes the notification-spam bug)
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
);
ALTER TABLE notification_queue ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS notif_dedupe_idx ON notification_queue(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Deduplication of inbound WhatsApp messages
CREATE TABLE IF NOT EXISTS processed_messages (
  message_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS processed_messages_time_idx ON processed_messages (processed_at);

-- Remaining tables (world_model_state, spaced_reviews, cost_tracking,
-- defense_log, ai_reflections, prompt_components, prompt_performance,
-- prompt_evolution_log, system_config) are created by initializeDatabase().
