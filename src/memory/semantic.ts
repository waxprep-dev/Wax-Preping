import { db } from '../db/client';
import type { StudentProfile, MemoryBlocks, SymbolicBelief } from '../types/student';

const DEFAULT_BLOCKS: MemoryBlocks = {
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

export async function getStudentProfile(studentId: string): Promise<StudentProfile> {
  const result = await db.query(
    `SELECT * FROM student_profiles WHERE student_id = $1`,
    [studentId]
  );

  if (result.rows.length === 0) {
    await db.query(
      `INSERT INTO student_profiles (student_id, memory_blocks) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [studentId, JSON.stringify(DEFAULT_BLOCKS)]
    );
    return createDefault(studentId);
  }

  const row = result.rows[0];
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
    studyPlan: row.study_plan,
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
  const timestamp = new Date().toLocaleDateString();

  if (operation === 'replace') {
    blocks[block] = content;
  } else if (operation === 'append') {
    blocks[block] = blocks[block] ? `${blocks[block]}\n[${timestamp}]: ${content}` : content;
  } else if (operation === 'delete') {
    blocks[block] = DEFAULT_BLOCKS[block];
  }

  await db.query(
    `UPDATE student_profiles SET memory_blocks = $1, last_seen_at = NOW() WHERE student_id = $2`,
    [JSON.stringify(blocks), studentId]
  );
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
  const progress = profile.conceptProgress;

  if (!progress[concept]) {
    progress[concept] = {
      conceptId: concept.toLowerCase().replace(/\s+/g, '_'),
      conceptName: concept,
      subject: 'General',
      firstEncountered: new Date(),
      lastPracticed: new Date(),
      masteryLevel: 0.1,
      symbolicBeliefs: [],
      misconceptions: [],
      analogiesUsed: [],
      nextReviewAt: undefined,
      reviewInterval: 1,
      reviewCount: 0,
    };
  }

  const cp = progress[concept];
  if (!cp.symbolicBeliefs) cp.symbolicBeliefs = [];

  // Update or add belief
  const existing = cp.symbolicBeliefs.find(b => b.claim === claim);
  if (existing) {
    existing.status = status;
    existing.confidence = confidence;
    existing.evidence = evidence;
    existing.updatedAt = new Date();
  } else {
    cp.symbolicBeliefs.push({ claim, status, confidence, evidence, updatedAt: new Date() });
  }

  // Update mastery level based on belief status
  const masterCount = cp.symbolicBeliefs.filter(b => b.status === 'MASTERS').length;
  const understandCount = cp.symbolicBeliefs.filter(b => b.status === 'UNDERSTANDS').length;
  const total = cp.symbolicBeliefs.length;

  if (total > 0) {
    cp.masteryLevel = (masterCount * 1.0 + understandCount * 0.6) / total;
  }

  cp.lastPracticed = new Date();

  await db.query(
    `UPDATE student_profiles SET concept_progress = $1 WHERE student_id = $2`,
    [JSON.stringify(progress), studentId]
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
    `UPDATE student_profiles SET study_streak = $1, last_study_date = CURRENT_DATE, total_sessions = total_sessions + 1, last_seen_at = NOW() WHERE student_id = $2`,
    [newStreak, studentId]
  );

  return newStreak;
}

export async function incrementTurns(studentId: string): Promise<void> {
  await db.query(`UPDATE student_profiles SET total_turns = total_turns + 1 WHERE student_id = $1`, [studentId]);
}

export async function updateLastSeen(studentId: string): Promise<void> {
  await db.query(
    `INSERT INTO student_profiles (student_id, memory_blocks) VALUES ($1, $2) ON CONFLICT (student_id) DO UPDATE SET last_seen_at = NOW()`,
    [studentId, JSON.stringify(DEFAULT_BLOCKS)]
  );
}

function createDefault(studentId: string): StudentProfile {
  return {
    studentId, createdAt: new Date(), lastSeenAt: new Date(),
    totalSessions: 0, totalTurns: 0, studyStreak: 0, lastStudyDate: null,
    examTargets: [], culturalContext: defaultCulturalContext(),
    conceptProgress: {}, errorDiary: [], analogyLibrary: [],
    memoryBlocks: { ...DEFAULT_BLOCKS },
  };
}

function defaultCulturalContext() {
  return { country: 'Nigeria', region: 'unknown', language: 'English', currency: 'Naira', examBoards: ['WAEC', 'JAMB'], timezone: 'Africa/Lagos' };
}