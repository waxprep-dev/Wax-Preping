/**
 * WaxPrep v3.0 — PostgreSQL-Native Graph Adapter
 * Implements the GraphAdapter interface using PostgreSQL + pgvector + JSONB + recursive CTEs.
 * Zero new infrastructure required. Handles embeddings, bi-temporal validity, and traversal.
 */

import { db } from '../db/client';
import { logger } from '../middleware/logger';
import type { GraphAdapter } from './interfaces';
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

export class PostgresGraphAdapter implements GraphAdapter {
  readonly name = 'postgres';

  async connect(): Promise<void> {
    // PostgreSQL is already connected via db pool
    logger.info('[PostgresGraph] Adapter ready');
  }

  async disconnect(): Promise<void> {
    // Pool managed externally
  }

  async healthCheck(): Promise<boolean> {
    try {
      await db.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // NODES
  // ===========================================================================

  async createNode(input: NodeCreateInput): Promise<GraphNode> {
    const embeddingStr = input.embedding ? `[${input.embedding.join(',')}]` : null;
    const validityStr = input.validity_window
      ? `[${input.validity_window[0]?.toISOString() || ''}, ${input.validity_window[1]?.toISOString() || ''})`
      : null;

    const result = await db.query(
      `INSERT INTO cognitive_graph_nodes (labels, properties, embedding, event_time, validity_window, student_id, source)
       VALUES ($1, $2, $3::vector, $4, $5::tstzrange, $6, $7)
       RETURNING *`,
      [
        input.labels,
        JSON.stringify(input.properties),
        embeddingStr,
        input.event_time || new Date(),
        validityStr,
        input.student_id || null,
        input.source || 'system',
      ]
    );

    return this.mapNode(result.rows[0]);
  }

  async createNodes(inputs: NodeCreateInput[]): Promise<GraphNode[]> {
    const nodes: GraphNode[] = [];
    for (const input of inputs) {
      nodes.push(await this.createNode(input));
    }
    return nodes;
  }

  async getNode(id: string): Promise<GraphNode | null> {
    const result = await db.query(`SELECT * FROM cognitive_graph_nodes WHERE id = $1`, [id]);
    if (result.rows.length === 0) return null;
    return this.mapNode(result.rows[0]);
  }

  async updateNode(id: string, updates: Partial<GraphNode>): Promise<GraphNode> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (updates.labels) {
      sets.push(`labels = $${idx++}`);
      values.push(updates.labels);
    }
    if (updates.properties) {
      sets.push(`properties = $${idx++}`);
      values.push(JSON.stringify(updates.properties));
    }
    if (updates.embedding) {
      sets.push(`embedding = $${idx++}::vector`);
      values.push(`[${updates.embedding.join(',')}]`);
    }
    if (updates.validity_window) {
      sets.push(`validity_window = $${idx++}::tstzrange`);
      values.push(
        `[${updates.validity_window[0]?.toISOString() || ''}, ${updates.validity_window[1]?.toISOString() || ''})`
      );
    }

    values.push(id);
    const result = await db.query(
      `UPDATE cognitive_graph_nodes SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    return this.mapNode(result.rows[0]);
  }

  async deleteNode(id: string): Promise<void> {
    await db.query(`DELETE FROM cognitive_graph_nodes WHERE id = $1`, [id]);
  }

  async searchNodes(filters: Record<string, unknown>, limit = 50): Promise<GraphNode[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, val] of Object.entries(filters)) {
      if (key === 'labels' && Array.isArray(val)) {
        conditions.push(`labels && $${idx++}`);
        values.push(val);
      } else if (key === 'student_id') {
        conditions.push(`student_id = $${idx++}`);
        values.push(val);
      } else {
        conditions.push(`properties @> $${idx++}`);
        values.push(JSON.stringify({ [key]: val }));
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await db.query(
      `SELECT * FROM cognitive_graph_nodes ${whereClause} LIMIT $${idx}`,
      [...values, limit]
    );

    return result.rows.map(r => this.mapNode(r));
  }

  // ===========================================================================
  // EDGES
  // ===========================================================================

  async createEdge(input: EdgeCreateInput): Promise<GraphEdge> {
    const validityStr = input.validity_window
      ? `[${input.validity_window[0]?.toISOString() || ''}, ${input.validity_window[1]?.toISOString() || ''})`
      : null;

    const result = await db.query(
      `INSERT INTO cognitive_graph_edges (source_id, target_id, type, properties, event_time, validity_window, student_id)
       VALUES ($1, $2, $3, $4, $5, $6::tstzrange, $7)
       RETURNING *`,
      [
        input.source_id,
        input.target_id,
        input.type,
        JSON.stringify(input.properties || {}),
        input.event_time || new Date(),
        validityStr,
        input.student_id || null,
      ]
    );

    const edge = this.mapEdge(result.rows[0]);
    await this.updateAdjacency(edge);
    return edge;
  }

  async createEdges(inputs: EdgeCreateInput[]): Promise<GraphEdge[]> {
    const edges: GraphEdge[] = [];
    for (const input of inputs) {
      edges.push(await this.createEdge(input));
    }
    return edges;
  }

  async getEdge(id: string): Promise<GraphEdge | null> {
    const result = await db.query(`SELECT * FROM cognitive_graph_edges WHERE id = $1`, [id]);
    if (result.rows.length === 0) return null;
    return this.mapEdge(result.rows[0]);
  }

  async getEdges(nodeId: string, direction: 'out' | 'in' | 'both', type?: string): Promise<GraphEdge[]> {
    let query: string;
    const params: unknown[] = [nodeId];

    if (direction === 'out') {
      query = `SELECT * FROM cognitive_graph_edges WHERE source_id = $1`;
    } else if (direction === 'in') {
      query = `SELECT * FROM cognitive_graph_edges WHERE target_id = $1`;
    } else {
      query = `SELECT * FROM cognitive_graph_edges WHERE source_id = $1 OR target_id = $1`;
    }

    if (type) {
      query += ` AND type = $${params.length + 1}`;
      params.push(type);
    }

    const result = await db.query(query, params);
    return result.rows.map(r => this.mapEdge(r));
  }

  async updateEdge(id: string, updates: Partial<GraphEdge>): Promise<GraphEdge> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (updates.properties) {
      sets.push(`properties = $${idx++}`);
      values.push(JSON.stringify(updates.properties));
    }
    if (updates.validity_window) {
      sets.push(`validity_window = $${idx++}::tstzrange`);
      values.push(
        `[${updates.validity_window[0]?.toISOString() || ''}, ${updates.validity_window[1]?.toISOString() || ''})`
      );
    }

    values.push(id);
    const result = await db.query(
      `UPDATE cognitive_graph_edges SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    return this.mapEdge(result.rows[0]);
  }

  async invalidateEdge(id: string, reason?: string): Promise<void> {
    await db.query(
      `UPDATE cognitive_graph_edges 
       SET validity_window = tstzrange(lower(validity_window), NOW()),
           properties = properties || $1::jsonb
       WHERE id = $2`,
      [JSON.stringify({ invalidated_at: new Date().toISOString(), invalidation_reason: reason || 'superseded' }), id]
    );
  }

  async deleteEdge(id: string): Promise<void> {
    await db.query(`DELETE FROM cognitive_graph_edges WHERE id = $1`, [id]);
    await db.query(`DELETE FROM cognitive_graph_adjacency WHERE edge_id = $1`, [id]);
  }

  // ===========================================================================
  // TRAVERSAL (Recursive CTEs)
  // ===========================================================================

  async traverse(startNodeId: string, options: TraversalOptions): Promise<GraphPath[]> {
    const { edgeTypes = [], maxDepth = 3, direction = 'out' } = options;
    const edgeTypeFilter = edgeTypes.length > 0 ? `AND e.type = ANY($3)` : '';

    let directionFilter: string;
    if (direction === 'out') {
      directionFilter = `e.source_id = n.id`;
    } else if (direction === 'in') {
      directionFilter = `e.target_id = n.id`;
    } else {
      directionFilter = `(e.source_id = n.id OR e.target_id = n.id)`;
    }

    const result = await db.query(
      `
      WITH RECURSIVE traversal(path, node_ids, depth, last_node) AS (
        SELECT 
          ARRAY[$1::uuid] as path,
          ARRAY[$1::uuid] as node_ids,
          0 as depth,
          $1::uuid as last_node
        
        UNION ALL
        
        SELECT 
          t.path || e.id,
          t.node_ids || CASE 
            WHEN e.source_id = t.last_node THEN e.target_id 
            ELSE e.source_id 
          END,
          t.depth + 1,
          CASE 
            WHEN e.source_id = t.last_node THEN e.target_id 
            ELSE e.source_id 
          END
        FROM traversal t
        JOIN cognitive_graph_edges e ON ${directionFilter}
        WHERE t.depth < $2
          AND (e.validity_window IS NULL OR e.validity_window @> NOW())
          ${edgeTypeFilter}
          AND NOT (CASE 
            WHEN e.source_id = t.last_node THEN e.target_id 
            ELSE e.source_id 
          END = ANY(t.node_ids))
      )
      SELECT * FROM traversal WHERE depth > 0 ORDER BY depth LIMIT 1000
      `,
      edgeTypes.length > 0 ? [startNodeId, maxDepth, edgeTypes] : [startNodeId, maxDepth]
    );

    const paths: GraphPath[] = [];
    for (const row of result.rows) {
      const nodeIds = row.node_ids as string[];
      const nodeResults = await db.query(
        `SELECT * FROM cognitive_graph_nodes WHERE id = ANY($1)`,
        [nodeIds]
      );
      const edgeResults = await db.query(
        `SELECT * FROM cognitive_graph_edges WHERE id = ANY($1)`,
        [row.path as string[]]
      );

      const nodeMap = new Map(nodeResults.rows.map(r => [r.id, this.mapNode(r)]));
      const edgeMap = new Map(edgeResults.rows.map(r => [r.id, this.mapEdge(r)]));

      const orderedNodes = nodeIds.map(id => nodeMap.get(id)).filter(Boolean) as GraphNode[];
      const orderedEdges = (row.path as string[]).map(id => edgeMap.get(id)).filter(Boolean) as GraphEdge[];

      paths.push({ nodes: orderedNodes, edges: orderedEdges, length: orderedEdges.length });
    }

    return paths;
  }

  async shortestPath(startNodeId: string, endNodeId: string, edgeTypes?: string[]): Promise<GraphPath | null> {
    const edgeTypeFilter = edgeTypes && edgeTypes.length > 0 ? `AND e.type = ANY($3)` : '';

    const result = await db.query(
      `
      WITH RECURSIVE path_finder(path, node_ids, depth, last_node, found) AS (
        SELECT 
          ARRAY[]::uuid[] as path,
          ARRAY[$1::uuid] as node_ids,
          0 as depth,
          $1::uuid as last_node,
          false as found
        
        UNION ALL
        
        SELECT 
          t.path || e.id,
          t.node_ids || e.target_id,
          t.depth + 1,
          e.target_id,
          e.target_id = $2::uuid
        FROM path_finder t
        JOIN cognitive_graph_edges e ON e.source_id = t.last_node
        WHERE t.depth < 10
          AND NOT t.found
          AND (e.validity_window IS NULL OR e.validity_window @> NOW())
          ${edgeTypeFilter}
          AND NOT e.target_id = ANY(t.node_ids)
      )
      SELECT path, node_ids, depth FROM path_finder 
      WHERE found = true 
      ORDER BY depth 
      LIMIT 1
      `,
      edgeTypes && edgeTypes.length > 0 ? [startNodeId, endNodeId, edgeTypes] : [startNodeId, endNodeId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const nodeIds = row.node_ids as string[];
    const nodeResults = await db.query(
      `SELECT * FROM cognitive_graph_nodes WHERE id = ANY($1)`,
      [nodeIds]
    );
    const edgeResults = await db.query(
      `SELECT * FROM cognitive_graph_edges WHERE id = ANY($1)`,
      [row.path as string[]]
    );

    const nodeMap = new Map(nodeResults.rows.map(r => [r.id, this.mapNode(r)]));
    const edgeMap = new Map(edgeResults.rows.map(r => [r.id, this.mapEdge(r)]));

    const orderedNodes = nodeIds.map(id => nodeMap.get(id)).filter(Boolean) as GraphNode[];
    const orderedEdges = (row.path as string[]).map(id => edgeMap.get(id)).filter(Boolean) as GraphEdge[];

    return { nodes: orderedNodes, edges: orderedEdges, length: orderedEdges.length };
  }

  // ===========================================================================
  // ADVANCED QUERIES
  // ===========================================================================

  async findSimilar(options: SimilaritySearchOptions): Promise<GraphNode[]> {
    const { embedding, limit = 10, studentId, nodeLabels, minSimilarity = 0.25 } = options;
    const embeddingStr = `[${embedding.join(',')}]`;

    let query = `
      SELECT *, 1 - (embedding <=> $1::vector) AS similarity
      FROM cognitive_graph_nodes
      WHERE embedding IS NOT NULL
    `;
    const params: unknown[] = [embeddingStr];

    if (studentId) {
      query += ` AND student_id = $${params.length + 1}`;
      params.push(studentId);
    }

    if (nodeLabels && nodeLabels.length > 0) {
      query += ` AND labels && $${params.length + 1}`;
      params.push(nodeLabels);
    }

    query += ` ORDER BY embedding <=> $1::vector LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await db.query(query, params);
    return result.rows
      .filter((r: Record<string, unknown>) => (r.similarity as number) >= minSimilarity)
      .map(r => this.mapNode(r));
  }

  async queryBiTemporal(options: BiTemporalQueryOptions): Promise<GraphNode[]> {
    const { nodeLabel, studentId, atTime, additionalFilters } = options;

    let query = `
      SELECT * FROM cognitive_graph_nodes
      WHERE $1 = ANY(labels)
        AND student_id = $2
        AND (validity_window IS NULL OR validity_window @> $3::timestamptz)
        AND event_time <= $3::timestamptz
    `;
    const params: unknown[] = [nodeLabel, studentId, atTime];

    if (additionalFilters) {
      for (const [key, val] of Object.entries(additionalFilters)) {
        query += ` AND properties @> $${params.length + 1}::jsonb`;
        params.push(JSON.stringify({ [key]: val }));
      }
    }

    query += ` ORDER BY event_time DESC`;

    const result = await db.query(query, params);
    return result.rows.map(r => this.mapNode(r));
  }

  // ===========================================================================
  // BATCH
  // ===========================================================================

  async executeBatch<T>(operations: Array<() => Promise<T>>): Promise<T[]> {
    const results: T[] = [];
    for (const op of operations) {
      results.push(await op());
    }
    return results;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private async updateAdjacency(edge: GraphEdge): Promise<void> {
    await db.query(
      `INSERT INTO cognitive_graph_adjacency (node_id, edge_id, direction, neighbor_id, edge_type)
       VALUES ($1, $2, 'out', $3, $4),
              ($3, $2, 'in', $1, $4)
       ON CONFLICT DO NOTHING`,
      [edge.source_id, edge.id, edge.target_id, edge.type]
    );
  }

  private mapNode(row: Record<string, unknown>): GraphNode {
    return {
      id: row.id as string,
      labels: (row.labels as string[]) || [],
      properties: (row.properties as Record<string, unknown>) || {},
      embedding: row.embedding ? JSON.parse(`[${(row.embedding as string).slice(1, -1)}]`) : undefined,
      event_time: new Date(row.event_time as string),
      ingest_time: new Date(row.ingest_time as string),
      validity_window: row.validity_window
        ? [
            (row.validity_window as unknown as { lower: Date | null }).lower,
            (row.validity_window as unknown as { upper: Date | null }).upper,
          ]
        : undefined,
      student_id: (row.student_id as string) || undefined,
      source: (row.source as string) || undefined,
      created_at: new Date(row.created_at as string),
    };
  }

  private mapEdge(row: Record<string, unknown>): GraphEdge {
    return {
      id: row.id as string,
      source_id: row.source_id as string,
      target_id: row.target_id as string,
      type: row.type as string,
      properties: (row.properties as Record<string, unknown>) || {},
      event_time: new Date(row.event_time as string),
      ingest_time: new Date(row.ingest_time as string),
      validity_window: row.validity_window
        ? [
            (row.validity_window as unknown as { lower: Date | null }).lower,
            (row.validity_window as unknown as { upper: Date | null }).upper,
          ]
        : undefined,
      student_id: (row.student_id as string) || undefined,
      created_at: new Date(row.created_at as string),
    };
  }
}