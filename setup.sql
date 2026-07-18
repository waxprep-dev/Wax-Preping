-- ============================================================
-- WaxPrep v3.0 — Cognitive Architecture Migration
-- ============================================================

-- 1. EXTENSIONS (already present, but safe)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. STUDENT ATTRIBUTES (dynamic, extensible learner model)
CREATE TABLE IF NOT EXISTS student_attributes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id TEXT NOT NULL,
    attribute_key TEXT NOT NULL,
    attribute_value JSONB NOT NULL,
    confidence FLOAT NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    evidence_json JSONB NOT NULL DEFAULT '[]',
    category TEXT NOT NULL CHECK (category IN (
        'goal', 
        'cognitive_preference', 
        'affective_state', 
        'contextual_factor', 
        'metacognitive_trait'
    )),
    first_observed TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active BOOLEAN NOT NULL DEFAULT false,
    UNIQUE(student_id, attribute_key)
);

CREATE INDEX IF NOT EXISTS idx_student_attributes_student ON student_attributes(student_id);
CREATE INDEX IF NOT EXISTS idx_student_attributes_key ON student_attributes(attribute_key);
CREATE INDEX IF NOT EXISTS idx_student_attributes_category ON student_attributes(category);
CREATE INDEX IF NOT EXISTS idx_student_attributes_confidence ON student_attributes(confidence) WHERE is_active = true;

-- 3. STUDENT ARCHETYPES (clustering)
CREATE TABLE IF NOT EXISTS student_archetypes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_archetype_memberships_archetype ON student_archetype_memberships(archetype_id);

-- 4. SYLLABUS VECTOR STORE (replaces JSON packs)
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
CREATE INDEX IF NOT EXISTS idx_syllabus_topic ON syllabus_chunks(topic);

-- 5. TOOL REGISTRY (dynamic, no hardcoded tools)
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

-- 6. OBSERVABILITY TABLES
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
CREATE INDEX IF NOT EXISTS idx_tool_logs_name ON tool_call_logs(tool_name);

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

-- 7. ONBOARDING STATE (tracks discovery goals, not rigid scripts)
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

-- 8. MIGRATE EXISTING student_facts INTO student_attributes
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

-- 9. UPDATE student_profiles WITH ONBOARDING FLAGS
ALTER TABLE student_profiles 
    ADD COLUMN IF NOT EXISTS archetype_id UUID,
    ADD COLUMN IF NOT EXISTS attribute_summary TEXT;

-- 10. SEED INITIAL ARCHETYPES (rule-based, config-driven)
INSERT INTO student_archetypes (name, description, config, is_discovered)
VALUES 
    ('panic_crammer', 'High exam pressure, low time, high anxiety. Needs concise, exam-relevant content.', 
     '{"rules": [{"attribute_key": "exam_pressure", "operator": "gt", "value": 0.7}, {"attribute_key": "time_available", "operator": "lt", "value": 0.3}, {"attribute_key": "anxiety_level", "operator": "gt", "value": 0.6}]}', false),
    ('deep_diver', 'High curiosity, low exam pressure, prefers theory and connections. Needs depth and exploration room.', 
     '{"rules": [{"attribute_key": "curiosity_level", "operator": "gt", "value": 0.7}, {"attribute_key": "exam_pressure", "operator": "lt", "value": 0.3}, {"attribute_key": "prefers_theory", "operator": "eq", "value": true}]}', false),
    ('homework_helper', 'Sporadic engagement, seeks quick answers. Needs bite-sized, just-in-time help.', 
     '{"rules": [{"attribute_key": "engagement_pattern", "operator": "eq", "value": "sporadic"}, {"attribute_key": "seeks_quick_answers", "operator": "eq", "value": true}]}', false),
    ('steady_builder', 'Regular engagement, methodical progress. Needs structured, scaffolded learning.', 
     '{"rules": [{"attribute_key": "engagement_pattern", "operator": "eq", "value": "regular"}, {"attribute_key": "prefers_structure", "operator": "eq", "value": true}]}', false),
    ('confidence_seeker', 'Low self-efficacy, needs reassurance and small wins. Needs frequent celebration and gentle pacing.', 
     '{"rules": [{"attribute_key": "self_efficacy", "operator": "lt", "value": 0.4}, {"attribute_key": "needs_reassurance", "operator": "eq", "value": true}]}', false)
ON CONFLICT DO NOTHING;

-- 11. SEED TOOL REGISTRY
INSERT INTO tools (name, description, input_schema, handler_module, is_enabled)
VALUES 
    ('syllabus_query', 'Search the syllabus vector store for topics, objectives, and exam coverage.', 
     '{"type":"object","properties":{"subject":{"type":"string"},"query":{"type":"string"},"exam_board":{"type":"string","enum":["WAEC","JAMB","NECO"]},"level":{"type":"string"}},"required":["query"]}',
     'src/tools/implementations.ts', true),
    ('web_search', 'Search the web for current events, real-world examples, and fresh context.', 
     '{"type":"object","properties":{"query":{"type":"string"},"max_results":{"type":"number","default":5}},"required":["query"]}',
     'src/tools/implementations.ts', true),
    ('calculator', 'Evaluate mathematical expressions with step-by-step working.', 
     '{"type":"object","properties":{"expression":{"type":"string"}},"required":["expression"]}',
     'src/tools/implementations.ts', true),
    ('code_interpreter', 'Run Python code for simulations, visualizations, and algorithmic explanations.', 
     '{"type":"object","properties":{"code":{"type":"string"},"language":{"type":"string","default":"python"}},"required":["code"]}',
     'src/tools/implementations.ts', false),
    ('concept_lookup', 'Define any academic term with examples and related concepts.', 
     '{"type":"object","properties":{"term":{"type":"string"},"subject":{"type":"string"},"context":{"type":"string"}},"required":["term"]}',
     'src/tools/implementations.ts', true),
    ('past_question_retrieval', 'Fetch WAEC/JAMB past questions for practice.', 
     '{"type":"object","properties":{"subject":{"type":"string"},"topic":{"type":"string"},"exam_board":{"type":"string"},"year_range":{"type":"array","items":{"type":"number"}},"limit":{"type":"number","default":5}},"required":["subject","topic"]}',
     'src/tools/implementations.ts', true)
ON CONFLICT (name) DO NOTHING;