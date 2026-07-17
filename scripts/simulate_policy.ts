/**
 * Offline simulation of the teach-first policy against the real WhatsApp
 * transcript that motivated v1. No LLM / DB required.
 */
import {
  decideTeachingPolicy,
  detectStudentSignals,
  applyPolicyToPlan,
  responseContainsQuestion,
} from '../src/teaching/policy';
import {
  stripTrailingQuestions as genStrip,
  stripRoboticOpeners as genStripRobot,
} from '../src/teaching/generation';
import type { PerceptionResult, TeachingPlan } from '../src/types/teaching';
import type { SessionState, StudentProfile } from '../src/types/student';
import { EMPTY_SESSION_STATE } from '../src/session/manager';
import { extractInstantFacts } from '../src/memory/instant_facts';

function basePerception(message: string, intent: PerceptionResult['primaryIntent'] = 'other'): PerceptionResult {
  return {
    rawMessage: message,
    modality: 'text',
    primaryIntent: intent,
    inferredTopic: null,
    inferredSubject: null,
    hasMisconception: false,
    misconceptionDescription: null,
    emotionalSignals: {
      valence: 0.5, arousal: 0.4, dominance: 0.5, shamePotential: 0.2,
      curiosity: 0.5, selfEfficacy: 0.4, flowIndicator: 0.3, frustration: 0.2,
      tiredness: 0.2, excitement: 0.3, dominantEmotion: 'neutral',
    },
    urgency: 'normal',
    cognitiveLoad: 'medium',
    masterySignal: 'none',
    languageStyle: 'casual',
    temporalPressure: 'none',
    isRepeatedQuestion: false,
    repetitionCount: 0,
  };
}

function emptyProfile(turns = 0): StudentProfile {
  return {
    studentId: 'sim',
    createdAt: new Date(),
    lastSeenAt: new Date(),
    totalSessions: 1,
    totalTurns: turns,
    studyStreak: 0,
    lastStudyDate: null,
    examTargets: [],
    culturalContext: {
      country: 'Nigeria', region: 'SE', language: 'en', currency: 'NGN',
      examBoards: ['WAEC', 'JAMB'], timezone: 'Africa/Lagos',
    },
    conceptProgress: {},
    errorDiary: [],
    analogyLibrary: [],
    memoryBlocks: {
      humanProfile: 'A Nigerian student.',
      learningStyle: 'Unknown.',
      progress: '',
      shameMap: '',
      curiosityMap: '',
      procedural: '',
      examStrategy: '',
      errorPatterns: '',
      breakthroughs: '',
    },
    facts: {},
  };
}

const transcript = [
  { student: 'Hello sup', intent: 'greeting' as const },
  { student: 'A friend of mine told me to message these whatsapp number', intent: 'casual_chat' as const },
  { student: 'Nothing much', intent: 'casual_chat' as const },
  { student: 'Am a science student waiting to get admission to study anatomy in abia State University', intent: 'meta_about_self' as const },
  { student: 'Nope for over 6 months have not read got 189 in jamb I wanted to study medicine and surgery so had to switch', intent: 'meta_about_self' as const },
  { student: 'Have not been reading my foundation is poor I did not do ss3', intent: 'meta_about_self' as const },
  { student: 'Ok I am ready', intent: 'other' as const },
  { student: "I don't know", intent: 'expressing_confusion' as const },
  { student: 'Bye please am busy will come back later', intent: 'casual_chat' as const },
  { student: 'Great', intent: 'casual_chat' as const },
];

let state: SessionState = { ...EMPTY_SESSION_STATE };
let profile = emptyProfile(0);
let turn = 0;

const failures: string[] = [];

console.log('=== WaxPrep v1 teach-first policy simulation ===\n');

for (const row of transcript) {
  const perception = basePerception(row.student, row.intent);
  if (/anatomy|biology/i.test(row.student)) {
    perception.inferredSubject = 'biology';
    perception.inferredTopic = 'anatomy_foundations';
  }
  if (/foundation is poor|did not do ss3/i.test(row.student)) {
    perception.emotionalSignals.shamePotential = 0.55;
    perception.emotionalSignals.selfEfficacy = 0.25;
  }

  const facts = extractInstantFacts(row.student);
  for (const f of facts) {
    profile.facts[f.key] = {
      factKey: f.key,
      factValue: f.value,
      confidence: f.confidence,
      source: 'instant',
      updatedAt: new Date(),
    };
  }

  const policy = decideTeachingPolicy({
    perception,
    profile,
    sessionState: state,
    isFirstMessage: turn === 0,
  });

  const rawPlan: TeachingPlan = {
    strategy: 'socratic',
    strategyReason: 'simulated deliberation default',
    warmthLevel: 0.7,
    challengeLevel: 0.5,
    pacing: 'normal',
    hintLevel: 0,
    useAnalogy: true,
    analogyDomain: 'house foundation',
    askQuestion: true,
    questionPurpose: 'guide_thinking',
    addressMisconception: false,
    misconceptionCorrection: null,
    connectToMemory: null,
    emotionalApproach: 'warm',
    mustInclude: [],
    mustAvoid: [],
    sessionGoal: 'progress',
    bloomTarget: 'understand',
    relationshipStage: turn === 0 ? 'new' : 'familiar',
    needsTools: [],
    expectedOutcome: 'engage',
  };

  const plan = applyPolicyToPlan(rawPlan, policy);
  plan.policyMove = policy.move;
  plan.mustTeachContent = policy.mustTeachContent;
  plan.maxQuestionsThisTurn = policy.maxQuestionsThisTurn;

  let fakeReply = plan.askQuestion
    ? `Hmm interesting. What's one thing you want to improve?`
    : `Let's start with cells — the basic unit of life. Think of each cell like a tiny room in a big house (your body). When you're free, reply and we continue.`;

  if (!plan.askQuestion) fakeReply = genStrip(fakeReply);
  fakeReply = genStripRobot(fakeReply);

  const asked = plan.askQuestion || responseContainsQuestion(fakeReply);
  const taught = plan.mustTeachContent === true;

  state = {
    ...state,
    consecutiveQuestions: asked ? (state.consecutiveQuestions || 0) + 1 : 0,
    questionsThisSession: (state.questionsThisSession || 0) + (asked ? 1 : 0),
    lastTutorAskedQuestion: asked,
    turnsSinceLastTeach: taught ? 0 : (state.turnsSinceLastTeach || 0) + 1,
    lastMove: policy.move,
    readinessSignal: state.readinessSignal || detectStudentSignals(row.student).readyToLearn,
    foundationGapDisclosed: state.foundationGapDisclosed || detectStudentSignals(row.student).foundationGap,
    currentSubject: perception.inferredSubject || state.currentSubject,
    currentConcept: perception.inferredTopic || state.currentConcept,
  };

  profile.totalTurns = turn + 1;

  console.log(`T${turn + 1} STUDENT: ${row.student}`);
  console.log(`   signals: ${JSON.stringify(detectStudentSignals(row.student))}`);
  console.log(`   facts+: ${facts.map(f => `${f.key}=${f.value}`).join(', ') || '—'}`);
  console.log(`   policy: move=${policy.move} ask=${plan.askQuestion} teach=${plan.mustTeachContent} strategy=${plan.strategy}`);
  console.log(`   reason: ${policy.reason}`);
  console.log(`   sample: ${fakeReply}`);
  console.log(`   state: qConsec=${state.consecutiveQuestions} qSess=${state.questionsThisSession} sinceTeach=${state.turnsSinceLastTeach}`);
  console.log('');

  if (/i am ready|i'm ready/i.test(row.student) && (plan.askQuestion || !plan.mustTeachContent)) {
    failures.push(`Ready turn still asking or not teaching: ask=${plan.askQuestion} teach=${plan.mustTeachContent}`);
  }
  if (/don'?t know/i.test(row.student) && (plan.askQuestion || !plan.mustTeachContent)) {
    failures.push(`Don't-know turn still asking or not teaching: ask=${plan.askQuestion} teach=${plan.mustTeachContent}`);
  }
  if (/\bbye\b/i.test(row.student) && plan.askQuestion) {
    failures.push('Bye turn still asks a question');
  }
  if (turn === 0 && /welcome to our tutoring/i.test(fakeReply)) {
    failures.push('Robotic welcome still present');
  }

  turn++;
}

if (failures.length) {
  console.error('FAILURES:');
  for (const f of failures) console.error(' -', f);
  process.exit(1);
}

console.log('ALL CRITICAL CHECKS PASSED');
