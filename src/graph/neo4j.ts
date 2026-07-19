/**
 * WaxPrep v3.0 — Neo4j Graph Adapter
 * Implements the GraphAdapter interface for Neo4j.
 *
 * This adapter is loaded dynamically via the factory. The neo4j-driver
 * package is NOT included in the default dependencies. To use Neo4j:
 *
 *   npm install neo4j-driver
 *
 * Then set NEO4J_URI in your environment and update cognitive_system_config
 * to use adapter: 'neo4j'.
 */

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
import { logger } from '../middleware/logger';

export class Neo4jGraphAdapter implements GraphAdapter {
  readonly name = 'neo4j';
  private driver: unknown | null = null;
  private connected = false;

  async connect(): Promise<void> {
    try {
      // Dynamic import — neo4j-driver is an optional runtime dependency
      const neo4j = await import('neo4j-driver').catch((err) => {
        logger.error({ err }, '[Neo4jGraph] Failed to load neo4j-driver');
        throw new Error(
          'neo4j-driver is not installed. Run: npm install neo4j-driver'
        );
      });

      const uri = process.env.NEO4J_URI;
      const user = process.env.NEO4J_USER || 'neo4j';
      const password = process.env.NEO4J_PASSWORD;

      if (!uri) {
        throw new Error('NEO4J_URI not configured');
      }

      this.driver = neo4j.default.driver(uri, neo4j.default.auth.basic(user, password));
      await (this.driver as { verifyConnectivity: () => Promise<unknown> }).verifyConnectivity();
      this.connected = true;
      logger.info('[Neo4jGraph] Connected');
    } catch (err) {
      logger.error({ err }, '[Neo4jGraph] Connection failed');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.driver) {
      await (this.driver as { close: () => Promise<void> }).close();
      this.connected = false;
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.connected || !this.driver) return false;
    try {
      const session = (this.driver as { session: () => unknown }).session();
      await (session as { run: (q: string) => Promise<unknown> }).run('RETURN 1');
      await (session as { close: () => Promise<void> }).close();
      return true;
    } catch {
      return false;
    }
  }

  async createNode(input: NodeCreateInput): Promise<GraphNode> {
    if (!this.driver) throw new Error('Neo4j not connected');
    const labels = input.labels.join(':');
    const session = (this.driver as { session: () => unknown }).session();
    try {
      const result = await (session as { run: (q: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }> }).run(
        `CREATE (n:${labels} $props) RETURN n`,
        { props: { ...input.properties, _embedding: input.embedding, _student_id: input.student_id, _source: input.source, _event_time: input.event_time?.toISOString() } }
      );
      const record = result.records[0].get('n') as Record<string, unknown>;
      return this.mapNeo4jNode(record);
    } finally {
      await (session as { close: () => Promise<void> }).close();
    }
  }

  async createNodes(inputs: NodeCreateInput[]): Promise<GraphNode[]> {
    const nodes: GraphNode[] = [];
    for (const input of inputs) {
      nodes.push(await this.createNode(input));
    }
    return nodes;
  }

  async getNode(id: string): Promise<GraphNode | null> {
    if (!this.driver) throw new Error('Neo4j not connected');
    const session = (this.driver as { session: () => unknown }).session();
    try {
      const result = await (session as { run: (q: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }> }).run(
        `MATCH (n) WHERE n.id = $id RETURN n`,
        { id }
      );
      if (result.records.length === 0) return null;
      return this.mapNeo4jNode(result.records[0].get('n') as Record<string, unknown>);
    } finally {
      await (session as { close: () => Promise<void> }).close();
    }
  }

  async updateNode(id: string, updates: Partial<GraphNode>): Promise<GraphNode> {
    if (!this.driver) throw new Error('Neo4j not connected');
    const session = (this.driver as { session: () => unknown }).session();
    try {
      const setClauses: string[] = [];
      const params: Record<string, unknown> = { id };
      if (updates.properties) {
        setClauses.push('n += $props');
        params.props = updates.properties;
      }
      const result = await (session as { run: (q: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }> }).run(
        `MATCH (n) WHERE n.id = $id SET ${setClauses.join(', ')} RETURN n`,
        params
      );
      return this.mapNeo4jNode(result.records[0].get('n') as Record<string, unknown>);
    } finally {
      await (session as { close: () => Promise<void> }).close();
    }
  }

  async deleteNode(id: string): Promise<void> {
    if (!this.driver) throw new Error('Neo4j not connected');
    const session = (this.driver as { session: () => unknown }).session();
    try {
      await (session as { run: (q: string, p: Record<string, unknown>) => Promise<unknown> }).run(
        `MATCH (n) WHERE n.id = $id DETACH DELETE n`,
        { id }
      );
    } finally {
      await (session as { close: () => Promise<void> }).close();
    }
  }

  async searchNodes(filters: Record<string, unknown>, limit = 50): Promise<GraphNode[]> {
    if (!this.driver) throw new Error('Neo4j not connected');
    const session = (this.driver as { session: () => unknown }).session();
    try {
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(filters)) {
        conditions.push(`n.${key} = $${key}`);
        params[key] = val;
      }
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const result = await (session as { run: (q: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }> }).run(
        `MATCH (n) ${whereClause} RETURN n LIMIT $limit`,
        { ...params, limit }
      );
      return result.records.map(r => this.mapNeo4jNode(r.get('n') as Record<string, unknown>));
    } finally {
      await (session as { close: () => Promise<void> }).close();
    }
  }

  async createEdge(input: EdgeCreateInput): Promise<GraphEdge> {
    if (!this.driver) throw new Error('Neo4j not connected');
    const session = (this.driver as { session: () => unknown }).session();
    try {
      const result = await (session as { run: (q: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }> }).run(
        `MATCH (a) WHERE a.id = $sourceId
         MATCH (b) WHERE b.id = $targetId
         CREATE (a)-[r:${input.type} $props]->(b)
         RETURN r, a.id as source_id, b.id as target_id`,
        {
          sourceId: input.source_id,
          targetId: input.target_id,
          props: { ...input.properties, _student_id: input.student_id, _event_time: input.event_time?.toISOString() },
        }
      );
      const record = result.records[0];
      return this.mapNeo4jEdge(record.get('r') as Record<string, unknown>, input.source_id, input.target_id);
    } finally {
      await (session as { close: () => Promise<void> }).close();
    }
  }

  async createEdges(inputs: EdgeCreateInput[]): Promise<GraphEdge[]> {
    const edges: GraphEdge[] = [];
    for (const input of inputs) {
      edges.push(await this.createEdge(input));
    }
    return edges;
  }

  async getEdge(id: string): Promise<GraphEdge | null> {
    if (!this.driver) throw new Error('Neo4j not connected');
    const session = (this.driver as { session: () => unknown }).session();
    try {
      const result = await (session as { run: (q: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }> }).run(
        `MATCH ()-[r]->() WHERE r._id = $id RETURN r, startNode(r).id as source_id, endNode(r).id as target_id`,
        { id }
      );
      if (result.records.length === 0) return null;
      const record = result.records[0];
      return this.mapNeo4jEdge(
        record.get('r') as Record<string, unknown>,
        record.get('source_id') as string,
        record.get('target_id') as string
      );
    } finally {
      await (session as { close: () => Promise<void> }).close();
    }
  }

  async getEdges(nodeId: string, direction: 'out' | 'in' | 'both', type?: string): Promise<GraphEdge[]> {
    if (!this.driver) throw new Error('Neo4j not connected');
    const session = (this.driver as { session: () => unknown }).session();
    try {
      let query: string;
      if (direction === 'out') {
        query = `MATCH (n)-[r${type ? `:${type}` : ''}]->(m) WHERE n.id = $id RETURN r, n.id as source_id, m.id as target_id`;
      } else if (direction === 'in') {
        query = `MATCH (n)<-[r${type ? `:${type}` : ''}]-(m) WHERE n.id = $id RETURN r, m.id as source_id, n.id as target_id`;
      } else {
        query = `MATCH (n)-[r${type ? `:${type}` : ''}]-(m) WHERE n.id = $id RETURN r, startNode(r).id as source_id, endNode(r).id as target_id`;
      }
      const result = await (session as { run: (q: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }> }).run(query, { id: nodeId });
      return result.records.map(r => {
        const props = r.get('r') as Record<string, unknown>;
        return this.mapNeo4jEdge(props, r.get('source_id') as string, r.get('target_id') as string);
      });
    } finally {
      await (session as { close: () => Promise<void> }).close();
    }
  }

  async traverse(options: TraversalOptions): Promise<GraphPath[]> {
    if (!this.driver) throw new Error('Neo4j not connected');
    const session = (this.driver as { session: () => unknown }).session();
    try {
      const typeFilter = options.edgeType ? `:${options.edgeType}` : '';
      const maxDepth = options.maxDepth || 3;
      const result = await (session as { run: (q: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }> }).run(
        `MATCH path = (start)-[r${typeFilter}*1..${maxDepth}]-(end)
         WHERE start.id = $startNodeId
         RETURN path
         LIMIT $limit`,
        { startNodeId: options.startNodeId, limit: options.limit || 50 }
      );
      return result.records.map(r => {
        const path = r.get('path') as Record<string, unknown>;
        return this.mapNeo4jPath(path);
      });
    } finally {
      await (session as { close: () => Promise<void> }).close();
    }
  }

  async similaritySearch(options: SimilaritySearchOptions): Promise<GraphNode[]> {
    if (!this.driver) throw new Error('Neo4j not connected');
    const session = (this.driver as { session: () => unknown }).session();
    try {
      const result = await (session as { run: (q: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }> }).run(
        `MATCH (n) WHERE n._student_id = $studentId
         RETURN n
         LIMIT $limit`,
        { studentId: options.studentId, limit: options.limit || 10 }
      );
      return result.records.map(r => this.mapNeo4jNode(r.get('n') as Record<string, unknown>));
    } finally {
      await (session as { close: () => Promise<void> }).close();
    }
  }

  async biTemporalQuery(options: BiTemporalQueryOptions): Promise<GraphNode[]> {
    if (!this.driver) throw new Error('Neo4j not connected');
    const session = (this.driver as { session: () => unknown }).session();
    try {
      const result = await (session as { run: (q: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }> }).run(
        `MATCH (n)
         WHERE n._event_time >= $start AND n._event_time <= $end
         RETURN n
         LIMIT $limit`,
        { start: options.startTime.toISOString(), end: options.endTime.toISOString(), limit: options.limit || 50 }
      );
      return result.records.map(r => this.mapNeo4jNode(r.get('n') as Record<string, unknown>));
    } finally {
      await (session as { close: () => Promise<void> }).close();
    }
  }

  private mapNeo4jNode(record: Record<string, unknown>): GraphNode {
    const props = (record.properties || record) as Record<string, unknown>;
    return {
      id: (props.id as string) || (props._id as string) || '',
      labels: (props.labels as string[]) || (record.labels as string[]) || [],
      properties: props,
      embedding: props._embedding as number[] | undefined,
      student_id: props._student_id as string | undefined,
      source: props._source as string | undefined,
      event_time: props._event_time ? new Date(props._event_time as string) : undefined,
      created_at: new Date(),
    };
  }

  private mapNeo4jEdge(record: Record<string, unknown>, sourceId: string, targetId: string): GraphEdge {
    const props = (record.properties || record) as Record<string, unknown>;
    return {
      id: (props._id as string) || '',
      source_id: sourceId,
      target_id: targetId,
      type: (props.type as string) || 'RELATED_TO',
      properties: props,
      student_id: props._student_id as string | undefined,
      event_time: props._event_time ? new Date(props._event_time as string) : undefined,
      created_at: new Date(),
    };
  }

  private mapNeo4jPath(path: Record<string, unknown>): GraphPath {
    const segments = (path.segments as Array<Record<string, unknown>>) || [];
    return {
      nodes: segments.map(s => this.mapNeo4jNode((s.start as Record<string, unknown>) || {})),
      edges: segments.map(s => this.mapNeo4jEdge((s.relationship as Record<string, unknown>) || {}, '', '')),
      length: segments.length,
    };
  }
}
