/**
 * WaxPrep v3.0 — Graph Layer Type Definitions
 * Abstract types used by all graph adapters.
 */

import type { GraphNode, GraphEdge, GraphPath, GraphNodeLabel } from '../types/cognitive';

export { GraphNode, GraphEdge, GraphPath, GraphNodeLabel };

export interface NodeCreateInput {
  labels: GraphNodeLabel[];
  properties: Record<string, unknown>;
  embedding?: number[];
  event_time?: Date;
  validity_window?: [Date | null, Date | null];
  student_id?: string;
  source?: string;
}

export interface EdgeCreateInput {
  source_id: string;
  target_id: string;
  type: string;
  properties?: Record<string, unknown>;
  event_time?: Date;
  validity_window?: [Date | null, Date | null];
  student_id?: string;
}

export interface TraversalOptions {
  edgeTypes?: string[];
  maxDepth?: number;
  direction?: 'out' | 'in' | 'both';
  nodeFilter?: Record<string, unknown>;
  timeRange?: [Date, Date];
}

export interface SimilaritySearchOptions {
  embedding: number[];
  limit?: number;
  studentId?: string;
  nodeLabels?: string[];
  minSimilarity?: number;
}

export interface BiTemporalQueryOptions {
  nodeLabel: string;
  studentId: string;
  atTime: Date;
  additionalFilters?: Record<string, unknown>;
}