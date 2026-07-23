/**
 * Teach-first policy engine.
 *
 * Turns raw perception + session state into hard constraints on the TeachingPlan
 * so the tutor cannot default to endless Socratic interrogation.
 *
 * Research grounding (applied, not cargo-culted):
 * - Direct Instruction / Explicit Instruction (Rosenshine, Engelmann): when a
 *   novice signals readiness or "I don't know", TEACH a micro-chunk first.
 * - Productive Struggle is only productive after a clear model exists.
 * - Tutoring research (Bloom 2-sigma, Chi, Graesser AutoTutor): expert tutors
 *   alternate explanation, modeling, and sparse, purposeful questions — they
 *   do not end every turn with a question.
 * - Cognitive Load Theory (Sweller): for low foundation / high load, reduce
 *   extraneous dialogue (interrogation) and increase worked structure.
 * - Zone of Proximal Development: scaffold by teaching the next doable step,
 *   not by asking the student to invent the map of a city they just entered.
 */

import type { PerceptionResult, TeachingPlan, TeachingStrategy } from '../types/teaching';
import type { SessionState, StudentProfile } from '../types/student';
import { uniqueStrings } from '../utils/math';

export type MoveType =
  | 'welcome_and_orient'
  | 'teach_micro_chunk'
  | 'model_then_check'
  | 'guided_practice'
  | 'retrieval_check'
  | 'listen_and_hold'
  | 'reassurance_only'
  | 'diagnostic_probe'
  | 'celebrate_and_advance'
  | 'wrap_and_invite_back';

export interface TeachingPolicy {
  move: MoveType;
  forceAskQuestion: boolean | null; // null = leave to deliberation; true/false = hard override
  maxQuestionsThisTurn: 0 | 1;
  preferredStrategies: TeachingStrategy[];
  bannedStrategies: TeachingStrategy[];
  mustTeachContent: boolean;
  reason: string;
  mustInclude: string[];
  mustAvoid: string[];
  emotionalApproach: string;
  sessionGoal: string;
  pacing: 'slow' | 'normal' | 'fast';
  warmthLevel: number;
  challengeLevel: number;
  bloomTarget: TeachingPlan['bloomTarget'];
}

const READY_PATTERNS = [
  /\b(i'?m|i am|am)\s+ready\b/i,
  /\bready\s+(to\s+)?(start|learn|begin|go)\b/i,
  /\blet'?s\s+(start|begin|go|learn)\b/i,
  /\bstart\s+(teaching|now|please)\b/i,
  /\bok(ay)?\s*(i'?m|i am)?\s*ready\b/i,
  /\bteach\s+me\b/i,
  /\bi\s+want\s+to\s+learn\b/i,
];

const DONT_KNOW_PATTERNS = [
  /\bi\s+don'?t\s+know\b/i,
  /\bidk\b/i,
  /\bno\s+idea\b/i,
  /\bnot\s+sure\b/i,
  /\bi\s+have\s+no\s+idea\b/i,
  /\bdunno\b/i,
  /\bi\s+can'?t\s+(tell|say|remember)\b/i,
];

const EXIT_PATTERNS = [
  /\bbye\b/i,
  /\bgoodbye\b/i,
  /\bsee\s+you\b/i,
  /\bi'?m\s+busy\b/i,
  /\bwill\s+come\s+back\b/i,
  /\btalk\s+later\b/i,
  /\bg2g\b/i,
  /\bgotta\s+go\b/i,
  /\blater\b/i,
  /\bi\s+have\s+to\s+(go|leave)\b/i,
];

const SHORT_ACK_PATTERNS = [
  /^(ok|okay|k|alright|fine|cool|great|nice|yes|yeah|yep|sure|hmm+|mhm+|wow|lol|haha+|👍|🙂|😊|🙏)+[\s!.]*$/i,
  /^(nothing|nothing much|sup|hi|hello|hey|helo|hii+)\b/i,
];

const FOUNDATION_GAP_PATTERNS = [
  /\bfoundation\s+is\s+poor\b/i,
  /\bdid\s+not\s+do\s+ss\s*3\b/i,
  /\bdidn'?t\s+do\s+ss\s*3\b/i,
  /\bhave\s+not\s+been\s+reading\b/i,
  /\bhaven'?t\s+(been\s+)?reading\b/i,
  /\bweak\s+(in|at|on)\b/i,
  /\bstarting\s+from\s+(zero|scratch)\b/i,
  /\bi\s+know\s+nothing\b/i,
];

export function detectStudentSignals(message: string): {
  readyToLearn: boolean;
  doesNotKnow: boolean;
  wantsExit: boolean;
  shortAck: boolean;
  foundationGap: boolean;
} {
  const text = (message || '').trim();
  return {
    readyToLearn: READY_PATTERNS.some(p => p.test(text)),
    doesNotKnow: DONT_KNOW_PATTERNS.some(p => p.test(text)),
    wantsExit: EXIT_PATTERNS.some(p => p.test(text)),
    shortAck: SHORT_ACK_PATTERNS.some(p => p.test(text)),
    foundationGap: FOUNDATION_GAP_PATTERNS.some(p => p.test(text)),
  };
}

/**
 * Decide hard teaching constraints for this turn.
 * Policy wins over soft LLM deliberation when forceAskQuestion is non-null.
 */
export function decideTeachingPolicy(input: {
  perception: PerceptionResult;
  profile: StudentProfile;
  sessionState: SessionState;
  isFirstMessage: boolean;
  consecutiveQuestions?: number;
  questionsThisSession?: number;
  lastTutorAskedQuestion?: boolean;
  turnsSinceLastTeach?: number;
}): TeachingPolicy {
  const {
    perception,
    profile,
    sessionState,
    isFirstMessage,
  } = input;

  const signals = detectStudentSignals(perception.rawMessage);
  const consecutiveQuestions = input.consecutiveQuestions ?? sessionState.consecutiveQuestions ?? 0;
  const questionsThisSession = input.questionsThisSession ?? sessionState.questionsThisSession ?? 0;
  const lastTutorAskedQuestion = input.lastTutorAskedQuestion ?? sessionState.lastTutorAskedQuestion ?? false;
  const turnsSinceLastTeach = input.turnsSinceLastTeach ?? sessionState.turnsSinceLastTeach ?? 0;
  const es = perception.emotionalSignals;
  const totalTurns = profile.totalTurns;
  const knownGoal =
    profile.facts?.intended_course?.factValue ||
    profile.facts?.goal?.factValue ||
    profile.facts?.subject_interest?.factValue ||
    null;

  // ── Exit / overwhelm ────────────────────────────────────────────────────
  if (signals.wantsExit || es.tiredness > 0.75 || perception.cognitiveLoad === 'overloaded') {
    return {
      move: 'wrap_and_invite_back',
      forceAskQuestion: false,
      maxQuestionsThisTurn: 0,
      preferredStrategies: ['reassurance', 'listen_and_connect'],
      bannedStrategies: ['socratic', 'elaborative_interrogation', 'retrieval_practice', 'hint_ladder'],
      mustTeachContent: false,
      reason: 'Student is leaving or overloaded — close warmly, zero interrogation',
      mustInclude: ['acknowledge they can return anytime', 'one concrete next step they can pick up later'],
      mustAvoid: [
        'any question',
        'guilt about leaving',
        'long lecture',
        'Welcome to our tutoring',
        'Do you understand',
      ],
      emotionalApproach: 'Warm, brief, non-clinging. Protect their energy.',
      sessionGoal: 'Leave the door open without pressure',
      pacing: 'slow',
      warmthLevel: 0.95,
      challengeLevel: 0.1,
      bloomTarget: 'remember',
    };
  }

  // ── Emotional crisis / shame ────────────────────────────────────────────
  if (perception.primaryIntent === 'expressing_emotion' || es.shamePotential > 0.7) {
    return {
      move: 'reassurance_only',
      forceAskQuestion: false,
      maxQuestionsThisTurn: 0,
      preferredStrategies: ['reassurance', 'listen_and_connect'],
      bannedStrategies: ['socratic', 'elaborative_interrogation', 'retrieval_practice'],
      mustTeachContent: false,
      reason: 'Emotional safety first — no quiz, no diagnostic grill',
      mustInclude: ['validate without naming shame', 'offer a tiny optional next step later'],
      mustAvoid: ['any quiz-like question', 'why did you', 'what made you'],
      emotionalApproach: 'Maximum warmth, zero performance pressure',
      sessionGoal: 'Restore safety and agency',
      pacing: 'slow',
      warmthLevel: 0.95,
      challengeLevel: 0.15,
      bloomTarget: 'remember',
    };
  }

  // ── Student said "I don't know" ─────────────────────────────────────────
  // Master-teacher move: STOP asking. Teach the smallest clear chunk.
  if (signals.doesNotKnow || (lastTutorAskedQuestion && perception.rawMessage.trim().length < 40 && /don'?t|idk|no idea|not sure/i.test(perception.rawMessage))) {
    return {
      move: 'teach_micro_chunk',
      forceAskQuestion: false,
      maxQuestionsThisTurn: 0,
      preferredStrategies: ['direct_explanation', 'worked_example', 'scaffolded_steps', 'analogy_bridge'],
      bannedStrategies: ['socratic', 'elaborative_interrogation', 'retrieval_practice'],
      mustTeachContent: true,
      reason: 'Student does not know — teach a micro-chunk instead of asking again',
      mustInclude: [
        'one clear mini-explanation of the next concept',
        'one concrete everyday example',
        'stop after the chunk — invite them to react when ready WITHOUT a quiz question',
      ],
      mustAvoid: [
        'ending with a question',
        'asking what they think first',
        'So in the same way (forced formula)',
        'Do you understand',
      ],
      emotionalApproach: 'Calm expert energy: "No wahala — here is the first piece."',
      sessionGoal: 'Give them a solid foothold so the next step is possible',
      pacing: 'slow',
      warmthLevel: 0.85,
      challengeLevel: 0.25,
      bloomTarget: 'understand',
    };
  }

  // ── Student said they are ready ─────────────────────────────────────────
  if (signals.readyToLearn) {
    return {
      move: 'teach_micro_chunk',
      forceAskQuestion: false,
      maxQuestionsThisTurn: 0,
      preferredStrategies: ['direct_explanation', 'worked_example', 'scaffolded_steps'],
      bannedStrategies: ['socratic', 'elaborative_interrogation', 'listen_and_connect'],
      mustTeachContent: true,
      reason: 'Student declared readiness — begin teaching immediately',
      mustInclude: [
        'start teaching the first concrete concept now',
        'one short definition + one local example',
        'no diagnostic interview',
      ],
      mustAvoid: [
        'asking what they think the first step is',
        'ending with a question',
        'Welcome to our tutoring sessions',
      ],
      emotionalApproach: 'Confident coach who starts the lesson, not an interviewer',
      sessionGoal: 'Deliver the first real learning win of the session',
      pacing: 'normal',
      warmthLevel: 0.8,
      challengeLevel: 0.35,
      bloomTarget: 'understand',
    };
  }

  // ── Foundation gap disclosed ────────────────────────────────────────────
  if (signals.foundationGap || (sessionState.struggleCount >= 1 && (profile.facts?.foundation_level?.factValue || '').includes('poor'))) {
    return {
      move: 'teach_micro_chunk',
      forceAskQuestion: questionsThisSession === 0 ? null : false,
      maxQuestionsThisTurn: questionsThisSession === 0 ? 1 : 0,
      preferredStrategies: ['prerequisite_first', 'direct_explanation', 'worked_example', 'scaffolded_steps'],
      bannedStrategies: ['socratic', 'elaborative_interrogation'],
      mustTeachContent: true,
      reason: 'Weak foundation disclosed — build from absolute basics with teaching, not grilling',
      mustInclude: [
        'start at absolute basics without judgment',
        'one tiny concept only',
        'frame as building a strong base, not remediation shame',
      ],
      mustAvoid: ['you should already know', 'this is easy', 'interrogation chain'],
      emotionalApproach: 'Respectful builder energy — foundations first, zero shame',
      sessionGoal: 'Install the first brick of a stable foundation',
      pacing: 'slow',
      warmthLevel: 0.9,
      challengeLevel: 0.2,
      bloomTarget: 'remember',
    };
  }

  // ── Question budget exhausted (anti-interrogation) ──────────────────────
  if (consecutiveQuestions >= 2 || (lastTutorAskedQuestion && turnsSinceLastTeach >= 2)) {
    return {
      move: 'teach_micro_chunk',
      forceAskQuestion: false,
      maxQuestionsThisTurn: 0,
      preferredStrategies: ['direct_explanation', 'worked_example', 'scaffolded_steps', 'analogy_bridge'],
      bannedStrategies: ['socratic', 'elaborative_interrogation'],
      mustTeachContent: true,
      reason: `Question budget exceeded (consecutive=${consecutiveQuestions}) — force a teaching turn`,
      mustInclude: ['teach something concrete this turn', 'no ending question'],
      mustAvoid: ['another question', 'check_understanding quiz'],
      emotionalApproach: 'Teacher who finally explains instead of probing',
      sessionGoal: 'Break the interrogation loop with real content',
      pacing: 'normal',
      warmthLevel: 0.8,
      challengeLevel: 0.4,
      bloomTarget: 'understand',
    };
  }

  // ── First message / early relationship ──────────────────────────────────
  if (isFirstMessage || totalTurns === 0) {
    return {
      move: 'welcome_and_orient',
      forceAskQuestion: true,
      maxQuestionsThisTurn: 1,
      preferredStrategies: ['listen_and_connect', 'reassurance'],
      bannedStrategies: ['socratic', 'elaborative_interrogation', 'retrieval_practice'],
      mustTeachContent: false,
      reason: 'Brand new student — human welcome, at most one natural question, no formal onboarding script',
      mustInclude: [
        'sound like a real person texting, not a registration form',
        'mirror their energy',
      ],
      mustAvoid: [
        'Welcome to our tutoring sessions',
        'I\'m super excited to have you on board',
        'what made you decide to reach out',
        'multiple questions',
        'Certainly',
        'Great question',
      ],
      emotionalApproach: 'Casual, warm peer-mentor. Match their register.',
      sessionGoal: 'Make contact feel human and safe',
      pacing: 'normal',
      warmthLevel: 0.85,
      challengeLevel: 0.2,
      bloomTarget: 'remember',
    };
  }

  // ── Short ack / low-content replies ─────────────────────────────────────
  if (signals.shortAck || (perception.rawMessage.trim().length < 12 && perception.primaryIntent === 'casual_chat')) {
    // If we already know their goal, TEACH. Don't re-interview.
    if (knownGoal || sessionState.currentConcept || sessionState.currentSubject) {
      return {
        move: 'teach_micro_chunk',
        forceAskQuestion: false,
        maxQuestionsThisTurn: 0,
        preferredStrategies: ['direct_explanation', 'worked_example'],
        bannedStrategies: ['socratic', 'elaborative_interrogation'],
        mustTeachContent: true,
        reason: 'Short reply but we already know enough context — teach, do not re-probe',
        mustInclude: ['continue or start a concrete mini-lesson from known goal/subject'],
        mustAvoid: ['what made you', 'what\'s on your mind', 'another diagnostic question'],
        emotionalApproach: 'Move the lesson forward lightly',
        sessionGoal: 'Convert low-content reply into learning progress',
        pacing: 'normal',
        warmthLevel: 0.8,
        challengeLevel: 0.35,
        bloomTarget: 'understand',
      };
    }
    return {
      move: 'diagnostic_probe',
      forceAskQuestion: true,
      maxQuestionsThisTurn: 1,
      preferredStrategies: ['listen_and_connect'],
      bannedStrategies: ['socratic', 'elaborative_interrogation', 'retrieval_practice'],
      mustTeachContent: false,
      reason: 'Low-content message and little known — one gentle orientation question only',
      mustInclude: ['one simple question about subject or goal'],
      mustAvoid: ['stacked questions', 'therapy-style probing'],
      emotionalApproach: 'Light and easy',
      sessionGoal: 'Learn the one fact needed to start teaching',
      pacing: 'normal',
      warmthLevel: 0.8,
      challengeLevel: 0.2,
      bloomTarget: 'remember',
    };
  }

  // ── Student shared rich self-info (meta_about_self / goals) ─────────────
  if (perception.primaryIntent === 'meta_about_self' || perception.primaryIntent === 'exam_prep') {
    const subject = perception.inferredSubject || sessionState.currentSubject;
    return {
      move: subject ? 'teach_micro_chunk' : 'model_then_check',
      forceAskQuestion: subject ? false : true,
      maxQuestionsThisTurn: subject ? 0 : 1,
      preferredStrategies: subject
        ? ['direct_explanation', 'prerequisite_first', 'scaffolded_steps']
        : ['listen_and_connect', 'direct_explanation'],
      bannedStrategies: ['socratic', 'elaborative_interrogation'],
      mustTeachContent: Boolean(subject),
      reason: 'Student volunteered goals/context — acknowledge briefly then teach or ask ONE clarifying fact only if needed',
      mustInclude: subject
        ? ['acknowledge their path without pity', 'start a foundation mini-lesson']
        : ['acknowledge their path', 'ask only the single missing fact needed to start'],
      mustAvoid: ['interrogation chain', 'forced analogy formula', 'false reassurance about exam scores'],
      emotionalApproach: 'Honest, encouraging mentor who moves into action',
      sessionGoal: 'Translate their story into a first learning action',
      pacing: 'normal',
      warmthLevel: 0.85,
      challengeLevel: 0.3,
      bloomTarget: 'understand',
    };
  }

  // ── Confusion ───────────────────────────────────────────────────────────
  if (perception.primaryIntent === 'expressing_confusion' || es.frustration > 0.55) {
    return {
      move: 'model_then_check',
      forceAskQuestion: consecutiveQuestions >= 1 ? false : null,
      maxQuestionsThisTurn: consecutiveQuestions >= 1 ? 0 : 1,
      preferredStrategies: ['worked_example', 'scaffolded_steps', 'direct_explanation', 'pivot_completely'],
      bannedStrategies: consecutiveQuestions >= 1 ? ['socratic', 'elaborative_interrogation'] : [],
      mustTeachContent: true,
      reason: 'Confusion — re-explain with a simpler model before asking anything',
      mustInclude: ['simpler re-explanation', 'one worked micro-example'],
      mustAvoid: ['same explanation louder', 'blaming the student'],
      emotionalApproach: 'Patient expert, smaller steps',
      sessionGoal: 'Clear the fog with a better model',
      pacing: 'slow',
      warmthLevel: 0.9,
      challengeLevel: 0.3,
      bloomTarget: 'understand',
    };
  }

  // ── Strong mastery ──────────────────────────────────────────────────────
  if (perception.masterySignal === 'strong') {
    return {
      move: 'celebrate_and_advance',
      forceAskQuestion: true,
      maxQuestionsThisTurn: 1,
      preferredStrategies: ['celebration', 'retrieval_practice', 'socratic'],
      bannedStrategies: [],
      mustTeachContent: false,
      reason: 'Mastery evidenced — celebrate specifically, then one stretch step',
      mustInclude: ['specific praise for what they did', 'one slightly harder next move'],
      mustAvoid: ['generic Good job', 'long lecture'],
      emotionalApproach: 'Genuine pride, then forward motion',
      sessionGoal: 'Lock in the win and stretch one level',
      pacing: 'fast',
      warmthLevel: 0.85,
      challengeLevel: 0.7,
      bloomTarget: 'apply',
    };
  }

  // ── Default: teach more than you ask ────────────────────────────────────
  // Prefer teaching if we have a concept/subject; allow at most one question
  // only if we have not asked recently.
  const hasTopic = Boolean(perception.inferredTopic || sessionState.currentConcept || sessionState.currentSubject);
  const allowQuestion = consecutiveQuestions === 0 && questionsThisSession < 3 && lastTutorAskedQuestion === false;

  if (hasTopic) {
    return {
      move: allowQuestion ? 'model_then_check' : 'teach_micro_chunk',
      forceAskQuestion: allowQuestion ? null : false,
      maxQuestionsThisTurn: allowQuestion ? 1 : 0,
      preferredStrategies: ['direct_explanation', 'scaffolded_steps', 'worked_example', 'analogy_bridge', 'hint_ladder'],
      bannedStrategies: allowQuestion ? [] : ['socratic', 'elaborative_interrogation'],
      mustTeachContent: true,
      reason: allowQuestion
        ? 'Default with topic: teach first, optional single purposeful question'
        : 'Default with topic: pure teaching turn (question budget / recent ask)',
      mustInclude: ['one concrete teaching move'],
      mustAvoid: allowQuestion ? ['multiple questions', 'Do you understand'] : ['any ending question'],
      emotionalApproach: 'Clear, warm, purposeful',
      sessionGoal: 'Advance understanding of the current concept',
      pacing: es.flowIndicator > 0.6 ? 'fast' : 'normal',
      warmthLevel: 0.75,
      challengeLevel: es.flowIndicator > 0.6 ? 0.65 : 0.45,
      bloomTarget: 'understand',
    };
  }

  return {
    move: 'diagnostic_probe',
    forceAskQuestion: true,
    maxQuestionsThisTurn: 1,
    preferredStrategies: ['listen_and_connect', 'direct_explanation'],
    bannedStrategies: ['socratic', 'elaborative_interrogation', 'retrieval_practice'],
    mustTeachContent: false,
    reason: 'No topic yet — one natural question to unlock teaching',
    mustInclude: ['one simple question about subject or goal'],
    mustAvoid: ['stacked questions', 'formal onboarding script', 'Socratic grilling'],
    emotionalApproach: 'Curious friend-teacher',
    sessionGoal: 'Get the one fact needed to start teaching',
    pacing: 'normal',
    warmthLevel: 0.8,
    challengeLevel: 0.25,
    bloomTarget: 'remember',
  };
}

/** Apply policy hard constraints onto a TeachingPlan (mutates via return). */
export function applyPolicyToPlan(plan: TeachingPlan, policy: TeachingPolicy): TeachingPlan {
  let strategy = plan.strategy;
  if (policy.bannedStrategies.includes(strategy) && policy.preferredStrategies.length > 0) {
    strategy = policy.preferredStrategies[0];
  } else if (policy.preferredStrategies.length > 0 && !policy.preferredStrategies.includes(strategy)) {
    // Pull toward preferred on teach moves, and always when the chosen strategy
    // is a high-interrogation style while policy wants connection/teaching.
    if (policy.mustTeachContent || policy.move === 'diagnostic_probe' || policy.move === 'welcome_and_orient') {
      strategy = policy.preferredStrategies[0];
    }
  }

  const askQuestion =
    policy.forceAskQuestion === null
      ? plan.askQuestion && policy.maxQuestionsThisTurn > 0
      : policy.forceAskQuestion && policy.maxQuestionsThisTurn > 0;

  return {
    ...plan,
    strategy,
    strategyReason: `${plan.strategyReason} | policy:${policy.move} (${policy.reason})`,
    askQuestion,
    questionPurpose: askQuestion ? plan.questionPurpose : 'none',
    warmthLevel: Math.max(plan.warmthLevel, policy.warmthLevel),
    challengeLevel: policy.mustTeachContent ? Math.min(plan.challengeLevel, Math.max(policy.challengeLevel, 0.2)) : plan.challengeLevel,
    pacing: policy.pacing,
    emotionalApproach: policy.emotionalApproach || plan.emotionalApproach,
    mustInclude: uniqueStrings([...policy.mustInclude, ...plan.mustInclude]).slice(0, 6),
    mustAvoid: uniqueStrings([...policy.mustAvoid, ...plan.mustAvoid]).slice(0, 8),
    sessionGoal: policy.sessionGoal || plan.sessionGoal,
    bloomTarget: policy.bloomTarget || plan.bloomTarget,
    useAnalogy: policy.mustTeachContent ? plan.useAnalogy : plan.useAnalogy && !policy.move.includes('welcome'),
  };
}

/** Detect if a tutor response ends with / contains a question (for session accounting). */
export function responseContainsQuestion(text: string): boolean {
  if (!text) return false;
  // Question mark anywhere is a strong signal; also common WhatsApp question forms without ?
  if (/\?/.test(text)) return true;
  return /\b(what|why|how|when|where|which|who|do you|did you|can you|could you|would you|are you|is that|right\?)\b/i.test(
    text.split('\n').pop() || text
  );
}

/** Detect if response actually taught something (rough heuristic for turnsSinceLastTeach). */
export function responseLooksLikeTeaching(text: string): boolean {
  if (!text || text.length < 40) return false;
  const teachMarkers = [
    /\b(means|is when|is the|works like|for example|example:|first,|step 1|let's start with|here is|here's)\b/i,
    /\b(cell|tissue|bone|organ|equation|formula|concept|definition|process)\b/i,
    /\d+\./, // numbered step
  ];
  return teachMarkers.some(p => p.test(text)) && text.length > 80;
}
