// The student is not a row in a database with a "level" field.
// The student is a complex human being whose profile emerges from conversation.
// Nothing here is hardcoded. Everything here is discovered.

export interface StudentProfile {
  studentId: string;           // Their WhatsApp number
  createdAt: Date;
  lastSeenAt: Date;

  // These are INFERRED, not filled out by the student
  inferredName?: string;
  inferredLocation?: string;   // Lagos, Abuja, rural north, etc. — only if mentioned
  inferredSchoolType?: string; // secondary, university, polytechnic — inferred
  inferredExamTargets: string[]; // WAEC, JAMB, NECO, Post-UTME — inferred from messages

  // Learning preferences — discovered through conversation, not surveys
  learningStyle: {
    prefersAnalogies: boolean;
    analogyDomains: string[];  // market, sports, music, food — whatever resonates
    prefersVisualDescriptions: boolean;
    prefersMath: boolean;
    prefersStoryForm: boolean;
    toleratesAbstraction: number; // 0.0 (concrete only) to 1.0 (loves abstraction)
  };

  // Emotional profile — discovered, not tested
  emotionalProfile: {
    shameThreshold: number;     // How quickly they withdraw under pressure
    curiosityLevel: number;     // Their baseline curiosity
    frustrationTolerance: number;
    prideIntelligence: boolean; // Do they care about seeming smart?
    respondsToHumor: boolean;
  };

  // Topics they have explored — NOT a hardcoded syllabus
  // Keys are concept identifiers discovered organically, not from a schema
  conceptProgress: Record<string, ConceptProgress>;

  // Raw memory blocks — the AI's private notebook
  memoryBlocks: {
    humanProfile: string;    // What I know about this student as a person
    learningStyle: string;   // How this student learns best
    progress: string;        // What we've covered, what to do next
    shameMap: string;        // What triggers shame for this student
    curiosityMap: string;    // What lights this student up
    procedural: string;      // How I should behave with this student specifically
  };
}

export interface ConceptProgress {
  conceptId: string;
  conceptName: string;
  subject: string;         // Discovered, not hardcoded
  firstEncountered: Date;
  lastPracticed: Date;
  masteryLevel: number;    // 0.0 to 1.0
  misconceptions: string[];
  analogiesUsed: string[];
  nextReviewAt?: Date;     // Spaced repetition schedule
}

export interface Session {
  sessionId: string;
  studentId: string;
  startedAt: Date;
  lastActivityAt: Date;
  turnCount: number;
  conversationHistory: ConversationTurn[];
  currentTopicTrail: string[];  // Topics discussed in order, not a hardcoded path
  isActive: boolean;
}

export interface ConversationTurn {
  turnId: string;
  sessionId: string;
  studentId: string;
  turnNumber: number;
  studentMessage: string;
  tutorResponse: string;
  emotionalSnapshot: import('./events').EmotionalSnapshot;
  plannerForce: import('./events').PlannerForceEmitted['forceVector'] | null;
  modelUsed: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  toolsUsed: string[];
  timestamp: Date;
}