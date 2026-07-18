/**
 * WaxPrep v3.0 — GraphAdapter Interface
 * The contract that ALL graph implementations must fulfill.
 * This abstraction allows seamless swapping between PostgreSQL and Neo4j.
 */

import type {
  GraphNode,
  GraphEdge,
  GraphPath,
  NodeCreateInput,
  EdgeCreateInput,
  TraversalOptions,
  SimilaritySearchOptions,
  BiTemporalQueryOptions,
} from './types';

export interface GraphAdapter {
  readonly name: string;

  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<boolean>;

  // Node operations
  createNode(input: NodeCreateInput): Promise<GraphNode>;
  createNodes(inputs: NodeCreateInput[]): Promise<GraphNode[]>;
  getNode(id: string): Promise<GraphNode | null>;
  updateNode(id: string, updates: Partial<GraphNode>): Promise<GraphNode>;
  deleteNode(id: string): Promise<void>;
  searchNodes(filters: Record<string, unknown>, limit?: number): Promise<GraphNode[]>;

  // Edge operations
  createEdge(input: EdgeCreateInput): Promise<GraphEdge>;
  createEdges(inputs: EdgeCreateInput[]): Promise<GraphEdge[]>;
  getEdge(id: string): Promise<GraphEdge | null>;
  getEdges(nodeId: string, direction: 'out' | 'in' | 'both', type?: string): Promise<GraphEdge[]>;
  updateEdge(id: string, updates: Partial<GraphEdge>): Promise<GraphEdge>;
  invalidateEdge(id: string, reason?: string): Promise<void>;
  deleteEdge(id: string): Promise<void>;

  // Traversal
  traverse(startNodeId: string, options: TraversalOptions): Promise<GraphPath[]>;
  shortestPath(startNodeId: string, endNodeId: string, edgeTypes?: string[]): Promise<GraphPath | null>;

  // Advanced queries
  findSimilar(options: SimilaritySearchOptions): Promise<GraphNode[]>;
  queryBiTemporal(options: BiTemporalQueryOptions): Promise<GraphNode[]>;

  // Batch operations
  executeBatch<T>(operations: Array<() => Promise<T>>): Promise<T[]>;
}