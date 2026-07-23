/**
 * WaxPrep v3.0 — Palace-Scoped Retrieval
 * Retrieve memories within a specific palace location or across tunnels.
 */

import { db } from '../db/client';
import { getGraphAdapter } from '../graph/factory';
import { logger } from '../middleware/logger';
import type { GraphNode } from '../types/cognitive';
import { cosineSimilarity } from '../cognitive/forgetting/activation';

/**
 * Retrieve all graph nodes within a palace drawer.
 */
export async function retrieveDrawerContents(drawerId: string): Promise<GraphNode[]> {
  const result = await db.query(
    `SELECT gn.* 
     FROM memory_palace_contents pc
     JOIN cognitive_graph_nodes gn ON pc.graph_node_id = gn.id
     WHERE pc.palace_node_id = $1
     ORDER BY pc.placed_at DESC`,
    [drawerId]
  );

  const graph = await getGraphAdapter();
  const nodes: GraphNode[] = [];
  for (const row of result.rows) {
    const node = await graph.getNode(row.id as string);
    if (node) nodes.push(node);
  }
  return nodes;
}

/**
 * Scoped retrieval: search only within a specific wing/room/drawer.
 */
export async function scopedPalaceSearch(
  studentId: string,
  scope: { wing?: string; room?: string; drawer?: string },
  queryEmbedding: number[],
  limit = 10
): Promise<GraphNode[]> {
  // Find palace nodes matching scope
  let palaceQuery = `
    SELECT n.id FROM memory_palace_nodes n
    JOIN memory_palaces p ON n.palace_id = p.id
    WHERE p.student_id = $1
  `;
  const params: unknown[] = [studentId];

  if (scope.wing) {
    palaceQuery += ` AND n.domain = $${params.length + 1} AND n.node_type = 'wing'`;
    params.push(scope.wing.toLowerCase());
  }
  if (scope.room) {
    palaceQuery += ` AND n.topic = $${params.length + 1} AND n.node_type = 'room'`;
    params.push(scope.room.toLowerCase());
  }
  if (scope.drawer) {
    palaceQuery += ` AND n.concept = $${params.length + 1} AND n.node_type = 'drawer'`;
    params.push(scope.drawer.toLowerCase());
  }

  const palaceResult = await db.query(palaceQuery, params);
  const nodeIds = palaceResult.rows.map(r => r.id as string);

  if (nodeIds.length === 0) return [];

  // Get all graph nodes in these palace nodes
  const contentsResult = await db.query(
    `SELECT graph_node_id FROM memory_palace_contents
     WHERE palace_node_id = ANY($1)`,
    [nodeIds]
  );

  const graphNodeIds = contentsResult.rows.map(r => r.graph_node_id as string);
  if (graphNodeIds.length === 0) return [];

  // Get actual graph nodes and rank by embedding similarity
  const graph = await getGraphAdapter();
  const nodes: GraphNode[] = [];
  for (const id of graphNodeIds) {
    const node = await graph.getNode(id);
    if (node) nodes.push(node);
  }

  // Rank by similarity
  return nodes
    .filter(n => n.embedding)
    .map(n => ({
      node: n,
      similarity: cosineSimilarity(queryEmbedding, n.embedding!),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit)
    .map(r => r.node);
}

/**
 * Progressive loading: load palace overview at different levels.
 * L0 = Palace overview (archetype, recent activity)
 * L1 = Wing summaries (subject-level mastery)
 * L2 = Room details (topic-level progress)
 * L3 = Drawer contents (specific episodes and facts)
 */
export async function progressivePalaceLoad(
  studentId: string,
  level: 0 | 1 | 2 | 3
): Promise<Record<string, unknown>> {
  const palace = await db.query(
    `SELECT * FROM memory_palaces WHERE student_id = $1 LIMIT 1`,
    [studentId]
  );

  if (palace.rows.length === 0) return { error: 'No palace found' };

  const palaceId = palace.rows[0].id;

  if (level === 0) {
    // Overview: wings + recent activity
    const wings = await db.query(
      `SELECT name, domain, access_count, last_accessed 
       FROM memory_palace_nodes 
       WHERE palace_id = $1 AND node_type = 'wing'
       ORDER BY access_count DESC`,
      [palaceId]
    );
    return {
      palace_name: palace.rows[0].palace_name,
      wings: wings.rows,
    };
  }

  if (level === 1) {
    // Wing summaries with room counts
    const result = await db.query(
      `SELECT 
        w.name as wing_name,
        w.domain,
        COUNT(DISTINCT r.id) as room_count,
        COUNT(DISTINCT d.id) as drawer_count
       FROM memory_palace_nodes w
       LEFT JOIN memory_palace_nodes r ON r.parent_id = w.id AND r.node_type = 'room'
       LEFT JOIN memory_palace_nodes d ON d.parent_id = r.id AND d.node_type = 'drawer'
       WHERE w.palace_id = $1 AND w.node_type = 'wing'
       GROUP BY w.id, w.name, w.domain
       ORDER BY w.access_count DESC`,
      [palaceId]
    );
    return { wings: result.rows };
  }

  if (level === 2) {
    // Room details with mastery estimates
    const result = await db.query(
      `SELECT 
        r.name as room_name,
        r.topic,
        COUNT(DISTINCT d.id) as drawer_count,
        COUNT(DISTINCT pc.id) as content_count
       FROM memory_palace_nodes r
       LEFT JOIN memory_palace_nodes d ON d.parent_id = r.id AND d.node_type = 'drawer'
       LEFT JOIN memory_palace_contents pc ON pc.palace_node_id = d.id
       WHERE r.palace_id = $1 AND r.node_type = 'room'
       GROUP BY r.id, r.name, r.topic
       ORDER BY r.access_count DESC`,
      [palaceId]
    );
    return { rooms: result.rows };
  }

  // Level 3: Drawer contents
  const drawers = await db.query(
    `SELECT 
      d.id,
      d.name as drawer_name,
      d.concept,
      COUNT(pc.id) as content_count
     FROM memory_palace_nodes d
     LEFT JOIN memory_palace_contents pc ON pc.palace_node_id = d.id
     WHERE d.palace_id = $1 AND d.node_type = 'drawer'
     GROUP BY d.id, d.name, d.concept
     ORDER BY d.access_count DESC
     LIMIT 50`,
    [palaceId]
  );


  return { drawers: drawers.rows };
}
