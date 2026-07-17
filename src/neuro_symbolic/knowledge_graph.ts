/**
 * Knowledge graph: curriculum concept nodes (LLM-generated once, cached) and
 * the student's position within the graph. v2 improvements: node-generation
 * prompt is DB-configurable, and suggestNextConcept picks the highest-leverage
 * gap (longest-struggling, lowest mastery) instead of an arbitrary first match.
 */
import { db } from '../db/client';
import { callBrain } from '../brain/llama_server';
import { getPrompt } from '../config/prompts';
import { logger } from '../middleware/logger';

export interface ConceptNode {
  concept: string;
  subject: string;
  prerequisites: string[];
  leadsTo: string[];
  difficulty: number;
  examRelevance: Record<string, number>;
  commonMisconceptions: string[];
}

export async function getCurriculumNode(concept: string, subject: string): Promise<ConceptNode> {
  const cacheKey = `kg_node_${concept.toLowerCase().replace(/\s+/g, '_')}`;
  const cached = await db.query(`SELECT content FROM system_config WHERE key = $1`, [cacheKey]).catch(() => ({ rows: [] }));

  if (cached.rows.length > 0) {
    try { return JSON.parse(cached.rows[0].content) as ConceptNode; } catch { /* regenerate */ }
  }

  const fallback: ConceptNode = {
    concept, subject, prerequisites: [], leadsTo: [], difficulty: 0.5,
    examRelevance: { WAEC: 0.7, JAMB: 0.7, NECO: 0.6 }, commonMisconceptions: [],
  };

  try {
    const instruction = await getPrompt('knowledge_graph_node.v1');
    const response = await callBrain(`${instruction}\n\nConcept: "${concept}" in "${subject}".`, 0.2, 500);
    const node = { ...fallback, ...JSON.parse(response.replace(/```json|```/g, '').trim()) };

    await db.query(
      `INSERT INTO system_config (key, content) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
      [cacheKey, JSON.stringify(node)]
    ).catch(() => {});

    return node;
  } catch (err) {
    logger.debug({ err }, '[KnowledgeGraph] Node generation failed');
    return fallback;
  }
}

export async function getStudentKnowledgeGraph(studentId: string) {
  const result = await db.query(`SELECT concept_progress FROM student_profiles WHERE student_id = $1`, [studentId]);
  if (result.rows.length === 0) return { masteredConcepts: [], confusedConcepts: [], readyConcepts: [], blockedConcepts: [] };

  const cp = (result.rows[0].concept_progress || {}) as Record<string, { masteryLevel: number; attemptCount?: number; lastPracticed?: string }>;
  const masteredConcepts: string[] = [];
  const confusedConcepts: string[] = [];

  for (const [concept, progress] of Object.entries(cp)) {
    if (progress.masteryLevel > 0.7) masteredConcepts.push(concept);
    else if (progress.masteryLevel < 0.4) confusedConcepts.push(concept);
  }

  return { masteredConcepts, confusedConcepts, readyConcepts: confusedConcepts, blockedConcepts: [] };
}

/** Highest-leverage next concept: weakest mastery, most attempts, longest-ago practice. */
export async function suggestNextConcept(studentId: string, subject: string, examBoard: string): Promise<string | null> {
  const result = await db.query(`SELECT concept_progress FROM student_profiles WHERE student_id = $1`, [studentId]).catch(() => ({ rows: [] }));
  if (result.rows.length === 0) return null;

  const cp = (result.rows[0].concept_progress || {}) as Record<string, { masteryLevel: number; attemptCount?: number; lastPracticed?: string; subject?: string }>;
  let best: { concept: string; score: number } | null = null;

  for (const [concept, p] of Object.entries(cp)) {
    if (p.masteryLevel >= 0.7) continue;
    if (subject !== 'general' && p.subject && p.subject.toLowerCase() !== subject.toLowerCase()) continue;
    const daysSince = p.lastPracticed ? (Date.now() - new Date(p.lastPracticed).getTime()) / 86400000 : 7;
    const score = (1 - p.masteryLevel) * 2 + Math.min(p.attemptCount || 0, 5) * 0.3 + Math.min(daysSince, 14) * 0.1;
    if (!best || score > best.score) best = { concept, score };
  }

  return best?.concept || null;
}
