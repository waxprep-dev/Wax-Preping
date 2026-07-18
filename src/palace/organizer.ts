/**
 * WaxPrep v3.0 — Memory Palace Organizer
 * Dynamically constructs and manages spatial memory hierarchies.
 * No hardcoded palace layouts. Everything is AI-generated per student.
 */

import { getGraphAdapter } from '../graph/factory';
import { routeAndCall } from '../llm/router';
import { logger } from '../middleware/logger';
import { db } from '../db/client';
import type { MemoryPalace, MemoryPalaceNode, MemoryPalaceTunnel } from '../types/cognitive';

/**
 * Ensure a student has a memory palace. Creates one if missing.
 */
export async function ensurePalace(studentId: string): Promise<MemoryPalace> {
  const result = await db.query(
    `SELECT * FROM memory_palaces WHERE student_id = $1 LIMIT 1`,
    [studentId]
  );

  if (result.rows.length > 0) {
    return mapPalace(result.rows[0]);
  }

  // Create new palace
  const insert = await db.query(
    `INSERT INTO memory_palaces (student_id, palace_name, metadata)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [studentId, 'Learning Universe', JSON.stringify({ created_by: 'system', auto_construct: true })]
  );

  logger.info(`[Palace] Created palace for ${studentId}`);
  return mapPalace(insert.rows[0]);
}

/**
 * Add a wing to the palace (subject domain).
 */
export async function addWing(
  studentId: string,
  name: string,
  domain: string,
  metadata?: Record<string, unknown>
): Promise<MemoryPalaceNode> {
  const palace = await ensurePalace(studentId);

  // Check if wing already exists
  const existing = await db.query(
    `SELECT * FROM memory_palace_nodes 
     WHERE palace_id = $1 AND node_type = 'wing' AND domain = $2
     LIMIT 1`,
    [palace.id, domain]
  );

  if (existing.rows.length > 0) {
    return mapPalaceNode(existing.rows[0]);
  }

  const result = await db.query(
    `INSERT INTO memory_palace_nodes (palace_id, node_type, name, domain, metadata)
     VALUES ($1, 'wing', $2, $3, $4)
     RETURNING *`,
    [palace.id, name, domain, JSON.stringify(metadata || {})]
  );

  logger.info(`[Palace] Added wing '${name}' (${domain}) for ${studentId}`);
  return mapPalaceNode(result.rows[0]);
}

/**
 * Add a room to a wing (topic cluster).
 */
export async function addRoom(
  wingId: string,
  name: string,
  topic: string,
  metadata?: Record<string, unknown>
): Promise<MemoryPalaceNode> {
  const existing = await db.query(
    `SELECT * FROM memory_palace_nodes 
     WHERE parent_id = $1 AND node_type = 'room' AND topic = $2
     LIMIT 1`,
    [wingId, topic]
  );

  if (existing.rows.length > 0) {
    return mapPalaceNode(existing.rows[0]);
  }

  const result = await db.query(
    `INSERT INTO memory_palace_nodes (palace_id, parent_id, node_type, name, topic, metadata)
     SELECT palace_id, $1, 'room', $2, $3, $4
     FROM memory_palace_nodes WHERE id = $1
     RETURNING *`,
    [wingId, name, topic, JSON.stringify(metadata || {})]
  );

  return mapPalaceNode(result.rows[0]);
}

/**
 * Add a drawer to a room (specific concept).
 */
export async function addDrawer(
  roomId: string,
  name: string,
  concept: string,
  metadata?: Record<string, unknown>
): Promise<MemoryPalaceNode> {
  const existing = await db.query(
    `SELECT * FROM memory_palace_nodes 
     WHERE parent_id = $1 AND node_type = 'drawer' AND concept = $2
     LIMIT 1`,
    [roomId, concept]
  );

  if (existing.rows.length > 0) {
    return mapPalaceNode(existing.rows[0]);
  }

  const result = await db.query(
    `INSERT INTO memory_palace_nodes (palace_id, parent_id, node_type, name, concept, metadata)
     SELECT palace_id, $1, 'drawer', $2, $3, $4
     FROM memory_palace_nodes WHERE id = $1
     RETURNING *`,
    [roomId, name, concept, JSON.stringify(metadata || {})]
  );

  return mapPalaceNode(result.rows[0]);
}

/**
 * Place a graph node into a palace drawer.
 */
export async function placeInPalace(
  drawerId: string,
  graphNodeId: string,
  contentType: string
): Promise<void> {
  await db.query(
    `INSERT INTO memory_palace_contents (palace_node_id, graph_node_id, content_type)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [drawerId, graphNodeId, contentType]
  );
}

/**
 * Discover cross-domain tunnels between palace nodes.
 * Called by sleep mode or after significant learning events.
 */
export async function discoverTunnels(studentId: string): Promise<MemoryPalaceTunnel[]> {
  const graph = await getGraphAdapter();

  // Get recent episodes
  const recentEpisodes = await graph.searchNodes({
    labels: ['Episode'],
    student_id: studentId,
  }, 30);

  // Get current palace structure
  const palaceNodes = await db.query(
    `SELECT n.* FROM memory_palace_nodes n
     JOIN memory_palaces p ON n.palace_id = p.id
     WHERE p.student_id = $1 AND n.node_type IN ('room', 'drawer')`,
    [studentId]
  );

  const wings = await db.query(
    `SELECT n.* FROM memory_palace_nodes n
     JOIN memory_palaces p ON n.palace_id = p.id
     WHERE p.student_id = $1 AND n.node_type = 'wing'`,
    [studentId]
  );

  const prompt = `
You are the spatial memory architect of Wax, an AI tutor.
After analyzing a student's recent learning sessions, identify CROSS-DOMAIN CONNECTIONS between topics they have studied.

Recent episodes:
${recentEpisodes.slice(0, 10).map(e => `- ${e.properties.topic || 'unknown'}: ${(e.properties.student_message as string || '').slice(0, 100)}`).join('\n')}

Current palace wings:
${wings.rows.map(w => `- ${w.name} (${w.domain})`).join('\n')}

OUTPUT FORMAT (JSON array):
[
  {
    "source_domain": "string",
    "source_topic": "string", 
    "target_domain": "string",
    "target_topic": "string",
    "strength": 0.0-1.0,
    "reasoning": "string"
  }
]

Rules:
- Only suggest tunnels with strength >= 0.6
- Must be genuinely cross-domain
- No invented connections
`;

  try {
    const response = await routeAndCall(
      [
        { role: 'system', content: 'You discover cross-domain learning connections. JSON only.' },
        { role: 'user', content: prompt },
      ],
      { tier: 'smart', jsonMode: true, maxTokens: 800, studentId, purpose: 'tunnel_discovery' }
    );

    const cleaned = response.content.replace(/```json|```/g, '').trim();
    const tunnels = JSON.parse(cleaned) as Array<{
      source_domain: string;
      source_topic: string;
      target_domain: string;
      target_topic: string;
      strength: number;
      reasoning: string;
    }>;

    const palace = await ensurePalace(studentId);
    const created: MemoryPalaceTunnel[] = [];

    for (const t of tunnels) {
      const sourceNode = palaceNodes.rows.find(
        n => (n.domain === t.source_domain || n.topic === t.source_topic || n.concept === t.source_topic)
      );
      const targetNode = palaceNodes.rows.find(
        n => (n.domain === t.target_domain || n.topic === t.target_topic || n.concept === t.target_topic)
      );

      if (!sourceNode || !targetNode || sourceNode.id === targetNode.id) continue;

      const result = await db.query(
        `INSERT INTO memory_palace_tunnels (palace_id, source_node_id, target_node_id, strength, reasoning)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (source_node_id, target_node_id) DO UPDATE SET
           strength = EXCLUDED.strength,
           reasoning = EXCLUDED.reasoning,
           last_validated = NOW()
         RETURNING *`,
        [palace.id, sourceNode.id, targetNode.id, t.strength, t.reasoning]
      );

      created.push(mapTunnel(result.rows[0]));
    }

    logger.info(`[Palace] Discovered ${created.length} tunnels for ${studentId}`);
    return created;
  } catch (err) {
    logger.warn({ err, studentId }, '[Palace] Tunnel discovery failed');
    return [];
  }
}

/**
 * Auto-construct palace hierarchy from a new concept encounter.
 */
export async function autoConstructPalacePath(
  studentId: string,
  subject: string,
  topic: string,
  concept: string
): Promise<{ wing: MemoryPalaceNode; room: MemoryPalaceNode; drawer: MemoryPalaceNode }> {
  const wing = await addWing(studentId, subject, subject.toLowerCase());
  const room = await addRoom(wing.id, topic, topic.toLowerCase());
  const drawer = await addDrawer(room.id, concept, concept.toLowerCase());

  return { wing, room, drawer };
}

function mapPalace(row: Record<string, unknown>): MemoryPalace {
  return {
    id: row.id as string,
    student_id: row.student_id as string,
    palace_name: row.palace_name as string,
    metadata: (row.metadata as Record<string, unknown>) || {},
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

function mapPalaceNode(row: Record<string, unknown>): MemoryPalaceNode {
  return {
    id: row.id as string,
    palace_id: row.palace_id as string,
    parent_id: (row.parent_id as string) || null,
    node_type: row.node_type as 'wing' | 'room' | 'drawer',
    name: row.name as string,
    domain: (row.domain as string) || undefined,
    topic: (row.topic as string) || undefined,
    concept: (row.concept as string) || undefined,
    metadata: (row.metadata as Record<string, unknown>) || {},
    access_count: row.access_count as number,
    last_accessed: row.last_accessed ? new Date(row.last_accessed as string) : null,
    created_at: new Date(row.created_at as string),
  };
}

function mapTunnel(row: Record<string, unknown>): MemoryPalaceTunnel {
  return {
    id: row.id as string,
    palace_id: row.palace_id as string,
    source_node_id: row.source_node_id as string,
    target_node_id: row.target_node_id as string,
    strength: row.strength as number,
    reasoning: (row.reasoning as string) || undefined,
    discovered_at: new Date(row.discovered_at as string),
    last_validated: row.last_validated ? new Date(row.last_validated as string) : null,
    is_active: row.is_active as boolean,
  };
}