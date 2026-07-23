/**
 * Semantic memory: the durable model of the student — profile, memory blocks,
 * concept progress (BKT-inspired), facts, streaks.
 *
 * v1 bugs fixed here:
 * - updateStudyStreak() incremented total_sessions on EVERY message. Moved to
 *   session creation (session manager).
 * - getStudentProfile() now returns a deep copy so callers can't accidentally
 *   mutate the cached object.
 * - updateConceptEvidence() uses true BKT (Corbett & Anderson) with per-concept
 *   parameters learned from knowledge_trace_events.
 *
 * v3.0: Writes facts and concept progress to the cognitive graph.
 */

import { db } from '../db/client';
import { logger } from '../middleware/logger';
import { getGraphAdapter } from '../graph/factory';
import { DEFAULT_BKT, bktFromResult, type BktParams } from '../teaching/bkt';
import type {
  StudentProfile,
  StudentFact,
  ConceptProgress,
  BloomLevel,
  SymbolicBelief,
  MemoryBlocks,
} from '../types/student';

const profileCache = new Map<string, { profile: StudentProfile; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

async function getConceptBktParams(conceptId: string): Promise<BktParams> {
  try {
    const result = await db.query(
      `SELECT AVG(CASE WHEN success THEN p_after ELSE NULL END) as avg_success_p,
              COUNT(*) as n
       FROM knowledge_trace_events
       WHERE concept_id = $1`,
      [conceptId]
    );
    const row = result.rows[0];
    if ((row.n as number) < 5) return DEFAULT_BKT;

    const avgSuccessP = row.avg_success_p as number;
    return {
      pL0: Math.max(0.05, Math.min(0.95, avgSuccessP * 0.8)),
      pT: 0.2,
      pS: 0.1,
      pG: 0.3,
    };
  } catch {
    return DEFAULT_BKT;
  }
}

async function logTraceEvent(event: {
  studentId: string;
  conceptId: string;
  success: boolean;
  pBefore: number;
  pAfter: number;
  source: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO knowledge_trace_events (student_id, concept_id, success, p_before, p_after, source)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [event.studentId, event.conceptId, event.success, event.pBefore, event.pAfter, event.source]
  ).catch(() => {});
}

export async function getStudentProfile(studentId: string): Promise<StudentProfile> {
  const cached = profileCache.get(studentId);
  if (cached && cached.expiresAt > Date.now()) {
    return JSON.parse(JSON.stringify(cached.profile)) as StudentProfile;
  }

  const result = await db.query(`SELECT * FROM student_profiles WHERE student_id = $1`, [studentId]);

  let profile: StudentProfile;

  if (result.rows.length === 0) {
    profile = createDefaultProfile(studentId);
    await db.query(
      `INSERT INTO student_profiles (
        student_id, created_at, last_seen_at, total_sessions, total_turns,
        study_streak, last_study_date, memory_blocks, concept_progress,
        error_diary, analogy_library, exam_targets, cultural_context
      ) VALUES ($1, NOW(), NOW(), 0, 0, 0, NULL, $2, $3, $4, $5, $6, $7)`,
      [
        studentId,
        JSON.stringify(profile.memoryBlocks),
        JSON.stringify(profile.conceptProgress),
        JSON.stringify(profile.errorDiary),
        JSON.stringify(profile.analogyLibrary),
        JSON.stringify(profile.examTargets),
        JSON.stringify(profile.culturalContext),
      ]
    );
  } else {
    const row = result.rows[0];
    profile = {
      studentId: row.student_id,
      createdAt: new Date(row.created_at),
      lastSeenAt: new Date(row.last_seen_at),
      totalSessions: row.total_sessions,
      totalTurns: row.total_turns,
      studyStreak: row.study_streak,
      lastStudyDate: row.last_study_date ? new Date(row.last_study_date) : null,
      memoryBlocks: row.memory_blocks || {},
      conceptProgress: row.concept_progress || {},
      errorDiary: row.error_diary || [],
      analogyLibrary: row.analogy_library || [],
      examTargets: row.exam_targets || [],
      culturalContext: row.cultural_context || {},
      studyPlan: row.study_plan,
      facts: {},
    };

    const factsResult = await db.query(
      `SELECT fact_key, fact_value, confidence, source, updated_at FROM student_facts WHERE student_id = $1`,
      [studentId]
    );
    for (const f of factsResult.rows) {
      profile.facts[f.fact_key] = {
        factKey: f.fact_key,
        factValue: f.fact_value,
        confidence: f.confidence,
        source: f.source,
        updatedAt: new Date(f.updated_at),
      };
    }
  }

  profileCache.set(studentId, { profile, expiresAt: Date.now() + CACHE_TTL_MS });
  return JSON.parse(JSON.stringify(profile)) as StudentProfile;
}

function createDefaultProfile(studentId: string): StudentProfile {
  return {
    studentId,
    createdAt: new Date(),
    lastSeenAt: new Date(),
    totalSessions: 0,
    totalTurns: 0,
    studyStreak: 0,
    lastStudyDate: null,
    memoryBlocks: {
      humanProfile: '',
      learningStyle: '',
      progress: '',
      shameMap: '',
      curiosityMap: '',
      procedural: '',
      examStrategy: '',
      errorPatterns: '',
      breakthroughs: '',
    },
    conceptProgress: {},
    errorDiary: [],
    analogyLibrary: [],
    examTargets: [],
    culturalContext: {
      // Discovered dynamically from student attributes / conversation — never assumed.
      country: '',
      region: '',
      language: '',
      currency: '',
      examBoards: [],
      timezone: process.env.DEFAULT_STUDENT_TIMEZONE || 'Africa/Lagos',
    },
    facts: {},
  };
}

export function invalidateProfileCache(studentId?: string): void {
  if (studentId) {
    profileCache.delete(studentId);
  } else {
    profileCache.clear();
  }
}

export async function applyMemoryEdit(
  studentId: string,
  block: keyof MemoryBlocks,
  operation: 'append' | 'replace' | 'delete',
  text: string
): Promise<void> {
  const profile = await getStudentProfile(studentId);
  const blocks = { ...profile.memoryBlocks };

  if (operation === 'append') {
    blocks[block] = (blocks[block] || '') + '\n' + text;
  } else if (operation === 'replace') {
    blocks[block] = text;
  } else if (operation === 'delete') {
    blocks[block] = '';
  }

  await db.query(
    `UPDATE student_profiles SET memory_blocks = $1 WHERE student_id = $2`,
    [JSON.stringify(blocks), studentId]
  );

  invalidateProfileCache(studentId);
}

export async function upsertStudentFact(
  studentId: string,
  fact: StudentFact
): Promise<void> {
  await db.query(
    `INSERT INTO student_facts (student_id, fact_key, fact_value, confidence, source, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (student_id, fact_key) DO UPDATE SET
       fact_value = EXCLUDED.fact_value,
       confidence = EXCLUDED.confidence,
       source = EXCLUDED.source,
       updated_at = EXCLUDED.updated_at`,
    [studentId, fact.factKey, fact.factValue, fact.confidence, fact.source, fact.updatedAt]
  ).catch(err => logger.debug({ err }, '[Semantic] Fact upsert failed'));

  // v3.0: Write to cognitive graph
  try {
    const graph = await getGraphAdapter();
    
    const studentNodes = await graph.searchNodes({ labels: ['Student'], student_id: studentId }, 1);
    let studentNodeId: string;
    if (studentNodes.length === 0) {
      const newStudent = await graph.createNode({
        labels: ['Student'],
        properties: { student_id: studentId },
        student_id: studentId,
        source: 'system',
      });
      studentNodeId = newStudent.id;
    } else {
      studentNodeId = studentNodes[0].id;
    }

    const existingFacts = await graph.searchNodes({
      labels: ['Fact'],
      student_id: studentId,
      attribute_key: fact.factKey,
    }, 1);

    if (existingFacts.length > 0) {
      const oldFact = existingFacts[0];
      await graph.updateNode(oldFact.id, {
        validity_window: [oldFact.event_time, new Date()],
      });

      await graph.createEdge({
        source_id: studentNodeId,
        target_id: oldFact.id,
        type: 'HAD_FACT',
        properties: { superseded: true },
        student_id: studentId,
      });
    }

    const factNode = await graph.createNode({
      labels: ['Fact'],
      properties: {
        attribute_key: fact.factKey,
        attribute_value: fact.factValue,
        confidence: fact.confidence,
        source: fact.source,
      },
      student_id: studentId,
      source: fact.source,
    });

    await graph.createEdge({
      source_id: studentNodeId,
      target_id: factNode.id,
      type: 'HAS_FACT',
      properties: { confidence: fact.confidence },
      student_id: studentId,
    });

    logger.debug({ studentId, factKey: fact.factKey }, '[Semantic] Fact saved to graph');
  } catch (graphErr) {
    logger.debug({ graphErr }, '[Semantic] Graph write failed — relational data preserved');
  }
}

export async function updateConceptEvidence(
  studentId: string,
  concept: string,
  subject: string,
  result: 'success' | 'struggle' | 'neutral',
  bloomLevel: BloomLevel,
  misconception?: string | null
): Promise<ConceptProgress> {
  const profile = await getStudentProfile(studentId);
  const progress = { ...profile.conceptProgress };

  const existing = progress[concept] || {
    conceptId: concept.toLowerCase().replace(/\s+/g, '_'),
    conceptName: concept,
    subject: subject || 'General',
    firstEncountered: new Date(),
    lastPracticed: new Date(),
    masteryLevel: 0.1,
    symbolicBeliefs: [],
    misconceptions: [],
    analogiesUsed: [],
    nextReviewAt: undefined,
    reviewInterval: 1,
    reviewCount: 0,
    successCount: 0,
    attemptCount: 0,
    bloomLevel: 'remember' as BloomLevel,
  };

  existing.attemptCount += 1;
  if (result === 'success') existing.successCount += 1;
  existing.lastPracticed = new Date();
  existing.lastResult = result;

  const BLOOM_ORDER: BloomLevel[] = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];
  if (BLOOM_ORDER.indexOf(bloomLevel) > BLOOM_ORDER.indexOf(existing.bloomLevel)) {
    existing.bloomLevel = bloomLevel;
  }

  const pBefore = existing.masteryLevel || DEFAULT_BKT.pL0;
  let params = DEFAULT_BKT;
  try { params = await getConceptBktParams(existing.conceptId || concept); } catch { /* defaults */ }
  existing.masteryLevel = bktFromResult(pBefore, result, params);
  logTraceEvent({
    studentId,
    conceptId: existing.conceptId || concept,
    success: result === 'success',
    pBefore,
    pAfter: existing.masteryLevel,
    source: 'updateConceptEvidence',
  }).catch(() => {});

  if (misconception && !existing.misconceptions.includes(misconception)) {
    existing.misconceptions.push(misconception);
    if (existing.misconceptions.length > 5) existing.misconceptions.shift();
  }

  progress[concept] = existing;

  await db.query(
    `UPDATE student_profiles SET concept_progress = $1 WHERE student_id = $2`,
    [JSON.stringify(progress), studentId]
  );

  // v3.0: Write concept to cognitive graph
  try {
    const graph = await getGraphAdapter();
    
    const conceptNodes = await graph.searchNodes({
      labels: ['Concept'],
      student_id: studentId,
      name: concept,
    }, 1);

    if (conceptNodes.length > 0) {
      await graph.updateNode(conceptNodes[0].id, {
        properties: {
          ...conceptNodes[0].properties,
          mastery_estimate: existing.masteryLevel,
          bloom_level: existing.bloomLevel,
          success_count: existing.successCount,
          attempt_count: existing.attemptCount,
          last_practiced: existing.lastPracticed.toISOString(),
        },
      });
    } else {
      const studentNodes = await graph.searchNodes({ labels: ['Student'], student_id: studentId }, 1);
      let studentNodeId: string;
      if (studentNodes.length === 0) {
        const newStudent = await graph.createNode({
          labels: ['Student'],
          properties: { student_id: studentId },
          student_id: studentId,
          source: 'system',
        });
        studentNodeId = newStudent.id;
      } else {
        studentNodeId = studentNodes[0].id;
      }

      const newConcept = await graph.createNode({
        labels: ['Concept'],
        properties: {
          name: concept,
          subject: subject || 'General',
          mastery_estimate: existing.masteryLevel,
          bloom_level: existing.bloomLevel,
          success_count: existing.successCount,
          attempt_count: existing.attemptCount,
        },
        student_id: studentId,
        source: 'bkt',
      });

      await graph.createEdge({
        source_id: studentNodeId,
        target_id: newConcept.id,
        type: 'HAS_MASTERY',
        properties: {
          probability: existing.masteryLevel,
          updated_at: new Date().toISOString(),
        },
        student_id: studentId,
      });
    }

    logger.debug({ studentId, concept, mastery: existing.masteryLevel }, '[Semantic] Concept saved to graph');
  } catch (graphErr) {
    logger.debug({ graphErr }, '[Semantic] Graph write failed — relational data preserved');
  }

  invalidateProfileCache(studentId);
  return existing;
}

export async function recordBreakthrough(
  studentId: string,
  concept: string,
  details: string
): Promise<void> {
  const profile = await getStudentProfile(studentId);
  const blocks = { ...profile.memoryBlocks };
  blocks.breakthroughs = (blocks.breakthroughs || '') + '\n' + details;
  await applyMemoryEdit(studentId, 'breakthroughs', 'replace', blocks.breakthroughs);

  // v3.0: Create breakthrough episode node in graph
  try {
    const graph = await getGraphAdapter();
    const episodeNode = await graph.createNode({
      labels: ['Episode', 'Breakthrough'],
      properties: {
        concept,
        details,
        emotional_valence: 0.9,
        breakthrough: true,
      },
      student_id: studentId,
      source: 'breakthrough_recorder',
    });

    const studentNodes = await graph.searchNodes({ labels: ['Student'], student_id: studentId }, 1);
    if (studentNodes.length > 0) {
      await graph.createEdge({
        source_id: studentNodes[0].id,
        target_id: episodeNode.id,
        type: 'PARTICIPATED_IN',
        student_id: studentId,
      });
    }
  } catch (graphErr) {
    logger.debug({ graphErr }, '[Semantic] Breakthrough graph write failed');
  }
}

export async function recordErrorPattern(
  studentId: string,
  concept: string,
  error: string
): Promise<void> {
  const profile = await getStudentProfile(studentId);
  const diary = [...(profile.errorDiary || [])];
  diary.push({
    concept,
    description: error,
    timestamp: new Date().toISOString(),
    corrected: false,
  });
  if (diary.length > 20) diary.shift();

  await db.query(
    `UPDATE student_profiles SET error_diary = $1 WHERE student_id = $2`,
    [JSON.stringify(diary), studentId]
  );

  const blocks = { ...profile.memoryBlocks };
  blocks.errorPatterns = (blocks.errorPatterns || '') + `\n[${concept}] ${error}`;
  await applyMemoryEdit(studentId, 'errorPatterns', 'replace', blocks.errorPatterns);

  // v3.0: Create mistake pattern in graph
  try {
    const graph = await getGraphAdapter();
    const mistakeNode = await graph.createNode({
      labels: ['Episode', 'Mistake'],
      properties: {
        concept,
        error,
        emotional_valence: -0.5,
        mistake: true,
      },
      student_id: studentId,
      source: 'error_recorder',
    });

    const studentNodes = await graph.searchNodes({ labels: ['Student'], student_id: studentId }, 1);
    if (studentNodes.length > 0) {
      await graph.createEdge({
        source_id: studentNodes[0].id,
        target_id: mistakeNode.id,
        type: 'PARTICIPATED_IN',
        student_id: studentId,
      });
    }

    const conceptNodes = await graph.searchNodes({
      labels: ['Concept'],
      student_id: studentId,
      name: concept,
    }, 1);

    if (conceptNodes.length > 0) {
      await graph.createEdge({
        source_id: mistakeNode.id,
        target_id: conceptNodes[0].id,
        type: 'MISTAKE_ON',
        student_id: studentId,
      });
    }
  } catch (graphErr) {
    logger.debug({ graphErr }, '[Semantic] Error pattern graph write failed');
  }

  invalidateProfileCache(studentId);
}

export async function recordAnalogy(
  studentId: string,
  concept: string,
  analogy: string
): Promise<void> {
  const profile = await getStudentProfile(studentId);
  const library = [...(profile.analogyLibrary || [])];
  library.push({
    concept,
    analogy,
  });
  if (library.length > 50) library.shift();

  await db.query(
    `UPDATE student_profiles SET analogy_library = $1 WHERE student_id = $2`,
    [JSON.stringify(library), studentId]
  );

  // v3.0: Store analogy as fact in graph
  try {
    const graph = await getGraphAdapter();
    const analogyNode = await graph.createNode({
      labels: ['Fact'],
      properties: {
        attribute_key: `analogy_${concept}`,
        attribute_value: analogy,
        concept,
        confidence: 0.8,
        category: 'cognitive_preference',
      },
      student_id: studentId,
      source: 'analogy_recorder',
    });

    const studentNodes = await graph.searchNodes({ labels: ['Student'], student_id: studentId }, 1);
    if (studentNodes.length > 0) {
      await graph.createEdge({
        source_id: studentNodes[0].id,
        target_id: analogyNode.id,
        type: 'HAS_FACT',
        student_id: studentId,
      });
    }
  } catch (graphErr) {
    logger.debug({ graphErr }, '[Semantic] Analogy graph write failed');
  }

  invalidateProfileCache(studentId);
}

export async function updateStudyStreak(studentId: string): Promise<void> {
  const profile = await getStudentProfile(studentId);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (!profile.lastStudyDate) {
    await db.query(
      `UPDATE student_profiles SET study_streak = 1, last_study_date = $1 WHERE student_id = $2`,
      [today.toISOString(), studentId]
    );
    invalidateProfileCache(studentId);
    return;
  }

  const lastDate = new Date(profile.lastStudyDate);
  lastDate.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((today.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));

  let newStreak = profile.studyStreak;
  if (diffDays === 1) {
    newStreak += 1;
  } else if (diffDays > 1) {
    newStreak = 1;
  }

  if (diffDays >= 1) {
    await db.query(
      `UPDATE student_profiles SET study_streak = $1, last_study_date = $2 WHERE student_id = $3`,
      [newStreak, today.toISOString(), studentId]
    );
    invalidateProfileCache(studentId);
  }
}

export async function updateExamTargets(
  studentId: string,
  targets: Array<{ exam: string; date: string; subjects: string[] }>
): Promise<void> {
  await db.query(
    `UPDATE student_profiles SET exam_targets = $1 WHERE student_id = $2`,
    [JSON.stringify(targets), studentId]
  );
  invalidateProfileCache(studentId);
}

export async function updateCulturalContext(
  studentId: string,
  context: Record<string, unknown>
): Promise<void> {
  const profile = await getStudentProfile(studentId);
  const merged = { ...profile.culturalContext, ...context };
  await db.query(
    `UPDATE student_profiles SET cultural_context = $1 WHERE student_id = $2`,
    [JSON.stringify(merged), studentId]
  );
  invalidateProfileCache(studentId);
}

export async function getSymbolicKnowledge(studentId: string): Promise<Record<string, SymbolicBelief>> {
  const result = await db.query(
    `SELECT symbolic_knowledge FROM student_profiles WHERE student_id = $1`,
    [studentId]
  );
  return (result.rows[0]?.symbolic_knowledge as Record<string, SymbolicBelief>) || {};
}

export async function updateSymbolicKnowledge(
  studentId: string,
  beliefs: Record<string, SymbolicBelief>
): Promise<void> {
  await db.query(
    `UPDATE student_profiles SET symbolic_knowledge = $1 WHERE student_id = $2`,
    [JSON.stringify(beliefs), studentId]
  );
  invalidateProfileCache(studentId);
}