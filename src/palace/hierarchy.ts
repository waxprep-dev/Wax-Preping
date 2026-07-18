/**
 * WaxPrep v3.0 — Palace Hierarchy Operations
 * Navigation, restructuring, and hierarchy maintenance.
 */

import { db } from '../db/client';
import { logger } from '../middleware/logger';
import type { MemoryPalaceNode } from '../types/cognitive';

/**
 * Get the full hierarchy for a student's palace.
 */
export async function getPalaceHierarchy(studentId: string): Promise<Array<MemoryPalaceNode & { children?: MemoryPalaceNode[] }>> {
  const result = await db.query(
    `WITH RECURSIVE hierarchy AS (
      SELECT n.*, 0 as depth, ARRAY[n.id] as path
      FROM memory_palace_nodes n
      JOIN memory_palaces p ON n.palace_id = p.id
      WHERE p.student_id = $1 AND n.parent_id IS NULL
      
      UNION ALL
      
      SELECT n.*, h.depth + 1, h.path || n.id
      FROM memory_palace_nodes n
      JOIN hierarchy h ON n.parent_id = h.id
      WHERE NOT n.id = ANY(h.path)
    )
    SELECT * FROM hierarchy ORDER BY depth, name`,
    [studentId]
  );

  const nodes = result.rows.map(r => ({
    id: r.id as string,
    palace_id: r.palace_id as string,
    parent_id: (r.parent_id as string) || null,
    node_type: r.node_type as 'wing' | 'room' | 'drawer',
    name: r.name as string,
    domain: (r.domain as string) || undefined,
    topic: (r.topic as string) || undefined,
    concept: (r.concept as string) || undefined,
    metadata: (r.metadata as Record<string, unknown>) || {},
    access_count: r.access_count as number,
    last_accessed: r.last_accessed ? new Date(r.last_accessed as string) : null,
    created_at: new Date(r.created_at as string),
    children: [] as MemoryPalaceNode[],
  }));

  // Build tree structure
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const roots: typeof nodes = [];

  for (const node of nodes) {
    if (node.parent_id && nodeMap.has(node.parent_id)) {
      const parent = nodeMap.get(node.parent_id)!;
      parent.children = parent.children || [];
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * Move a palace node to a new parent (reorganization).
 */
export async function movePalaceNode(nodeId: string, newParentId: string | null): Promise<void> {
  await db.query(
    `UPDATE memory_palace_nodes SET parent_id = $1 WHERE id = $2`,
    [newParentId, nodeId]
  );
  logger.info(`[Palace] Moved node ${nodeId} to parent ${newParentId}`);
}

/**
 * Merge two palace nodes (when AI detects they are the same concept).
 */
export async function mergePalaceNodes(keepId: string, mergeId: string): Promise<void> {
  // Move all contents from mergeId to keepId
  await db.query(
    `UPDATE memory_palace_contents SET palace_node_id = $1 WHERE palace_node_id = $2`,
    [keepId, mergeId]
  );

  // Update tunnels
  await db.query(
    `UPDATE memory_palace_tunnels SET source_node_id = $1 WHERE source_node_id = $2`,
    [keepId, mergeId]
  );
  await db.query(
    `UPDATE memory_palace_tunnels SET target_node_id = $1 WHERE target_node_id = $2`,
    [keepId, mergeId]
  );

  // Delete merged node
  await db.query(`DELETE FROM memory_palace_nodes WHERE id = $1`, [mergeId]);

  logger.info(`[Palace] Merged node ${mergeId} into ${keepId}`);
}

/**
 * Get palace statistics for a student.
 */
export async function getPalaceStats(studentId: string): Promise<{
  wings: number;
  rooms: number;
  drawers: number;
  tunnels: number;
  contents: number;
}> {
  const result = await db.query(
    `SELECT 
      COUNT(DISTINCT CASE WHEN n.node_type = 'wing' THEN n.id END) as wings,
      COUNT(DISTINCT CASE WHEN n.node_type = 'room' THEN n.id END) as rooms,
      COUNT(DISTINCT CASE WHEN n.node_type = 'drawer' THEN n.id END) as drawers,
      COUNT(DISTINCT t.id) as tunnels,
      COUNT(DISTINCT c.id) as contents
     FROM memory_palaces p
     LEFT JOIN memory_palace_nodes n ON n.palace_id = p.id
     LEFT JOIN memory_palace_tunnels t ON t.palace_id = p.id AND t.is_active = true
     LEFT JOIN memory_palace_contents c ON c.palace_node_id = n.id
     WHERE p.student_id = $1`,
    [studentId]
  );

  return {
    wings: parseInt(result.rows[0].wings as string) || 0,
    rooms: parseInt(result.rows[0].rooms as string) || 0,
    drawers: parseInt(result.rows[0].drawers as string) || 0,
    tunnels: parseInt(result.rows[0].tunnels as string) || 0,
    contents: parseInt(result.rows[0].contents as string) || 0,
  };
}