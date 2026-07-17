/**
 * Teaching-engine types — the heart of v2.0.
 *
 * The v1 system scattered its "thinking" across 5-9 sequential LLM calls
 * (router, emotional agent, cultural agent, chain stages 1-3, pedagogy agent,
 * curriculum agent) that each saw a different slice of context. v2.0 fuses
 * this into a Perception -> Deliberation -> Generation pipeline where one
 * deliberation call sees everything and produces a TeachingPlan that drives
 * generation. This mirrors the Perception-Orchestration-Elicitation framework
 * from recent Socratic-tutor research and cuts per-turn latency/cost by ~60%.
 */
import type { EmotionalSnapshot, SessionState, StudentProfile, WorkingMemorySnapshot, BloomLevel } from './student';
import type { UsageSummary } from './llm';

/** Output of the perception layer: one structured read of the student's message. */
export interface PerceptionResult {
  rawMessage: string;
  modality: string;
  primaryIntent:
    | 'asking_explanation'
    | 'asking_answer'
    | 'expressing_confusion'
    | 'expressing_emotion'
    | 'casual_chat'
    | 'exam_prep'
    | 'requesting_plan'
    | 'sharing_work'
    | 'meta_about_self'
    | 'greeting'
    | 'other';
  inferredTopic: string | null;
  inferredSubject: string | null;
  hasMisconception: boolean;
  misconceptionDescription: string | null;
  emotionalSignals: EmotionalSnapshot & { dominantEmotion: string };
  urgency: 'critical' | 'high' | 'normal' | 'low';
  cognitiveLoad: 'low' | 'medium' | 'high' | 'overloaded';
  masterySignal: 'none' | 'partial' | 'strong';
  languageStyle: string;
  temporalPressure: 'none' | 'soon' | 'urgent';
  isRepeatedQuestion: boolean;
  repetitionCount: number;
  visionContext?: Record<string, unknown>;
  paralinguistics?: Record<string, unknown>;
  documentContext?: Record<string, unknown>;
}

/** The strategy repertoire. Kept as a string union so the plan is typed end to end. */
export type TeachingStrategy =
  | 'socratic'
  | 'direct_explanation'
  | 'analogy_bridge'
  | 'scaffolded_steps'
  | 'worked_example'
  | 'metacognitive'
  | 'celebration'
  | 'reassurance'
  | 'pivot_completely'
  | 'hint_ladder'
  | 'prerequisite_first'
  | 'retrieval_practice'
  | 'elaborative_interrogation'
  | 'listen_and_connect';

/**
 * The TeachingPlan: output of the single deliberation call.
 * Everything generation needs, nothing it doesn't.
 */
export interface TeachingPlan {
  strategy: TeachingStrategy;
  strategyReason: string;
  warmthLevel: number;
  challengeLevel: number;
  pacing: 'slow' | 'normal' | 'fast';
  hintLevel: number;
  useAnalogy: boolean;
  analogyDomain: string | null;
  askQuestion: boolean;
  questionPurpose: 'check_understanding' | 'spark_curiosity' | 'guide_thinking' | 'none';
  addressMisconception: boolean;
  misconceptionCorrection: string | null;
  connectToMemory: string | null;
  emotionalApproach: string;
  mustInclude: string[];
  mustAvoid: string[];
  sessionGoal: string;
  bloomTarget: BloomLevel;
  relationshipStage: 'new' | 'familiar' | 'established';
  needsTools: string[];
  expectedOutcome: string;
}

/** Everything assembled for one turn. Single context object passed through the pipeline. */
export interface TurnContext {
  studentId: string;
  sessionId: string;
  messageId: string;
  isFirstMessage: boolean;
  profile: StudentProfile;
  sessionState: SessionState;
  workingMemory: WorkingMemorySnapshot;
  perception: PerceptionResult;
  conversationHistory: string;
  recalledEpisodes: string;
  dueReviews: string;
  reflectionLessons: string;
  worldModelInsight: string;
  causalInsight: string;
  toolContext: string;
  subjectContext: string;
}

export interface TurnResult {
  responseText: string;
  plan: TeachingPlan;
  perception: PerceptionResult;
  defensePassed: boolean;
  defenseIssues: string[];
  masteryAssessment: 'mastered' | 'progressing' | 'struggling' | 'surface_learned' | 'unknown';
  usage: UsageSummary;
  latencyMs: number;
}
