/**
 * Student-domain types: profiles, memory, sessions, concept progress.
 *
 * v2.0 changes:
 * - ConceptProgress gains BKT-inspired evidence counters (successCount,
 *   attemptCount, bloomLevel) so mastery is computed from accumulated
 *   evidence, not overwritten by a single LLM judgment.
 * - WorkingMemorySnapshot is now hydrated from the persisted session_state
 *   row (survives restarts) merged with recent turns.
 * - Added StudentFact: structured, extracted facts about the learner that the
 *   student-model updater writes after every turn. This is what makes the
 *   profile actually learn (in v1 the memory blocks stayed at their defaults
 *   forever for most students).
 * - PedagogicalIntent is superseded by PerceptionResult (types/teaching.ts)
 *   but kept for encoder backward compatibility.
 */

export interface EmotionalSnapshot {
  valence: number;
  arousal: number;
  dominance: number;
  shamePotential: number;
  curiosity: number;
  selfEfficacy: number;
  flowIndicator: number;
  frustration: number;
  tiredness: number;
  excitement: number;
}

export interface PedagogicalIntent {
  primaryIntent: string;
  hasMisconception: boolean;
  misconceptionDescription?: string;
  inferredTopic?: string;
  inferredSubject?: string;
  inferredKnowledgeLevel: number;
  temporalPressure: string;
  rawMessage: string;
  emotionalSignals: EmotionalSnapshot;
  messageLength: number;
  containsQuestion: boolean;
  languageStyle: string;
  isRepeatedQuestion: boolean;
  repetitionCount: number;
  [key: string]: unknown;
}

export interface AIAnalysis {
  emotionalReading?: Partial<EmotionalSnapshot> & { dominantEmotion?: string };
  primaryIntent?: string;
  hasMisconception?: boolean;
  misconceptionDescription?: string;
  inferredTopic?: string;
  inferredSubject?: string;
  inferredKnowledgeLevel?: number;
  temporalPressure?: string;
  languageStyle?: string;
  pedagogicalStrategy?: string;
  shouldSearch?: boolean;
  searchQuery?: string;
  cognitiveLoad?: string;
  sessionPhase?: string;
  stuckDetected?: boolean;
  masterySignalDetected?: boolean;
  masteryEvidenceType?: string;
  bloomLevel?: string;
}

export interface SalientTurn {
  role: 'student' | 'tutor';
  content: string;
  salienceScore: number;
}

export interface WorkingMemorySnapshot {
  currentTopic: string | null;
  currentSubject: string | null;
  lastMisconception: string | null;
  lastAnalogyUsed: string | null;
  studentConfidence: number;
  turnsInCurrentTopic: number;
  salienceRankedTurns: SalientTurn[];
  backgroundSummary: string;
  unresolvedQuestion: string | null;
  stuckRepetitionCount: number;
  approachesAttempted: string[];
  conceptsVisitedThisSession: string[];
  hintLevelCurrent: number;
  lastScaffoldUsed?: string | null;
  lastPaceUsed?: string | null;
  lastStrategy?: string | null;
  bloomLevel?: string | null;
  [key: string]: unknown;
}

export type BeliefStatus = 'MASTERS' | 'UNDERSTANDS' | 'CONFUSES' | 'HAS_NOT_SEEN';

export interface SymbolicBelief {
  claim: string;
  status: BeliefStatus;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  updatedAt: Date;
}

export type BloomLevel = 'remember' | 'understand' | 'apply' | 'analyze' | 'evaluate' | 'create';

export interface ConceptProgress {
  conceptId: string;
  conceptName: string;
  subject: string;
  firstEncountered: Date;
  lastPracticed: Date;
  masteryLevel: number;
  symbolicBeliefs: SymbolicBelief[];
  misconceptions: string[];
  analogiesUsed: string[];
  nextReviewAt?: Date;
  reviewInterval: number;
  reviewCount: number;
  successCount: number;
  attemptCount: number;
  bloomLevel: BloomLevel;
  lastResult?: 'success' | 'struggle' | 'neutral';
}

export interface ErrorEntry {
  concept: string;
  errorType: string;
  count: number;
  lastOccurred: Date;
  resolved: boolean;
}

export interface AnalogyEntry {
  concept: string;
  analogy: string;
  domain: string;
  effectiveness: number;
  usedAt: Date;
}

export interface MemoryBlocks {
  humanProfile: string;
  learningStyle: string;
  progress: string;
  shameMap: string;
  curiosityMap: string;
  procedural: string;
  examStrategy: string;
  errorPatterns: string;
  breakthroughs: string;
  [key: string]: string;
}

export interface CulturalContext {
  country: string;
  region: string;
  language: string;
  currency: string;
  examBoards: string[];
  timezone: string;
  [key: string]: unknown;
}

export interface ExamTarget {
  examType: string;
  examDate?: string;
  subjects: string[];
  targetScore?: number;
}

export interface WeeklyTarget {
  week: number;
  concepts: string[];
  isCompleted: boolean;
  focus?: string;
  rationale?: string;
}

export interface StudyPlan {
  createdAt: Date;
  examDate: Date;
  subject: string;
  weeklyTargets: WeeklyTarget[];
  currentWeek: number;
}

export interface StudentFact {
  factKey: string;
  factValue: string;
  confidence: number;
  source: string;
  updatedAt: Date;
}

export interface StudentProfile {
  studentId: string;
  createdAt: Date;
  lastSeenAt: Date;
  totalSessions: number;
  totalTurns: number;
  studyStreak: number;
  lastStudyDate: Date | null;
  examTargets: ExamTarget[];
  culturalContext: CulturalContext;
  conceptProgress: Record<string, ConceptProgress>;
  errorDiary: ErrorEntry[];
  analogyLibrary: AnalogyEntry[];
  memoryBlocks: MemoryBlocks;
  facts: Record<string, StudentFact>;
  studyPlan?: StudyPlan;
}

export interface ConversationTurn {
  turnId: string;
  sessionId: string;
  studentId: string;
  turnNumber: number;
  studentMessage: string;
  tutorResponse: string;
  modality: string;
  aiAnalysis: Partial<AIAnalysis>;
  modelUsed: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  toolsUsed: string[];
  topic?: string;
  subject?: string;
  masteryEvidenced?: boolean;
  reflectionScore?: number;
  timestamp: Date;
}

export interface Session {
  sessionId: string;
  studentId: string;
  startedAt: Date;
  lastActivityAt: Date;
  turnCount: number;
  isActive: boolean;
  state: SessionState;
  isNewSession: boolean;
}

/**
 * Persistent per-session teaching state. This is what lets the tutor behave
 * consistently within a conversation without re-deriving everything from
 * regexes over the transcript on every turn (the v1 approach).
 */
export interface SessionState {
  currentConcept: string | null;
  currentSubject: string | null;
  hintLevel: number;
  approachesTried: string[];
  struggleCount: number;
  lastStrategy: string | null;
  bloomLevel: BloomLevel | null;
  unresolvedQuestion: string | null;
  /** Anti-interrogation accounting (v1 teach-first policy). */
  consecutiveQuestions: number;
  questionsThisSession: number;
  lastTutorAskedQuestion: boolean;
  turnsSinceLastTeach: number;
  lastMove: string | null;
  readinessSignal: boolean;
  foundationGapDisclosed: boolean;
}
