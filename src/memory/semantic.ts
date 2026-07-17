/**
 * Semantic memory: the durable model of the student — profile, memory blocks,
 * concept progress (BKT-inspired), facts, streaks.
 *
 * v1 bugs fixed here:
 * - updateStudyStreak() incremented total_sessions on EVERY message. Moved to
 *   session creation (session/manager), so sessions and turns mean what they say.
 * - getStudentProfile() raced itself (INSERT ... ON CONFLICT DO NOTHING then
 *   return a default object that might diverge from the row). Now reads back.
 * - masteryLevel was overwritten by ratios of symbolic beliefs added in a
 *   single turn. Now mastery is an evidence-weighted Bayesian-style update
 *   applied per turn by updateConceptEvidence().
 */
import { db } from '../db/client';
import { logger } from '../middleware/logger';
import type { StudentProfile, MemoryBlocks, SymbolicBelief, ConceptProgress, BloomLevel, StudentFact } from '../types/student';

export const DEFAULT_BLOCKS: MemoryBlocks = {
  humanProfile: 'New student. Nothing known yet. Listen carefully before teaching.',
  learningStyle: 'Learning style unknown. Watch what makes them curious and what makes them quiet.',
  progress: 'No concepts covered yet. Follow wherever they lead.',
  shameMap: 'Shame triggers unknown. Watch for hedging, silence, self-deprecation.',
  curiosityMap: 'Curiosity hooks unknown. Watch for follow-up questions and longer messages.',
  procedural: 'No special procedures yet. Be warm, patient, follow their lead.',
  examStrategy: 'No exam strategy established yet.',
  errorPatterns: 'No error patterns detected yet.',
  breakthroughs: 'No breakthroughs yet. Every turn is a chance.',
};

function defaultCulturalContext() {
  return { country: 'Nigeria', region: 'unknown', language: 'English', currency: 'Naira', examBoards: ['WAEC', 'JAMB', 'NECO'], timezone: 'Africa/Lagos' };
}

export async function getStudentProfile(studentId: string): Promise<StudentProfile> {
  await db.query(
    `INSERT INTO student_profiles (student_id, memory_blocks) VALUES ($1, $2) ON CONFLICT (student_id) DO NOTHING`,
    [studentId, JSON.stringify(DEFAULT_BLOCKS)]
  );

  const result = await db.query(`SELECT * FROM student_profiles WHERE student_id = $1`, [studentId]);
  const row = result.rows[0];

  const factsResult = await db.query(`SELECT * FROM student_facts WHERE student_id = $1`, [studentId]).catch(() => ({ rows: [] }));
  const facts: Record<string, StudentFact> = {};
  for (const f of factsResult.rows) {
    facts[f.fact_key as string] = {
      factKey: f.fact_key as string,
      factValue: f.fact_value as string,
      confidence: f.confidence as number,
      source: f.source as string,
      updatedAt: new Date(f.updated_at as string),
    };
  }

  return {
    studentId: row.student_id,
    createdAt: new Date(row.created_at),
    lastSeenAt: new Date(row.last_seen_at),
    totalSessions: row.total_sessions || 0,
    totalTurns: row.total_turns || 0,
    studyStreak: row.study_streak || 0,
    lastStudyDate: row.last_study_date ? new Date(row.last_study_date) : null,
    examTargets: row.exam_targets || [],
    culturalContext: row.cultural_context || defaultCulturalContext(),
    conceptProgress: row.concept_progress || {},
    errorDiary: row.error_diary || [],
    analogyLibrary: row.analogy_library || [],
    memoryBlocks: { ...DEFAULT_BLOCKS, ...(row.memory_blocks || {}) },
    facts,
    studyPlan: row.study_plan || undefined,
  };
}

export async function applyMemoryEdit(
  studentId: string,
  block: keyof MemoryBlocks,
  operation: 'append' | 'replace' | 'delete',
  content: string
): Promise<void> {
  const profile = await getStudentProfile(studentId);
  const blocks = { ...profile.memoryBlocks };
  const timestamp = new Date().toLocaleDateString('en-NG');

  if (operation === 'replace') {
    blocks[block] = content;
  } else if (operation === 'append') {
    blocks[block] = blocks[block] ? `${blocks[block]}\n[${timestamp}]: ${content}` : content;
  } else {
    blocks[block] = DEFAULT_BLOCKS[block];
  }

  await db.query(
    `UPDATE student_profiles SET memory_blocks = $1, last_seen_at = NOW() WHERE student_id = $2`,
    [JSON.stringify(blocks), studentId]
  );
}

export async function upsertStudentFacts(
  studentId: string,
  facts: { key: string; value: string; confidence: number }[]
): Promise<void> {
  for (const fact of facts.slice(0, 8)) {
    if (!fact.key || !fact.value || fact.value.length < 2) continue;
    await db.query(
      `INSERT INTO student_facts (student_id, fact_key, fact_value, confidence)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (student_id, fact_key) DO UPDATE SET
         fact_value = EXCLUDED.fact_value,
         confidence = GREATEST(student_facts.confidence, EXCLUDED.confidence),
         updated_at = NOW()`,
      [studentId, fact.key.toLowerCase().replace(/\s+/g, '_').slice(0, 60), fact.value.slice(0, 300), fact.confidence ?? 0.7]
    ).catch(err => logger.debug({ err }, '[Semantic] Fact upsert failed'));
  }
}

/**
 * Evidence-based mastery update (BKT-inspired).
 * Each turn contributes one observation; mastery moves toward the evidence
 * with asymmetric step sizes — mastery is easier to lose than to gain at the
 * top, which matches how teachers actually calibrate confidence.
 */
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

  const stepUp = 0.18 * (1 - existing.masteryLevel);
  const stepDown = 0.25 * existing.masteryLevel;
  if (result === 'success') existing.masteryLevel = Math.min(0.98, existing.masteryLevel + stepUp);
  else if (result === 'struggle') existing.masteryLevel = Math.max(0.02, existing.masteryLevel - stepDown);

  if (misconception && !existing.misconceptions.includes(misconception)) {
    existing.misconceptions.push(misconception);
    if (existing.misconceptions.length > 5) existing.misconceptions.shift();
  }

  progress[concept] = existing;

  await db.query(
    `UPDATE student_profiles SET concept_progress = $1 WHERE student_id = $2`,
    [JSON.stringify(progress), studentId]
  );

  return existing;
}

export async function updateSymbolicBelief(
  studentId: string,
  concept: string,
  claim: string,
  status: SymbolicBelief['status'],
  confidence: SymbolicBelief['confidence'],
  evidence: string
): Promise<void> {
  const profile = await getStudentProfile(studentId);
  const progress = { ...profile.conceptProgress };

  if (!progress[concept]) return; // concept rows are created by updateConceptEvidence
  const cp = progress[concept];
  if (!cp.symbolicBeliefs) cp.symbolicBeliefs = [];

  const existingBelief = cp.symbolicBeliefs.find(b => b.claim === claim);
  if (existingBelief) {
    existingBelief.status = status;
    existingBelief.confidence = confidence;
    existingBelief.evidence = evidence;
    existingBelief.updatedAt = new Date();
  } else {
    cp.symbolicBeliefs.push({ claim, status, confidence, evidence, updatedAt: new Date() });
    if (cp.symbolicBeliefs.length > 10) cp.symbolicBeliefs.shift();
  }

  await db.query(
    `UPDATE student_profiles SET concept_progress = $1 WHERE student_id = $2`,
    [JSON.stringify(progress), studentId]
  );
}

export async function recordErrorPattern(studentId: string, concept: string, errorType: string): Promise<void> {
  const profile = await getStudentProfile(studentId);
  const diary = [...profile.errorDiary];
  const entry = diary.find(e => e.concept === concept && e.errorType === errorType);
  if (entry) {
    entry.count += 1;
    entry.lastOccurred = new Date();
    entry.resolved = false;
  } else {
    diary.push({ concept, errorType, count: 1, lastOccurred: new Date(), resolved: false });
  }
  await db.query(
    `UPDATE student_profiles SET error_diary = $1 WHERE student_id = $2`,
    [JSON.stringify(diary.slice(-30)), studentId]
  );
}

export async function recordAnalogyUse(
  studentId: string,
  concept: string,
  analogy: string,
  domain: string,
  worked: boolean | null
): Promise<void> {
  const profile = await getStudentProfile(studentId);
  const library = [...profile.analogyLibrary];
  const entry = library.find(a => a.concept.toLowerCase() === concept.toLowerCase() && a.analogy === analogy);
  if (entry) {
    if (worked === true) entry.effectiveness = Math.min(1, entry.effectiveness + 0.15);
    if (worked === false) entry.effectiveness = Math.max(0, entry.effectiveness - 0.2);
    entry.usedAt = new Date();
  } else {
    library.push({ concept, analogy, domain, effectiveness: worked === false ? 0.3 : 0.6, usedAt: new Date() });
  }
  await db.query(
    `UPDATE student_profiles SET analogy_library = $1 WHERE student_id = $2`,
    [JSON.stringify(library.slice(-40)), studentId]
  );
}

export async function updateStudyStreak(studentId: string): Promise<number> {
  const profile = await getStudentProfile(studentId);
  const today = new Date().toDateString();
  const lastDate = profile.lastStudyDate?.toDateString();
  let newStreak = 1;

  if (lastDate) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (lastDate === today) {
      newStreak = profile.studyStreak;
    } else if (lastDate === yesterday.toDateString()) {
      newStreak = profile.studyStreak + 1;
    }
  }

  await db.query(
    `UPDATE student_profiles SET study_streak = $1, last_study_date = CURRENT_DATE, last_seen_at = NOW() WHERE student_id = $2`,
    [newStreak, studentId]
  );

  return newStreak;
}

export async function incrementTurns(studentId: string): Promise<void> {
  await db.query(`UPDATE student_profiles SET total_turns = total_turns + 1 WHERE student_id = $1`, [studentId]);
}

export async function incrementSessions(studentId: string): Promise<void> {
  await db.query(`UPDATE student_profiles SET total_sessions = total_sessions + 1 WHERE student_id = $1`, [studentId]);
}
