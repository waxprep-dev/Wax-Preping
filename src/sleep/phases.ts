/**
 * WaxPrep v3.0 — Sleep Mode Phase Implementations
 * All 6 phases of nightly consolidation.
 */

import { getGraphAdapter } from '../graph/factory';
import { routeAndCall } from '../llm/router';
import { getStudentProfile } from '../memory/semantic';
import { matchArchetypes } from '../student_profile/archetypes';
import { discoverTunnels } from '../palace/organizer';
import { logger } from '../middleware/logger';
import { db } from '../db/client';

// =============================================================================
// PHASE 1: CONTRADICTION DETECTION
// =============================================================================

export async function detectContradictions(studentId: string): Promise<number> {
  const graph = await getGraphAdapter();

  const facts = await graph.searchNodes({
    labels: ['Fact'],
    student_id: studentId,
  }, 500);

  // Group by attribute_key
  const grouped = new Map<string, typeof facts>();
  for (const fact of facts) {
    const key = fact.properties.attribute_key as string;
    if (!key) continue;
    const existing = grouped.get(key) || [];
    existing.push(fact);
    grouped.set(key, existing);
  }

  let contradictionsFound = 0;

  for (const [key, values] of grouped.entries()) {
    if (values.length < 2) continue;

    // Check for conflicting values
    const uniqueValues = new Set(values.map(v => JSON.stringify(v.properties.attribute_value)));
    if (uniqueValues.size < 2) continue;

    // Determine current truth (highest confidence, most recent)
    const sorted = values.sort((a, b) => {
      const confA = (a.properties.confidence as number) || 0;
      const confB = (b.properties.confidence as number) || 0;
      if (confB !== confA) return confB - confA;
      return b.event_time.getTime() - a.event_time.getTime();
    });

    const current = sorted[0];
    const outdated = sorted.slice(1);

    for (const old of outdated) {
      // Invalidate old fact
      await graph.updateNode(old.id, {
        validity_window: [old.event_time, new Date()],
      });

      // Create CONTRADICTS edge
      await graph.createEdge({
        source_id: current.id,
        target_id: old.id,
        type: 'CONTRADICTS',
        properties: {
          detected_at: new Date().toISOString(),
          resolution: 'superseded',
        },
        student_id: studentId,
      });

      // Log contradiction
      await db.query(
        `INSERT INTO memory_contradictions (
          student_id, attribute_key, current_fact_node_id, outdated_fact_node_id, confidence
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT DO NOTHING`,
        [studentId, key, current.id, old.id, current.properties.confidence as number || 0.7]
      );

      contradictionsFound++;
    }
  }

  logger.info(`[SleepMode] Detected ${contradictionsFound} contradictions for ${studentId}`);
  return contradictionsFound;
}

// =============================================================================
// PHASE 2: PATTERN EXTRACTION
// =============================================================================

export async function extractPatterns(studentId: string): Promise<number> {
  const graph = await getGraphAdapter();

  const episodes = await graph.searchNodes({
    labels: ['Episode'],
    student_id: studentId,
  }, 100);

  if (episodes.length < 10) return 0;

  // Sort chronologically
  episodes.sort((a, b) => a.event_time.getTime() - b.event_time.getTime());

  const prompt = `
Analyze this student's episode sequence and detect RECURRING BEHAVIORAL PATTERNS relevant to teaching.

Episodes (chronological):
${episodes.slice(-50).map((e, i) => `${i + 1}. [${e.properties.topic || 'general'}] ${(e.properties.student_message as string || '').slice(0, 120)}`).join('\n')}

OUTPUT FORMAT (JSON array):
[
  {
    "pattern_name": "snake_case_identifier",
    "description": "clear description",
    "category": "learning|emotional|behavioral",
    "confidence": 0.0-1.0,
    "evidence_count": 3
  }
]

Rules:
- Only report patterns with confidence >= 0.6 and at least 3 occurrences
- Look for sequences, cycles, and recurring behaviors
`;

  try {
    const response = await routeAndCall(
      [
        { role: 'system', content: 'You detect behavioral patterns in learning data. JSON only.' },
        { role: 'user', content: prompt },
      ],
      { tier: 'deep', jsonMode: true, maxTokens: 800, studentId, purpose: 'pattern_extraction' }
    );

    const cleaned = response.content.replace(/```json|```/g, '').trim();
    const patterns = JSON.parse(cleaned) as Array<{
      pattern_name: string;
      description: string;
      category: string;
      confidence: number;
      evidence_count: number;
    }>;

    let inserted = 0;
    for (const p of patterns) {
      if (p.confidence < 0.6 || p.evidence_count < 3) continue;

      await db.query(
        `INSERT INTO memory_patterns (
          student_id, pattern_name, description, category, confidence, occurrence_count
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (student_id, pattern_name) DO UPDATE SET
          description = EXCLUDED.description,
          confidence = EXCLUDED.confidence,
          occurrence_count = memory_patterns.occurrence_count + EXCLUDED.occurrence_count,
          last_observed = NOW()`,
        [studentId, p.pattern_name, p.description, p.category, p.confidence, p.evidence_count]
      );

      inserted++;
    }

    logger.info(`[SleepMode] Extracted ${inserted} patterns for ${studentId}`);
    return inserted;
  } catch (err) {
    logger.warn({ err, studentId }, '[SleepMode] Pattern extraction failed');
    return 0;
  }
}

// =============================================================================
// PHASE 3: INSIGHT GENERATION
// =============================================================================

export async function generateInsights(studentId: string): Promise<number> {
  const graph = await getGraphAdapter();

  const [facts, episodes, concepts] = await Promise.all([
    graph.searchNodes({ labels: ['Fact'], student_id: studentId }, 50),
    graph.searchNodes({ labels: ['Episode'], student_id: studentId }, 20),
    graph.searchNodes({ labels: ['Concept'], student_id: studentId }, 30),
  ]);

  const prompt = `
As this student's tutor, reflect on everything you know and generate HIGH-LEVEL INSIGHTS.

Facts: ${facts.slice(0, 20).map(f => `${f.properties.attribute_key}: ${JSON.stringify(f.properties.attribute_value).slice(0, 100)}`).join('\n')}

Recent episodes: ${episodes.slice(-10).map(e => (e.properties.student_message as string || '').slice(0, 100)).join('\n')}

Concept mastery: ${concepts.map(c => `${c.properties.name}: ${c.properties.mastery_estimate}`).join(', ')}

OUTPUT FORMAT (JSON array):
[
  {
    "category": "learning|emotional|behavioral|strategic",
    "insight": "specific insight",
    "confidence": 0.0-1.0,
    "recommended_action": "concrete action"
  }
]

Rules:
- Be specific and actionable
- Cite evidence implicitly through the input
- Confidence reflects evidence strength
`;

  try {
    const response = await routeAndCall(
      [
        { role: 'system', content: 'You generate teaching insights from student data. JSON only.' },
        { role: 'user', content: prompt },
      ],
      { tier: 'deep', jsonMode: true, maxTokens: 800, studentId, purpose: 'insight_generation' }
    );

    const cleaned = response.content.replace(/```json|```/g, '').trim();
    const insights = JSON.parse(cleaned) as Array<{
      category: string;
      insight: string;
      confidence: number;
      recommended_action: string;
    }>;

    let created = 0;
    for (const insight of insights) {
      if (insight.confidence < 0.5) continue;

      const insightNode = await graph.createNode({
        labels: ['Insight'],
        properties: {
          category: insight.category,
          insight: insight.insight,
          confidence: insight.confidence,
          recommended_action: insight.recommended_action,
        },
        student_id: studentId,
        source: 'sleep_mode',
      });

      // Link to student
      const studentNodes = await graph.searchNodes({ labels: ['Student'], student_id: studentId }, 1);
      if (studentNodes.length > 0) {
        await graph.createEdge({
          source_id: studentNodes[0].id,
          target_id: insightNode.id,
          type: 'HAS_INSIGHT',
          student_id: studentId,
        });
      }

      created++;
    }

    logger.info(`[SleepMode] Generated ${created} insights for ${studentId}`);
    return created;
  } catch (err) {
    logger.warn({ err, studentId }, '[SleepMode] Insight generation failed');
    return 0;
  }
}

// =============================================================================
// PHASE 4: GRAPH COMMUNITY DETECTION
// =============================================================================

export async function detectCommunities(studentId: string): Promise<number> {
  const graph = await getGraphAdapter();

  const allNodes = await graph.searchNodes({ student_id: studentId }, 500);
  const allEdges = await db.query(
    `SELECT source_id, target_id, type FROM cognitive_graph_edges
     WHERE student_id = $1
       AND (validity_window IS NULL OR validity_window @> NOW())`,
    [studentId]
  );

  if (allNodes.length < 10 || allEdges.rows.length < 5) return 0;

  // Simple connected-components detection
  const adjacency = new Map<string, Set<string>>();
  for (const edge of allEdges.rows) {
    const s = edge.source_id as string;
    const t = edge.target_id as string;
    if (!adjacency.has(s)) adjacency.set(s, new Set());
    if (!adjacency.has(t)) adjacency.set(t, new Set());
    adjacency.get(s)!.add(t);
    adjacency.get(t)!.add(s);
  }

  const visited = new Set<string>();
  const communities: string[][] = [];

  for (const [nodeId] of adjacency) {
    if (visited.has(nodeId)) continue;

    const component: string[] = [];
    const stack = [nodeId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const neighbor of adjacency.get(current) || []) {
        if (!visited.has(neighbor)) stack.push(neighbor);
      }
    }
    if (component.length >= 3) communities.push(component);
  }

  let created = 0;
  for (const members of communities) {
    const memberNodes = allNodes.filter(n => members.includes(n.id));
    const conceptNames = memberNodes
      .filter(n => n.labels.includes('Concept'))
      .map(n => n.properties.name as string)
      .filter(Boolean);

    const summary = conceptNames.length > 0
      ? `Connected concepts: ${conceptNames.join(', ')}`
      : `Community of ${members.length} related memories`;

    await db.query(
      `INSERT INTO memory_communities (student_id, summary, member_count, member_node_ids)
       VALUES ($1, $2, $3, $4)`,
      [studentId, summary, members.length, members]
    );

    created++;
  }

  logger.info(`[SleepMode] Detected ${created} communities for ${studentId}`);
  return created;
}

// =============================================================================
// PHASE 5: MEMORY REORGANIZATION
// =============================================================================

export async function reorganizeMemories(studentId: string): Promise<number> {
  const now = new Date();
  let reorganized = 0;

  // Hot memories (accessed today)
  const hot = await db.query(
    `SELECT memory_id, memory_type FROM memory_access_logs
     WHERE student_id = $1 AND accessed_at > NOW() - INTERVAL '24 hours'
     GROUP BY memory_id, memory_type`,
    [studentId]
  );

  for (const row of hot.rows) {
    await db.query(
      `UPDATE cognitive_graph_nodes 
       SET properties = properties || '{"hot": true}'::jsonb
       WHERE id = $1`,
      [row.memory_id]
    );
    reorganized++;
  }

  // Warm memories (accessed this week, not today)
  const warm = await db.query(
    `SELECT memory_id FROM memory_access_logs
     WHERE student_id = $1 
       AND accessed_at BETWEEN NOW() - INTERVAL '7 days' AND NOW() - INTERVAL '1 day'
     GROUP BY memory_id`,
    [studentId]
  );

  for (const row of warm.rows) {
    await db.query(
      `UPDATE cognitive_graph_nodes 
       SET properties = properties || '{"warm": true}'::jsonb
       WHERE id = $1`,
      [row.memory_id]
    );
    reorganized++;
  }

  // Cold memories (not accessed in a month, low emotional salience)
  const cold = await db.query(
    `SELECT id FROM cognitive_graph_nodes
     WHERE student_id = $1
       AND (properties->>'access_count')::int < 3
       AND (properties->>'emotional_salience')::float < 0.4
       AND created_at < NOW() - INTERVAL '30 days'
       AND NOT (properties ? 'archived')`,
    [studentId]
  );

  for (const row of cold.rows) {
    await db.query(
      `UPDATE cognitive_graph_nodes 
       SET properties = properties || '{"archived": true, "cold": true}'::jsonb
       WHERE id = $1`,
      [row.id]
    );
    reorganized++;
  }

  logger.info(`[SleepMode] Reorganized ${reorganized} memories for ${studentId}`);
  return reorganized;
}

// =============================================================================
// PHASE 6: ARCHETYPE UPDATE
// =============================================================================

export async function updateArchetype(studentId: string): Promise<number> {
  try {
    await matchArchetypes(studentId);
    logger.info(`[SleepMode] Updated archetypes for ${studentId}`);
    return 1;
  } catch (err) {
    logger.warn({ err, studentId }, '[SleepMode] Archetype update failed');
    return 0;
  }
}