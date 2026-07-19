/**
 * Database client with idempotent schema initialization.
 * Extended for v3.0 cognitive architecture.
 */
import { Pool } from 'pg';
import { logger } from '../middleware/logger';

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export async function initializeDatabase(): Promise<void> {
  // Core extensions
  await db.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  await db.query(`CREATE EXTENSION IF NOT EXISTS vector`);

  // Sessions (v2: +state JSONB for persistent per-session teaching state)
  await db.query(`
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
  `);

  // Conversation turns / episodic memory (v2: +embedding_provider)
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
    );
    ALTER TABLE conversation_turns ADD COLUMN IF NOT EXISTS embedding_provider TEXT;
    CREATE INDEX IF NOT EXISTS turns_student_id_idx ON conversation_turns (student_id);
    CREATE INDEX IF NOT EXISTS turns_session_id_idx ON conversation_turns (session_id);
  `);

  // Student profiles (semantic + procedural memory)
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
    );
  `);

  // v3.0: student_attributes (dynamic, extensible learner model)
  await db.query(`
    CREATE TABLE IF NOT EXISTS student_attributes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      attribute_key TEXT NOT NULL,
      attribute_value JSONB NOT NULL,
      confidence FLOAT NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
      evidence_json JSONB NOT NULL DEFAULT '[]',
      category TEXT NOT NULL CHECK (category IN ('goal', 'cognitive_preference', 'affective_state', 'contextual_factor', 'metacognitive_trait')),
      first_observed TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_active BOOLEAN NOT NULL DEFAULT false,
      UNIQUE(student_id, attribute_key)
    );
    CREATE INDEX IF NOT EXISTS idx_student_attributes_student ON student_attributes(student_id);
    CREATE INDEX IF NOT EXISTS idx_student_attributes_key ON student_attributes(attribute_key);
    CREATE INDEX IF NOT EXISTS idx_student_attributes_category ON student_attributes(category);
    CREATE INDEX IF NOT EXISTS idx_student_attributes_confidence ON student_attributes(confidence) WHERE is_active = true;
  `);

  // v3.0: student_archetypes (clustering)
  await db.query(`
    CREATE TABLE IF NOT EXISTS student_archetypes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      centroid_vector VECTOR(1536),
      member_count INT NOT NULL DEFAULT 0,
      is_discovered BOOLEAN NOT NULL DEFAULT false,
      config JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS student_archetype_memberships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      archetype_id UUID NOT NULL REFERENCES student_archetypes(id) ON DELETE CASCADE,
      similarity_score FLOAT NOT NULL,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(student_id, archetype_id)
    );
    CREATE INDEX IF NOT EXISTS idx_archetype_memberships_student ON student_archetype_memberships(student_id);
  `);

  // v3.0: syllabus_chunks (replaces JSON packs)
  await db.query(`
    CREATE TABLE IF NOT EXISTS syllabus_chunks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      subject TEXT NOT NULL,
      exam_board TEXT NOT NULL,
      level TEXT NOT NULL,
      topic TEXT NOT NULL,
      sub_topic TEXT NOT NULL,
      objectives TEXT[] NOT NULL DEFAULT '{}',
      exam_weight FLOAT,
      related_topics TEXT[] NOT NULL DEFAULT '{}',
      content_text TEXT NOT NULL,
      source_reference TEXT,
      embedding VECTOR(1536),
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_syllabus_embedding ON syllabus_chunks USING ivfflat (embedding vector_cosine_ops);
    CREATE INDEX IF NOT EXISTS idx_syllabus_subject ON syllabus_chunks(subject);
    CREATE INDEX IF NOT EXISTS idx_syllabus_exam_board ON syllabus_chunks(exam_board);
  `);

  // v3.0: tools (dynamic registry)
  await db.query(`
    CREATE TABLE IF NOT EXISTS tools (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      input_schema JSONB NOT NULL,
      handler_module TEXT NOT NULL,
      is_enabled BOOLEAN NOT NULL DEFAULT true,
      requires_config JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tools_enabled ON tools(is_enabled);
  `);

  // v3.0: observability tables
  await db.query(`
    CREATE TABLE IF NOT EXISTS attribute_extraction_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      turn_id TEXT,
      raw_llm_output JSONB NOT NULL,
      parsed_candidates JSONB NOT NULL,
      accepted_attributes JSONB NOT NULL,
      rejected_attributes JSONB NOT NULL,
      latency_ms INT,
      model_used TEXT,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_attr_logs_student ON attribute_extraction_logs(student_id);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS tool_call_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      session_id TEXT,
      tool_name TEXT NOT NULL,
      tool_input JSONB NOT NULL,
      tool_output JSONB,
      latency_ms INT,
      tutor_decision_reason TEXT,
      error TEXT,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tool_logs_student ON tool_call_logs(student_id);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS tutor_decision_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      session_id TEXT,
      turn_number INT,
      decision_type TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      context_snapshot JSONB NOT NULL,
      selected_topic TEXT,
      selected_strategy TEXT,
      tools_considered TEXT[],
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_decision_logs_student ON tutor_decision_logs(student_id);
  `);

  // v3.0: onboarding_state
  await db.query(`
    CREATE TABLE IF NOT EXISTS onboarding_state (
      student_id TEXT PRIMARY KEY,
      is_complete BOOLEAN NOT NULL DEFAULT false,
      discovery_goals_satisfied JSONB NOT NULL DEFAULT '{}',
      turns_completed INT NOT NULL DEFAULT 0,
      last_goal_attempted TEXT,
      dropped_off_at_goal TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      resumed_count INT NOT NULL DEFAULT 0
    );
  `);

  // Student facts (legacy, preserved for migration)
  await db.query(`
    CREATE TABLE IF NOT EXISTS student_facts (
      student_id TEXT NOT NULL,
      fact_key TEXT NOT NULL,
      fact_value TEXT NOT NULL,
      confidence FLOAT DEFAULT 0.7,
      source TEXT DEFAULT 'conversation',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (student_id, fact_key)
    );
  `);

  // Notification queue (v2: +dedupe_key UNIQUE)
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
    );
    ALTER TABLE notification_queue ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS notif_dedupe_idx ON notification_queue(dedupe_key);
    CREATE INDEX IF NOT EXISTS notif_student_idx ON notification_queue(student_id, sent, scheduled_at);
  `);

  // Defense log (v2: content-safety layer)
  await db.query(`
    CREATE TABLE IF NOT EXISTS defense_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      session_id TEXT,
      layer TEXT NOT NULL,
      severity TEXT NOT NULL,
      issue TEXT NOT NULL,
      original_response TEXT,
      revised_response TEXT,
      was_fixed BOOLEAN,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS defense_log_student_idx ON defense_log(student_id);
  `);

  // Cost tracking (v2: actually written by router now)
  await db.query(`
    CREATE TABLE IF NOT EXISTS cost_tracking (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      model TEXT NOT NULL,
      tokens_in INT DEFAULT 0,
      tokens_out INT DEFAULT 0,
      cost_usd FLOAT DEFAULT 0,
      purpose TEXT,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS cost_tracking_student_idx ON cost_tracking(student_id);
  `);

  // System config (constitution, prompts)
  await db.query(`
    CREATE TABLE IF NOT EXISTS system_config (
      key TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Prompt components (v2: evolvable prompts)
  await db.query(`
    CREATE TABLE IF NOT EXISTS prompt_components (
      component_id TEXT PRIMARY KEY,
      current_text TEXT NOT NULL,
      fitness_score FLOAT DEFAULT 0.5,
      generation INT DEFAULT 1,
      parent_id TEXT,
      usage_count INT DEFAULT 0,
      success_rate FLOAT DEFAULT 0.5,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Session state (v2: persistent per-session teaching state)
  await db.query(`
    CREATE TABLE IF NOT EXISTS session_state (
      session_id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,
      state JSONB DEFAULT '{}'::JSONB,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS session_state_student_idx ON session_state(student_id);
  `);

  // Knowledge trace events (v2: BKT parameter learning)
  await db.query(`
    CREATE TABLE IF NOT EXISTS knowledge_trace_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      success BOOLEAN NOT NULL,
      p_before FLOAT NOT NULL,
      p_after FLOAT NOT NULL,
      source TEXT,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS kte_student_concept_idx ON knowledge_trace_events(student_id, concept_id);
  `);

  // Processed messages (v2: deduplication)
  await db.query(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id TEXT PRIMARY KEY,
      processed_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS processed_messages_time_idx ON processed_messages (processed_at);
  `);

  // =====================================================================
  // v3.0 COGNITIVE MEMORY ARCHITECTURE TABLES
  // =====================================================================

  // Segmentation config
  await db.query(`
    CREATE TABLE IF NOT EXISTS segmentation_config (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT,
      weights JSONB NOT NULL DEFAULT '{"topic_drift": 0.35, "emotional": 0.25, "cognitive": 0.25, "time": 0.10, "pedagogical": 0.05}',
      thresholds JSONB NOT NULL DEFAULT '{"boundary": 0.6, "time_gap": 30, "system1_trigger": 0.3}',
      features JSONB NOT NULL DEFAULT '{"use_embedding_drift": true, "use_emotional_delta": true, "use_lexical_shift": true, "use_cognitive_task_detection": true, "use_pedagogical_transition": true}',
      model_config JSONB NOT NULL DEFAULT '{"system1_model_tier": "fast", "system2_model_tier": "smart"}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(student_id)
    );
    CREATE INDEX IF NOT EXISTS idx_segmentation_config_student ON segmentation_config(student_id);
  `);

  // Session boundaries
  await db.query(`
    CREATE TABLE IF NOT EXISTS session_boundaries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      previous_session_id TEXT,
      new_session_id TEXT NOT NULL,
      boundary_type TEXT NOT NULL,
      boundary_probability FLOAT NOT NULL,
      boundary_signals JSONB NOT NULL DEFAULT '{}',
      llm_reasoning TEXT,
      was_correct BOOLEAN,
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_boundaries_student ON session_boundaries(student_id, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_boundaries_type ON session_boundaries(boundary_type);
  `);

  // Extend sessions with cognitive fields
  await db.query(`
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS boundary_type TEXT;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS boundary_probability FLOAT;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS boundary_signals JSONB NOT NULL DEFAULT '{}';
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS previous_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS continuity_score FLOAT;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cognitive_metadata JSONB NOT NULL DEFAULT '{}';
  `).catch(err => logger.warn({ err }, '[DB] Failed to extend sessions with cognitive fields'));

  // Extend conversation_turns with cognitive signals
  await db.query(`
    ALTER TABLE conversation_turns ADD COLUMN IF NOT EXISTS emotional_valence FLOAT;
    ALTER TABLE conversation_turns ADD COLUMN IF NOT EXISTS cognitive_load_estimate INT;
    ALTER TABLE conversation_turns ADD COLUMN IF NOT EXISTS topic_drift_score FLOAT;
    ALTER TABLE conversation_turns ADD COLUMN IF NOT EXISTS is_boundary_turn BOOLEAN DEFAULT FALSE;
  `).catch(err => logger.warn({ err }, '[DB] Failed to extend conversation_turns with cognitive signals'));

  // Cognitive graph nodes
  await db.query(`
    CREATE TABLE IF NOT EXISTS cognitive_graph_nodes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      labels TEXT[] NOT NULL DEFAULT '{}',
      properties JSONB NOT NULL DEFAULT '{}',
      embedding VECTOR(384),
      event_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ingest_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      validity_window tstzrange,
      student_id TEXT,
      source TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_labels ON cognitive_graph_nodes USING GIN(labels);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_properties ON cognitive_graph_nodes USING GIN(properties);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_student ON cognitive_graph_nodes(student_id);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_event_time ON cognitive_graph_nodes(event_time);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_validity ON cognitive_graph_nodes USING GIST(validity_window);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_embedding ON cognitive_graph_nodes USING ivfflat (embedding vector_cosine_ops);
  `);

  // Cognitive graph edges
  await db.query(`
    CREATE TABLE IF NOT EXISTS cognitive_graph_edges (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source_id UUID NOT NULL REFERENCES cognitive_graph_nodes(id) ON DELETE CASCADE,
      target_id UUID NOT NULL REFERENCES cognitive_graph_nodes(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      properties JSONB NOT NULL DEFAULT '{}',
      event_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ingest_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      validity_window tstzrange,
      student_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON cognitive_graph_edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON cognitive_graph_edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON cognitive_graph_edges(type);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_student ON cognitive_graph_edges(student_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_validity ON cognitive_graph_edges USING GIST(validity_window);
  `);

  // Graph adjacency
  await db.query(`
    CREATE TABLE IF NOT EXISTS cognitive_graph_adjacency (
      node_id UUID NOT NULL REFERENCES cognitive_graph_nodes(id) ON DELETE CASCADE,
      edge_id UUID NOT NULL REFERENCES cognitive_graph_edges(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK (direction IN ('out', 'in')),
      neighbor_id UUID NOT NULL REFERENCES cognitive_graph_nodes(id) ON DELETE CASCADE,
      edge_type TEXT NOT NULL,
      PRIMARY KEY (node_id, edge_id, direction)
    );
    CREATE INDEX IF NOT EXISTS idx_adjacency_node ON cognitive_graph_adjacency(node_id);
    CREATE INDEX IF NOT EXISTS idx_adjacency_neighbor ON cognitive_graph_adjacency(neighbor_id);
    CREATE INDEX IF NOT EXISTS idx_adjacency_type ON cognitive_graph_adjacency(edge_type);
  `);

  // Graph references
  await db.query(`
    CREATE TABLE IF NOT EXISTS cognitive_graph_references (
      node_id UUID NOT NULL REFERENCES cognitive_graph_nodes(id) ON DELETE CASCADE,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      row_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (node_id, table_name, row_id)
    );
    CREATE INDEX IF NOT EXISTS idx_graph_refs_lookup ON cognitive_graph_references(table_name, row_id);
  `);

  // Forgetting params
  await db.query(`
    CREATE TABLE IF NOT EXISTS forgetting_params (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL UNIQUE,
      decay_rate FLOAT NOT NULL DEFAULT 0.5,
      decay_temperature FLOAT NOT NULL DEFAULT 1.0,
      retrieval_threshold FLOAT NOT NULL DEFAULT 0.3,
      emotional_salience_weight FLOAT NOT NULL DEFAULT 1.5,
      contextual_boost_weight FLOAT NOT NULL DEFAULT 2.0,
      noise_stddev FLOAT NOT NULL DEFAULT 0.3,
      oblivion_threshold FLOAT NOT NULL DEFAULT 0.1,
      uncertainty_threshold FLOAT NOT NULL DEFAULT 0.4,
      top_k_retrieval INT NOT NULL DEFAULT 5,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_forgetting_params_student ON forgetting_params(student_id);
  `);

  // Memory access logs
  await db.query(`
    CREATE TABLE IF NOT EXISTS memory_access_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      query TEXT,
      activation_score FLOAT,
      oblivion_probability FLOAT,
      was_retrieved BOOLEAN NOT NULL DEFAULT FALSE,
      retrieval_rank INT,
      feedback_score FLOAT DEFAULT 0,
      accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_memory_access_student ON memory_access_logs(student_id, accessed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_access_memory ON memory_access_logs(memory_id, memory_type);
  `);

  // Predictive preloads
  await db.query(`
    CREATE TABLE IF NOT EXISTS predictive_preloads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL UNIQUE,
      context JSONB NOT NULL,
      computed_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      hit_count INT NOT NULL DEFAULT 0,
      miss_count INT NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_preloads_expires ON predictive_preloads(expires_at);
  `);

  // Concept retention curves
  await db.query(`
    CREATE TABLE IF NOT EXISTS concept_retention_curves (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      concept_name TEXT NOT NULL,
      first_studied_at TIMESTAMPTZ NOT NULL,
      last_reviewed_at TIMESTAMPTZ,
      review_count INT NOT NULL DEFAULT 0,
      optimal_interval_hours FLOAT NOT NULL DEFAULT 24,
      retention_estimate FLOAT NOT NULL DEFAULT 1.0,
      decay_rate_observed FLOAT,
      next_predicted_review TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(student_id, concept_name)
    );
    CREATE INDEX IF NOT EXISTS idx_retention_student ON concept_retention_curves(student_id);
    CREATE INDEX IF NOT EXISTS idx_retention_next_review ON concept_retention_curves(next_predicted_review);
  `);

  // Memory palaces
  await db.query(`
    CREATE TABLE IF NOT EXISTS memory_palaces (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL UNIQUE,
      palace_name TEXT NOT NULL DEFAULT 'Learning Universe',
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_palaces_student ON memory_palaces(student_id);
  `);

  // Memory palace nodes
  await db.query(`
    CREATE TABLE IF NOT EXISTS memory_palace_nodes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      palace_id UUID NOT NULL REFERENCES memory_palaces(id) ON DELETE CASCADE,
      parent_id UUID REFERENCES memory_palace_nodes(id) ON DELETE CASCADE,
      node_type TEXT NOT NULL CHECK (node_type IN ('wing', 'room', 'drawer')),
      name TEXT NOT NULL,
      domain TEXT,
      topic TEXT,
      concept TEXT,
      metadata JSONB NOT NULL DEFAULT '{}',
      access_count INT NOT NULL DEFAULT 0,
      last_accessed TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_palace_nodes_palace ON memory_palace_nodes(palace_id);
    CREATE INDEX IF NOT EXISTS idx_palace_nodes_parent ON memory_palace_nodes(parent_id);
    CREATE INDEX IF NOT EXISTS idx_palace_nodes_type ON memory_palace_nodes(node_type);
  `);

  // Memory palace contents
  await db.query(`
    CREATE TABLE IF NOT EXISTS memory_palace_contents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      palace_node_id UUID NOT NULL REFERENCES memory_palace_nodes(id) ON DELETE CASCADE,
      graph_node_id UUID NOT NULL REFERENCES cognitive_graph_nodes(id) ON DELETE CASCADE,
      content_type TEXT NOT NULL,
      placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      access_count INT NOT NULL DEFAULT 0,
      last_accessed TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_palace_contents_node ON memory_palace_contents(palace_node_id);
    CREATE INDEX IF NOT EXISTS idx_palace_contents_graph ON memory_palace_contents(graph_node_id);
  `);

  // Memory palace tunnels
  await db.query(`
    CREATE TABLE IF NOT EXISTS memory_palace_tunnels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      palace_id UUID NOT NULL REFERENCES memory_palaces(id) ON DELETE CASCADE,
      source_node_id UUID NOT NULL REFERENCES memory_palace_nodes(id) ON DELETE CASCADE,
      target_node_id UUID NOT NULL REFERENCES memory_palace_nodes(id) ON DELETE CASCADE,
      strength FLOAT NOT NULL DEFAULT 0.5,
      reasoning TEXT,
      discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_validated TIMESTAMPTZ,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      UNIQUE(source_node_id, target_node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_palace_tunnels_palace ON memory_palace_tunnels(palace_id);
    CREATE INDEX IF NOT EXISTS idx_palace_tunnels_active ON memory_palace_tunnels(is_active, strength DESC);
  `);

  // Tool memories
  await db.query(`
    CREATE TABLE IF NOT EXISTS tool_memories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tool_name TEXT NOT NULL,
      student_id TEXT,
      total_calls INT NOT NULL DEFAULT 0,
      successful_calls INT NOT NULL DEFAULT 0,
      failed_calls INT NOT NULL DEFAULT 0,
      avg_latency_ms FLOAT,
      optimal_params JSONB NOT NULL DEFAULT '{}',
      common_failures JSONB NOT NULL DEFAULT '[]',
      typical_use_cases JSONB NOT NULL DEFAULT '[]',
      dependency_chains JSONB NOT NULL DEFAULT '[]',
      last_used_at TIMESTAMPTZ,
      last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(tool_name, student_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tool_memories_name ON tool_memories(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_memories_student ON tool_memories(student_id);
  `);

  // Tool call memory links
  await db.query(`
    CREATE TABLE IF NOT EXISTS tool_call_memory_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tool_call_id TEXT NOT NULL,
      graph_node_id UUID NOT NULL REFERENCES cognitive_graph_nodes(id) ON DELETE CASCADE,
      link_type TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tool_call_links_tool ON tool_call_memory_links(tool_call_id);
    CREATE INDEX IF NOT EXISTS idx_tool_call_links_node ON tool_call_memory_links(graph_node_id);
  `);

  // Consolidation logs
  await db.query(`
    CREATE TABLE IF NOT EXISTS consolidation_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      items_processed INT,
      items_created INT,
      items_modified INT,
      items_archived INT,
      insights_generated JSONB,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      error_message TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_consolidation_logs_student ON consolidation_logs(student_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_consolidation_logs_phase ON consolidation_logs(phase);
  `);

  // Memory contradictions
  await db.query(`
    CREATE TABLE IF NOT EXISTS memory_contradictions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      attribute_key TEXT NOT NULL,
      current_fact_node_id UUID REFERENCES cognitive_graph_nodes(id),
      outdated_fact_node_id UUID REFERENCES cognitive_graph_nodes(id),
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      resolution_type TEXT,
      confidence FLOAT NOT NULL DEFAULT 0.7
    );
    CREATE INDEX IF NOT EXISTS idx_contradictions_student ON memory_contradictions(student_id, detected_at DESC);
  `);

  // Memory patterns
  await db.query(`
    CREATE TABLE IF NOT EXISTS memory_patterns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      pattern_name TEXT NOT NULL,
      description TEXT NOT NULL,
      evidence_episodes JSONB NOT NULL DEFAULT '[]',
      confidence FLOAT NOT NULL DEFAULT 0.5,
      category TEXT,
      first_detected TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_observed TIMESTAMPTZ,
      occurrence_count INT NOT NULL DEFAULT 1,
      UNIQUE(student_id, pattern_name)
    );
    CREATE INDEX IF NOT EXISTS idx_patterns_student ON memory_patterns(student_id, category);
    CREATE INDEX IF NOT EXISTS idx_patterns_name ON memory_patterns(pattern_name);
  `);

  // Memory communities
  await db.query(`
    CREATE TABLE IF NOT EXISTS memory_communities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      community_name TEXT,
      summary TEXT,
      member_count INT NOT NULL DEFAULT 0,
      member_node_ids UUID[] NOT NULL DEFAULT '{}',
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      llm_summary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_communities_student ON memory_communities(student_id);
  `);

  // Cognitive system config
  await db.query(`
    CREATE TABLE IF NOT EXISTS cognitive_system_config (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      description TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Seed default configurations
  await db.query(`
    INSERT INTO cognitive_system_config (key, value, description) VALUES
    ('segmentation', '{"enabled": true, "system1_always": true, "system2_threshold": 0.3}', 'Session segmentation engine settings'),
    ('forgetting', '{"enabled": true, "default_decay_rate": 0.5, "default_decay_temperature": 1.0, "default_retrieval_threshold": 0.3}', 'Forgetting engine defaults'),
    ('prediction', '{"enabled": true, "preload_ttl_seconds": 21600, "prediction_horizon_days": 7}', 'Predictive pre-load settings'),
    ('palace', '{"enabled": true, "auto_construct": true, "max_wings": 20, "max_rooms_per_wing": 50}', 'Memory palace settings'),
    ('tool_memory', '{"enabled": true, "learn_from_failures": true, "dependency_tracking": true}', 'Tool-memory symbiosis settings'),
    ('sleep_mode', '{"enabled": true, "schedule_cron": "0 2 * * *", "timezone_aware": true, "max_students_per_night": 100}', 'Sleep mode consolidation settings'),
    ('graph', '{"adapter": "postgres", "neo4j_uri": null, "neo4j_user": null, "embedding_dimension": 384}', 'Graph database adapter configuration')
    ON CONFLICT (key) DO NOTHING;
  `);

  // Seed global segmentation config
  await db.query(`
    INSERT INTO segmentation_config (student_id, weights, thresholds, features, model_config)
    VALUES (
      NULL,
      '{"topic_drift": 0.35, "emotional": 0.25, "cognitive": 0.25, "time": 0.10, "pedagogical": 0.05}',
      '{"boundary": 0.6, "time_gap": 30, "system1_trigger": 0.3}',
      '{"use_embedding_drift": true, "use_emotional_delta": true, "use_lexical_shift": true, "use_cognitive_task_detection": true, "use_pedagogical_transition": true}',
      '{"system1_model_tier": "fast", "system2_model_tier": "smart"}'
    )
    ON CONFLICT (student_id) DO NOTHING;
  `);

  // v3.0: Migrate existing student_facts into student_attributes (only if data exists)
  const factsCountRes = await db.query(`SELECT COUNT(*)::int AS count FROM student_facts`).catch(() => ({ rows: [{ count: 0 }] }));
  const factsCount = factsCountRes.rows[0]?.count || 0;

  if (factsCount > 0) {
    await db.query(`
      INSERT INTO student_attributes (
        student_id, attribute_key, attribute_value, confidence, 
        evidence_json, category, is_active
      )
      SELECT 
        student_id,
        fact_key,
        to_jsonb(fact_value),
        COALESCE(confidence, 0.7),
        jsonb_build_array(jsonb_build_object('source', COALESCE(source, 'migration'), 'timestamp', NOW())),
        CASE 
          WHEN fact_key IN ('intended_course', 'subject_interest', 'exam_type', 'target_school') THEN 'goal'
          WHEN fact_key IN ('foundation_level', 'study_habit', 'track') THEN 'cognitive_preference'
          ELSE 'contextual_factor'
        END,
        CASE WHEN COALESCE(confidence, 0.7) >= 0.6 THEN true ELSE false END
      FROM student_facts
      ON CONFLICT (student_id, attribute_key) DO NOTHING;
    `).catch(err => logger.warn({ err }, '[DB] Failed to migrate student_facts'));
  }

  // Seed default archetypes and tools
  await seedDefaultArchetypes();
  await seedDefaultTools();

  logger.info('[DB] v3.0 cognitive schema initialized');
}

async function seedDefaultArchetypes(): Promise<void> {
  const archetypes = [
    {
      name: 'panic_crammer',
      description: 'High exam pressure, low time, high anxiety. Needs concise, exam-relevant content.',
      config: { rules: [{ attribute_key: 'exam_pressure', operator: 'gt', value: 0.7 }, { attribute_key: 'time_available', operator: 'lt', value: 0.3 }] },
    },
    {
      name: 'deep_diver',
      description: 'High curiosity, low exam pressure, prefers theory and connections. Needs depth and exploration room.',
      config: { rules: [{ attribute_key: 'curiosity_level', operator: 'gt', value: 0.7 }, { attribute_key: 'exam_pressure', operator: 'lt', value: 0.3 }] },
    },
    {
      name: 'homework_helper',
      description: 'Sporadic engagement, seeks quick answers. Needs bite-sized, just-in-time help.',
      config: { rules: [{ attribute_key: 'engagement_pattern', operator: 'eq', value: 'sporadic' }] },
    },
    {
      name: 'steady_builder',
      description: 'Regular engagement, methodical progress. Needs structured, scaffolded learning.',
      config: { rules: [{ attribute_key: 'engagement_pattern', operator: 'eq', value: 'regular' }] },
    },
    {
      name: 'confidence_seeker',
      description: 'Low self-efficacy, needs reassurance and small wins. Needs frequent celebration and gentle pacing.',
      config: { rules: [{ attribute_key: 'self_efficacy', operator: 'lt', value: 0.4 }] },
    },
  ];

  for (const a of archetypes) {
    await db.query(
      `INSERT INTO student_archetypes (name, description, config, is_discovered)
       VALUES ($1, $2, $3, false)
       ON CONFLICT (name) DO NOTHING`,
      [a.name, a.description, JSON.stringify(a.config)]
    ).catch(err => logger.warn({ err }, `[DB] Failed to seed archetype ${a.name}`));
  }
}

async function seedDefaultTools(): Promise<void> {
  const tools = [
    {
      name: 'syllabus_query',
      description: 'Search the syllabus vector store for topics, objectives, and exam coverage.',
      input_schema: { type: 'object', properties: { subject: { type: 'string' }, query: { type: 'string' }, exam_board: { type: 'string' }, level: { type: 'string' } }, required: ['query'] },
      handler_module: 'src/tools/implementations.ts',
    },
    {
      name: 'web_search',
      description: 'Search the web for current events, real-world examples, and fresh context.',
      input_schema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'number', default: 5 } }, required: ['query'] },
      handler_module: 'src/tools/implementations.ts',
    },
    {
      name: 'calculator',
      description: 'Evaluate mathematical expressions with step-by-step working.',
      input_schema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
      handler_module: 'src/tools/implementations.ts',
    },
    {
      name: 'code_interpreter',
      description: 'Run Python code for simulations, visualizations, and algorithmic explanations.',
      input_schema: { type: 'object', properties: { code: { type: 'string' }, language: { type: 'string', default: 'python' } }, required: ['code'] },
      handler_module: 'src/tools/implementations.ts',
    },
    {
      name: 'concept_lookup',
      description: 'Define any academic term with examples and related concepts.',
      input_schema: { type: 'object', properties: { term: { type: 'string' }, subject: { type: 'string' }, context: { type: 'string' } }, required: ['term'] },
      handler_module: 'src/tools/implementations.ts',
    },
    {
      name: 'past_question_retrieval',
      description: 'Fetch WAEC/JAMB past questions for practice.',
      input_schema: { type: 'object', properties: { subject: { type: 'string' }, topic: { type: 'string' }, exam_board: { type: 'string' }, year_range: { type: 'array', items: { type: 'number' } }, limit: { type: 'number', default: 5 } }, required: ['subject', 'topic'] },
      handler_module: 'src/tools/implementations.ts',
    },
  ];

  for (const t of tools) {
    await db.query(
      `INSERT INTO tools (name, description, input_schema, handler_module, is_enabled)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (name) DO NOTHING`,
      [t.name, t.description, JSON.stringify(t.input_schema), t.handler_module]
    ).catch(err => logger.warn({ err }, `[DB] Failed to seed tool ${t.name}`));
  }
}
