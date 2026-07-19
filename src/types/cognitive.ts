/**
 * WaxPrep v3.0 — Cognitive Memory Architecture Types
 * Subject-agnostic types for the 7-breakthrough cognitive system.
 */

import type { EmotionalSnapshot } from './student';

// =============================================================================
// BREAKTHROUGH 1: DUAL-PROCESS SESSION SEGMENTATION
// =============================================================================

export interface SegmentationWeights {
  topic_drift: number;
  emotional: number;
  cognitive: number;
  time: number;
  pedagogical: number;
}

export interface SegmentationThresholds {
  boundary: number;
  time_gap: number;
  system1_trigger: number;
}

export interface SegmentationFeatures {
  use_embedding_drift: boolean;
  use_emotional_delta: boolean;
  use_lexical_shift: boolean;
  use_cognitive_task_detection: boolean;
  use_pedagogical_transition: boolean;
}

export interface SegmentationModelConfig {
  system1_model_tier: 'fast' | 'smart' | 'deep';
  system2_model_tier: 'fast' | 'smart' | 'deep';
}

export interface SegmentationConfig {
  id: string;
  student_id: string | null;
  weights: SegmentationWeights;
  thresholds: SegmentationThresholds;
  features: SegmentationFeatures;
  model_config: SegmentationModelConfig;
  created_at: Date;
  updated_at: Date;
}

export interface BoundarySignal {
  topic_drift_score: number;
  emotional_delta: number;
  cognitive_task_shift: boolean;
  pedagogical_transition: string;
  time_gap_minutes: number;
  lexical_shift_detected: boolean;
  embedding_cosine_distance: number;
}

export interface BoundaryDecision {
  is_boundary: boolean;
  boundary_type: string;
  boundary_probability: number;
  signals: BoundarySignal;
  llm_reasoning?: string;
  previous_session_id?: string;
  continuity_score?: number;
}

export interface SessionBoundaryRecord {
  id: string;
  student_id: string;
  previous_session_id: string | null;
  new_session_id: string;
  boundary_type: string;
  boundary_probability: number;
  boundary_signals: BoundarySignal;
  llm_reasoning: string | null;
  was_correct: boolean | null;
  detected_at: Date;
}

// =============================================================================
// BREAKTHROUGH 2: TEMPORAL KNOWLEDGE GRAPH
// =============================================================================

export type GraphNodeLabel = 'Episode' | 'Concept' | 'Fact' | 'State' | 'ToolResult' | 'Insight' | 'Community' | string;

export interface GraphNode {
  id: string;
  labels: GraphNodeLabel[];
  properties: Record<string, unknown>;
  embedding?: number[];
  event_time: Date;
  ingest_time: Date;
  validity_window?: [Date | null, Date | null];
  student_id?: string;
  source?: string;
  created_at: Date;
}

export interface GraphEdge {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  properties: Record<string, unknown>;
  event_time: Date;
  ingest_time: Date;
  validity_window?: [Date | null, Date | null];
  student_id?: string;
  created_at: Date;
}

export interface GraphPath {
  nodes: GraphNode[];
  edges: GraphEdge[];
  length: number;
}

export type GraphQueryResult = GraphNode | GraphEdge | GraphPath | Record<string, unknown>;

export interface GraphAdapter {
  createNode(node: Omit<GraphNode, 'id' | 'created_at'>): Promise<GraphNode>;
  createEdge(edge: Omit<GraphEdge, 'id' | 'created_at'>): Promise<GraphEdge>;
  getNode(id: string): Promise<GraphNode | null>;
  getEdges(nodeId: string, direction: 'out' | 'in' | 'both', type?: string): Promise<GraphEdge[]>;
  searchNodes(filters: Record<string, unknown>, limit?: number): Promise<GraphNode[]>;
  traverse(startNodeId: string, edgeTypes: string[], depth: number): Promise<GraphPath[]>;
  updateNode(id: string, updates: Partial<GraphNode>): Promise<GraphNode>;
  invalidateEdge(id: string, reason?: string): Promise<void>;
  queryBiTemporal(nodeLabel: string, studentId: string, atTime: Date): Promise<GraphNode[]>;
  findSimilar(embedding: number[], limit?: number, studentId?: string): Promise<GraphNode[]>;
  deleteNode(id: string): Promise<void>;
}

// =============================================================================
// BREAKTHROUGH 3: HUMAN-LIKE FORGETTING ENGINE
// =============================================================================

export interface ForgettingParams {
  id: string;
  student_id: string;
  decay_rate: number;
  decay_temperature: number;
  retrieval_threshold: number;
  emotional_salience_weight: number;
  contextual_boost_weight: number;
  noise_stddev: number;
  oblivion_threshold: number;
  uncertainty_threshold: number;
  top_k_retrieval: number;
  updated_at: Date;
}

export interface MemoryChunk {
  id: string;
  content: string;
  embedding: number[];
  memory_type: 'episode' | 'fact' | 'concept' | 'state';
  
  // ACT-R parameters
  base_activation: number;
  last_accessed: Date;
  access_count: number;
  
  // Contextual boost (computed at retrieval time)
  semantic_similarity_to_query: number;
  
  // Forgetting parameters
  decay_rate: number;
  retrieval_threshold: number;
  
  // Emotional salience
  emotional_salience: number;
  
  // Oblivion parameters
  usage_count: number;
  feedback_score: number;
  decay_temperature: number;
  
  // Activation score (computed at retrieval time)
  activation?: number;
}

export interface MemoryAccessLog {
  id: string;
  student_id: string;
  memory_id: string;
  memory_type: string;
  query?: string;
  activation_score?: number;
  oblivion_probability?: number;
  was_retrieved: boolean;
  retrieval_rank?: number;
  feedback_score: number;
  accessed_at: Date;
}

// =============================================================================
// BREAKTHROUGH 4: PREDICTIVE MEMORY PRE-LOAD
// =============================================================================

export interface PredictivePreload {
  id: string;
  student_id: string;
  context: PreloadContext;
  computed_at: Date;
  expires_at: Date;
  hit_count: number;
  miss_count: number;
}

export interface PreloadContext {
  student_id: string;
  computed_at: Date;
  review_queue: string[];
  predicted_struggle: string[];
  predicted_topic: string | null;
  emotional_prep: 'frustration_mitigation' | 'normal' | 'celebration_ready';
  pre_computed_hints: Record<string, string>;
  pre_computed_analogies: Record<string, string>;
  archetype_prompt_modifier: string | null;
  predicted_session_duration_minutes?: number;
  recommended_strategies: string[];
}

export interface ConceptRetentionCurve {
  id: string;
  student_id: string;
  concept_name: string;
  first_studied_at: Date;
  last_reviewed_at: Date | null;
  review_count: number;
  optimal_interval_hours: number;
  retention_estimate: number;
  decay_rate_observed: number | null;
  next_predicted_review: Date | null;
}

// =============================================================================
// BREAKTHROUGH 5: MEMORY PALACE ORGANIZER
// =============================================================================

export type PalaceNodeType = 'wing' | 'room' | 'drawer';

export interface MemoryPalace {
  id: string;
  student_id: string;
  palace_name: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface MemoryPalaceNode {
  id: string;
  palace_id: string;
  parent_id: string | null;
  node_type: PalaceNodeType;
  name: string;
  domain?: string;
  topic?: string;
  concept?: string;
  metadata: Record<string, unknown>;
  access_count: number;
  last_accessed: Date | null;
  created_at: Date;
}

export interface MemoryPalaceContent {
  id: string;
  palace_node_id: string;
  graph_node_id: string;
  content_type: string;
  placed_at: Date;
  access_count: number;
  last_accessed: Date | null;
}

export interface MemoryPalaceTunnel {
  id: string;
  palace_id: string;
  source_node_id: string;
  target_node_id: string;
  strength: number;
  reasoning?: string;
  discovered_at: Date;
  last_validated: Date | null;
  is_active: boolean;
}

// =============================================================================
// BREAKTHROUGH 6: TOOL-MEMORY SYMBIOSIS
// =============================================================================

export interface ToolMemory {
  id: string;
  tool_name: string;
  student_id: string | null;
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  avg_latency_ms: number | null;
  optimal_params: Record<string, unknown>;
  common_failures: Array<{ failure_pattern: string; count: number; last_occurrence: string }>;
  typical_use_cases: string[];
  dependency_chains: Array<[string, string, number]>;
  last_used_at: Date | null;
  last_updated: Date;
}

export interface ToolCallMemoryLink {
  id: string;
  tool_call_id: string;
  graph_node_id: string;
  link_type: string;
  created_at: Date;
}

export interface ToolSelection {
  tool_name: string;
  params: Record<string, unknown>;
  reasoning: string;
  confidence: number;
}

export interface DTDRContext {
  initial_query: string;
  executed_tools: string[];
  intermediate_results: string[];
  student_profile_summary: string;
}

// =============================================================================
// BREAKTHROUGH 7: SLEEP MODE CONSOLIDATION
// =============================================================================

export interface ConsolidationLog {
  id: string;
  student_id: string;
  phase: string;
  items_processed: number | null;
  items_created: number | null;
  items_modified: number | null;
  items_archived: number | null;
  insights_generated: Record<string, unknown> | null;
  started_at: Date;
  completed_at: Date | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
}

export interface MemoryContradiction {
  id: string;
  student_id: string;
  attribute_key: string;
  current_fact_node_id: string | null;
  outdated_fact_node_id: string | null;
  detected_at: Date;
  resolved_at: Date | null;
  resolution_type: string | null;
  confidence: number;
}

export interface MemoryPattern {
  id: string;
  student_id: string;
  pattern_name: string;
  description: string;
  evidence_episodes: Array<Record<string, unknown>>;
  confidence: number;
  category: string | null;
  first_detected: Date;
  last_observed: Date | null;
  occurrence_count: number;
}

export interface MemoryCommunity {
  id: string;
  student_id: string;
  community_name: string | null;
  summary: string | null;
  member_count: number;
  member_node_ids: string[];
  detected_at: Date;
  llm_summary: string | null;
}

// =============================================================================
// COGNITIVE SYSTEM CONFIG
// =============================================================================

export interface CognitiveSystemConfig {
  key: string;
  value: Record<string, unknown>;
  description: string | null;
  updated_at: Date;
}

export interface CognitiveConfigMap {
  segmentation: { enabled: boolean; system1_always: boolean; system2_threshold: number };
  forgetting: { enabled: boolean; default_decay_rate: number; default_decay_temperature: number; default_retrieval_threshold: number };
  prediction: { enabled: boolean; preload_ttl_seconds: number; prediction_horizon_days: number };
  palace: { enabled: boolean; auto_construct: boolean; max_wings: number; max_rooms_per_wing: number };
  tool_memory: { enabled: boolean; learn_from_failures: boolean; dependency_tracking: boolean };
  sleep_mode: { enabled: boolean; schedule_cron: string; tick_cron?: string; local_hour?: number; timezone_aware: boolean; max_students_per_night: number; min_hours_between_runs?: number; lookback_days?: number; batch_size?: number };
  graph: { adapter: 'postgres' | 'neo4j'; neo4j_uri: string | null; neo4j_user: string | null; embedding_dimension: number };
}