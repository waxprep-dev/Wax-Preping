import { db } from '../db/client';
import type { StudentProfile, MemoryBlocks } from '../types/student';

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
      `INSERT INTO student_profiles (student_id, memory_blocks)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
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
    learningStyle: (row.profile as { learningStyle?: StudentProfile['learningStyle'] })?.learningStyle || defaultLearningStyle(),
    emotionalProfile: (row.profile as { emotionalProfile?: StudentProfile['emotionalProfile'] })?.emotionalProfile || defaultEmotionalProfile(),
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

  if (operation === 'replace') {
    blocks[block] = content;
  } else if (operation === 'append') {
    const timestamp = new Date().toLocaleDateString();
    blocks[block] = blocks[block]
      ? `${blocks[block]}\n[${timestamp}]: ${content}`
      : content;
  } else if (operation === 'delete') {
    blocks[block] = DEFAULT_BLOCKS[block];
  }

  await db.query(
    `UPDATE student_profiles SET memory_blocks = $1, last_seen_at = NOW()
     WHERE student_id = $2`,
    [JSON.stringify(blocks), studentId]
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
    const wasYesterday = lastDate === yesterday.toDateString();
    const isToday = lastDate === today;

    if (isToday) {
      newStreak = profile.studyStreak; // Already studied today, don't increment
    } else if (wasYesterday) {
      newStreak = profile.studyStreak + 1;
    } else {
      newStreak = 1; // Streak broken
    }
  }

  await db.query(
    `UPDATE student_profiles
     SET study_streak = $1, last_study_date = CURRENT_DATE,
         total_sessions = total_sessions + 1, last_seen_at = NOW()
     WHERE student_id = $2`,
    [newStreak, studentId]
  );

  return newStreak;
}

export async function incrementTurns(studentId: string): Promise<void> {
  await db.query(
    `UPDATE student_profiles SET total_turns = total_turns + 1 WHERE student_id = $1`,
    [studentId]
  );
}

export async function updateConceptProgress(
  studentId: string,
  concept: string,
  subject: string,
  masteryDelta: number,
  misconception?: string,
  analogyUsed?: string
): Promise<void> {
  const profile = await getStudentProfile(studentId);
  const progress = profile.conceptProgress;

  if (!progress[concept]) {
    progress[concept] = {
      conceptId: concept.toLowerCase().replace(/\s+/g, '_'),
      conceptName: concept,
      subject,
      firstEncountered: new Date(),
      lastPracticed: new Date(),
      masteryLevel: 0,
      misconceptions: [],
      analogiesUsed: [],
      approachesSucceeded: [],
      approachesFailed: [],
      nextReviewAt: undefined,
      reviewInterval: 1,
      reviewCount: 0,
    };
  }

  const cp = progress[concept];
  cp.masteryLevel = Math.max(0, Math.min(1, cp.masteryLevel + masteryDelta));
  cp.lastPracticed = new Date();

  if (misconception && !cp.misconceptions.includes(misconception)) {
    cp.misconceptions.push(misconception);
  }

  if (analogyUsed && !cp.analogiesUsed.includes(analogyUsed)) {
    cp.analogiesUsed.push(analogyUsed);
  }

  await db.query(
    `UPDATE student_profiles SET concept_progress = $1 WHERE student_id = $2`,
    [JSON.stringify(progress), studentId]
  );
}

export async function addToKnowledgeGraph(
  studentId: string,
  entity: string,
  relation: string,
  target: string,
  confidence = 1.0
): Promise<void> {
  await db.query(
    `INSERT INTO knowledge_graph (student_id, entity, relation, target, confidence)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (student_id, entity, relation, target)
     DO UPDATE SET confidence = EXCLUDED.confidence`,
    [studentId, entity, relation, target, confidence]
  );
}

export async function queryKnowledgeGraph(
  studentId: string,
  entity: string
): Promise<{ relation: string; target: string; confidence: number }[]> {
  const result = await db.query(
    `SELECT relation, target, confidence FROM knowledge_graph
     WHERE student_id = $1 AND entity = $2
     ORDER BY confidence DESC`,
    [studentId, entity]
  );
  return result.rows;
}

export async function updateErrorDiary(
  studentId: string,
  concept: string,
  errorType: string
): Promise<void> {
  const profile = await getStudentProfile(studentId);
  const diary = profile.errorDiary;

  const existing = diary.find(e => e.concept === concept && e.errorType === errorType);
  if (existing) {
    existing.count++;
    existing.lastOccurred = new Date();
  } else {
    diary.push({ concept, errorType, count: 1, lastOccurred: new Date(), resolved: false });
  }

  await db.query(
    `UPDATE student_profiles SET error_diary = $1 WHERE student_id = $2`,
    [JSON.stringify(diary), studentId]
  );
}

export async function saveAnalogy(
  studentId: string,
  concept: string,
  analogy: string,
  domain: string,
  effectiveness: number
): Promise<void> {
  const profile = await getStudentProfile(studentId);
  const library = profile.analogyLibrary;

  const existing = library.find(a => a.concept === concept && a.analogy === analogy);
  if (existing) {
    existing.effectiveness = (existing.effectiveness + effectiveness) / 2;
  } else {
    library.push({ concept, analogy, domain, effectiveness, usedAt: new Date() });
  }

  await db.query(
    `UPDATE student_profiles SET analogy_library = $1 WHERE student_id = $2`,
    [JSON.stringify(library), studentId]
  );
}

export async function updateLastSeen(studentId: string): Promise<void> {
  await db.query(
    `INSERT INTO student_profiles (student_id, memory_blocks)
     VALUES ($1, $2)
     ON CONFLICT (student_id) DO UPDATE SET last_seen_at = NOW()`,
    [studentId, JSON.stringify(DEFAULT_BLOCKS)]
  );
}

function createDefault(studentId: string): StudentProfile {
  return {
    studentId,
    createdAt: new Date(),
    lastSeenAt: new Date(),
    totalSessions: 0,
    totalTurns: 0,
    studyStreak: 0,
    lastStudyDate: null,
    examTargets: [],
    culturalContext: defaultCulturalContext(),
    learningStyle: defaultLearningStyle(),
    emotionalProfile: defaultEmotionalProfile(),
    conceptProgress: {},
    errorDiary: [],
    analogyLibrary: [],
    memoryBlocks: { ...DEFAULT_BLOCKS },
    studyPlan: undefined,
  };
}

function defaultCulturalContext() {
  return { country: 'Nigeria', region: 'unknown', language: 'English', currency: 'Naira', examBoards: ['WAEC', 'JAMB'], culturalReferences: [], timezone: 'Africa/Lagos' };
}

function defaultLearningStyle() {
  return { prefersAnalogies: false, analogyDomains: [], prefersVisualDescriptions: false, prefersMath: false, prefersStoryForm: false, prefersVoice: false, toleratesAbstraction: 0.5, preferredPace: 'normal' as const, prefersShortAnswers: false, prefersSocratic: false, respondsToHumor: false, respondsToChallenge: false };
}

function defaultEmotionalProfile() {
  return { shameThreshold: 0.5, curiosityLevel: 0.5, frustrationTolerance: 0.5, prideIntelligence: false, respondsToHumor: false, needsExplicitValidation: false, avoidsAdmittingConfusion: false, messagesAfterMidnight: false };
}