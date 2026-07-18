/**
 * The Crew — WaxPrep's unified turn pipeline (v3.0).
 *
 * Integrates:
 * - Dynamic student profile (attributes, archetypes)
 * - Onboarding engine (natural, goal-driven discovery)
 * - Syllabus vector store (no forced sequences)
 * - AI-driven navigation (the tutor decides what to teach)
 * - Tool registry (dynamic, extensible)
 *
 * 3 calls on the critical path: perceive → deliberate → generate.
 * Async: attribute extraction, archetype matching, navigation logging.
 */
import { v4 as uuidv4 } from 'uuid';
import { eventBus } from '../events/bus';
import { perceive, type IncomingMedia } from '../perception';
import { deliberate } from '../teaching/deliberation';
import { generate } from '../teaching/generation';
import {
  detectStudentSignals,
  responseContainsQuestion,
  responseLooksLikeTeaching,
} from '../teaching/policy';
import { assessCurriculum } from '../teaching/curriculum';
import { getSubjectPedagogy, formatSubjectContext } from '../teaching/strategies';
import { recordTurnMetric } from '../observability/metrics';
import { runDefenseChecks } from '../defense/defense';
import { runReflection, getReflectionSummary } from '../reflection/reflection';
import { buildWorkingMemory, formatHistoryForOrchestrator } from '../memory/working';
import { getStudentProfile, updateStudyStreak, incrementTurns, updateSymbolicBelief, applyMemoryEdit } from '../memory/semantic';
import { saveEpisode, getRecentHistory, recallRelevantEpisodes } from '../memory/episodic';
import { updateStudentModel } from '../memory/student_model';
import { buildStudentDossier } from '../memory/dossier';
import { getOrCreateSession, touchSession, updateSessionState } from '../session/manager';
import { scheduleConceptReview, getDueReviews } from '../features/spaced_repetition';
import { getWorldModelState } from '../world_model/predictive_model';
import { executeToolByName } from '../tools/implementations';
import { recordPromptPerformance } from '../reflection/evolution';
import { db } from '../db/client';
import { logger } from '../middleware/logger';

// v3.0 imports
import { handleOnboardingTurn, isInOnboarding } from '../onboarding/engine';
import { extractAttributesFromTurn, getActiveAttributes, buildAttributeContext } from '../student_profile/attribute_pipeline';
import { getArchetypePromptModifier, matchArchetypes } from '../student_profile/archetypes';
import { decideNextTopic, getRecentErrors } from '../navigation/ai_navigator';
import { searchSyllabus, formatSyllabusContext } from '../syllabus/store';

import type { ConversationTurn, ExamTarget } from '../types/student';
import type { TurnContext, TurnResult } from '../types/teaching';
import type { StudentMessageReceived, TutorResponseGenerated, MasteryDetected, EmotionalAlert, SessionStarted } from '../types/events';

export interface ProcessMessageInput {
  studentId: string;
  rawMessage: string;
  messageId: string;
  modality: 'text' | 'image' | 'audio' | 'document' | 'video';
  isFirstMessage?: boolean;
  mediaId?: string;
  mediaCaption?: string;
}

export async function processTutorMessage(input: ProcessMessageInput): Promise<string> {
  const { studentId, rawMessage, modality, mediaId, mediaCaption } = input;
  const start = Date.now();

  // ── 0. ONBOARDING CHECK ─────────────────────────────────────────────────
  const inOnboarding = await isInOnboarding(studentId);
  if (inOnboarding || input.isFirstMessage) {
    const onboardingResult = await handleOnboardingTurn(
      studentId,
      rawMessage,
      {
        rawMessage,
        modality,
        primaryIntent: 'greeting',
        emotionalSignals: {
          valence: 0.6, arousal: 0.4, dominance: 0.5,
          shamePotential: 0.2, curiosity: 0.5, selfEfficacy: 0.5,
          flowIndicator: 0.3, frustration: 0.2, tiredness: 0.1, excitement: 0.3,
          dominantEmotion: 'neutral',
        },
        urgency: 'normal',
        cognitiveLoad: 'medium',
        masterySignal: 'none',
        languageStyle: 'mixed',
        temporalPressure: 'none',
        isRepeatedQuestion: false,
        repetitionCount: 0,
      } as import('../types/teaching').PerceptionResult,
      input.isFirstMessage || false
    );

    if (!onboardingResult.isComplete) {
      return onboardingResult.response;
    }
    // Onboarding complete — fall through to normal tutoring
  }

  // ── 1. Identity: session + profile + history ────────────────────────────
  const session = await getOrCreateSession(studentId);
  const sessionId = session.sessionId;
  const [history, profile] = await Promise.all([
    getRecentHistory(sessionId, 12),
    getStudentProfile(studentId),
  ]);

  const isFirstMessage = profile.totalTurns === 0;

  if (session.isNewSession) {
    const daysSince = profile.lastSeenAt
      ? Math.floor((Date.now() - profile.lastSeenAt.getTime()) / 86400000)
      : null;
    const ev: SessionStarted = {
      id: uuidv4(), type: 'session.started', studentId, sessionId,
      timestamp: new Date(), isReturningStudent: profile.totalTurns > 0,
      daysSinceLastSession: profile.totalTurns > 0 ? daysSince : null,
    };
    eventBus.publish(ev).catch(() => {});
  }

  const msgEvent: StudentMessageReceived = {
    id: uuidv4(), type: 'student.message.received', studentId, sessionId,
    timestamp: new Date(), modality, isFirstMessage,
  };
  eventBus.publish(msgEvent).catch(() => {});

  await updateStudyStreak(studentId);
  await incrementTurns(studentId);

  // ── 2. Perception ───────────────────────────────────────────────────────
  const media: IncomingMedia = { type: modality, text: rawMessage, mediaId, caption: mediaCaption };
  const perception = await perceive(media, history.slice(-5).map(t => t.studentMessage), studentId);

  if (perception.urgency === 'critical' || perception.emotionalSignals.shamePotential > 0.8) {
    const alert: EmotionalAlert = {
      id: uuidv4(), type: 'emotional.alert', studentId, sessionId, timestamp: new Date(),
      emotion: perception.emotionalSignals.dominantEmotion,
      confidence: perception.emotionalSignals.shamePotential,
      urgency: perception.urgency === 'critical' ? 'immediate' : 'monitor',
      recommendedAction: 'Deliberation informed — prioritize emotional safety this turn',
    };
    eventBus.publish(alert).catch(() => {});
  }

  // ── 3. Dynamic Attribute Context (v3.0) ─────────────────────────────────
  const activeAttributes = await getActiveAttributes(studentId).catch(() => ({}));
  const attributeContext = await buildAttributeContext(studentId).catch(() => 'No learner model yet.');
  const archetypeModifier = await getArchetypePromptModifier(studentId).catch(() => '');

  // ── 4. Context assembly (all in parallel) ───────────────────────────────
  const workingMemory = buildWorkingMemory(history, session.state);
  const historyText = formatHistoryForOrchestrator(history, 12);
  const currentConcept = perception.inferredTopic || session.state.currentConcept;
  const currentSubject = perception.inferredSubject || session.state.currentSubject || 'general';

  const [recalled, dueReviews, reflectionSummary, worldModel, subjectPedagogy, recentErrors] = await Promise.all([
    recallRelevantEpisodes(studentId, perception.rawMessage, 4, sessionId).catch(() => []),
    getDueReviews(studentId).catch(() => []),
    getReflectionSummary(studentId).catch(() => ''),
    getWorldModelState(studentId).catch(() => null),
    getSubjectPedagogy(currentSubject).catch(() => null),
    getRecentErrors(studentId, 3).catch(() => []),
  ]);

  // v3.0: Syllabus query for current topic
  let syllabusContext = '';
  if (currentConcept) {
    const syllabusResults = await searchSyllabus({
      query: currentConcept,
      subject: currentSubject !== 'general' ? currentSubject : undefined,
      limit: 3,
    }).catch(() => []);
    syllabusContext = formatSyllabusContext(syllabusResults);
  }

  const recalledText = recalled.length > 0
    ? recalled.map(e => `[${e.timestamp.toLocaleDateString('en-NG')}] Student: "${e.studentMessage.slice(0, 90)}" | You: "${e.tutorResponse.slice(0, 90)}"`).join('\n')
    : '';

  const dueReviewsText = dueReviews.length > 0
    ? dueReviews.map(r => `${r.concept} (${r.urgency})`).join(', ')
    : '';

  const worldModelInsight = worldModel
    ? `Predicted next mistake: ${worldModel.predictedNextMistake || 'none'} | frustration risk: ${(worldModel.predictedFrustrationProbability * 100).toFixed(0)}% | forgetting risk: ${worldModel.predictedForgetConcepts.join(', ') || 'none'}`
    : '';

  const knowledgeLevel = currentConcept && profile.conceptProgress[currentConcept]
    ? profile.conceptProgress[currentConcept].masteryLevel
    : 0.5;

  const dossier = buildStudentDossier(profile, session.state);

  // v3.0: Build dynamic subject context from syllabus + attributes
  const subjectContext = [
    subjectPedagogy
      ? formatSubjectContext(subjectPedagogy, currentSubject, currentConcept, knowledgeLevel)
      : '',
    syllabusContext ? `SYLLABUS REFERENCE:\n${syllabusContext}` : '',
    `STUDENT ATTRIBUTES (use these — do not re-ask known facts):\n${attributeContext}`,
    archetypeModifier ? `ARCHETYPE GUIDANCE:\n${archetypeModifier}` : '',
    `STUDENT DOSSIER (hierarchical memory):\n${dossier}`,
  ].filter(Boolean).join('\n\n');

  const ctx: TurnContext = {
    studentId,
    sessionId,
    messageId: input.messageId,
    isFirstMessage,
    profile,
    sessionState: session.state,
    workingMemory,
    perception,
    conversationHistory: historyText,
    recalledEpisodes: recalledText,
    dueReviews: dueReviewsText,
    reflectionLessons: reflectionSummary,
    worldModelInsight,
    causalInsight: '',
    toolContext: '',
    subjectContext,
  };

  // ── 5. AI-Driven Navigation (v3.0) ──────────────────────────────────────
  let navigationDecision = null;
  if (perception.primaryIntent === 'ready_to_learn' || perception.primaryIntent === 'asking_explanation') {
    navigationDecision = await decideNextTopic({
      studentId,
      currentTopic: currentConcept,
      currentSubject,
      studentMessage: perception.rawMessage,
      perceptionIntent: perception.primaryIntent,
      bktMastery: Object.fromEntries(
        Object.entries(profile.conceptProgress || {}).map(([k, v]) => [k, v.masteryLevel])
      ),
      recentErrors,
      emotionalState: {
        frustration: perception.emotionalSignals.frustration,
        curiosity: perception.emotionalSignals.curiosity,
        selfEfficacy: perception.emotionalSignals.selfEfficacy,
      },
    }).catch(() => null);

    if (navigationDecision?.nextTopic) {
      ctx.sessionState.currentConcept = navigationDecision.nextTopic;
      ctx.sessionState.currentSubject = navigationDecision.nextSubject || currentSubject;
    }
  }

  // ── 6. Deliberation ───────────────────────────────────────────────────
  const plan = await deliberate(ctx);
  logger.info(`[Crew] strategy=${plan.strategy} | intent=${perception.primaryIntent} | emotion=${perception.emotionalSignals.dominantEmotion} | ${plan.strategyReason}`);

  // ── 7. Tools (dynamic registry, v3.0) ───────────────────────────────────
  const toolsUsed: string[] = [];
  if (plan.needsTools.length > 0) {
    const toolResults: string[] = [];

    for (const toolName of plan.needsTools.slice(0, 2)) {
      const params: Record<string, unknown> = {
        query: currentConcept || perception.rawMessage.slice(0, 80),
        topic: currentConcept || perception.rawMessage.slice(0, 80),
        exam_board: profile.culturalContext.examBoards?.[0] || 'WAEC',
        subject: currentSubject !== 'general' ? currentSubject : undefined,
      };
      const result = await executeToolByName(toolName, params, studentId);
      if (result.success && !result.output.startsWith('No ') && !result.output.startsWith('Unknown')) {
        toolResults.push(result.output);
        toolsUsed.push(toolName);
      }
    }

    // Auto-create study plan when exam pressure is real
    if (perception.temporalPressure !== 'none' && !profile.studyPlan) {
      const nextExam = (profile.examTargets || []).find(
        (e: ExamTarget) => e.examDate && new Date(e.examDate).getTime() > Date.now()
      );
      if (nextExam) {
        const gaps = Object.entries(profile.conceptProgress || {})
          .filter(([, v]) => v.masteryLevel < 0.5)
          .map(([k]) => k)
          .join(', ');
        const planResult = await executeToolByName('generate_study_plan', {
          studentId, subject: nextExam.subjects?.[0] || currentSubject, examDate: nextExam.examDate, conceptGaps: gaps,
        }, studentId);
        if (planResult.success && !planResult.output.startsWith('Unknown')) {
          toolResults.push(planResult.output);
          toolsUsed.push('generate_study_plan');
        }
      }
    }

    ctx.toolContext = toolResults.join('\n\n');
  }

  // ── 8. Generation ─────────────────────────────────────────────────────
  const generation = await generate(ctx, plan);

  // ── 9. Defense ──────────────────────────────────────────────────────────
  const defense = await runDefenseChecks(
    perception.rawMessage,
    generation.content,
    studentId,
    sessionId,
    { studentAlreadySolved: perception.masterySignal === 'strong' }
  );
  const finalResponse = defense.finalResponse;
  const latencyMs = Date.now() - start;

  // ── 10. Session state update ────────────────────────────────────────────
  const struggled =
    perception.primaryIntent === 'expressing_confusion' ||
    perception.emotionalSignals.frustration > 0.6 ||
    perception.isRepeatedQuestion;
  const succeeded = perception.masterySignal === 'strong';

  const struggleCount = succeeded ? 0 : struggled ? session.state.struggleCount + 1 : session.state.struggleCount;
  const approachesTried = [...session.state.approachesTried];
  if (!approachesTried.includes(plan.strategy)) approachesTried.push(plan.strategy);

  const signals = detectStudentSignals(perception.rawMessage);
  const askedQuestion = plan.askQuestion || responseContainsQuestion(finalResponse);
  const taught = plan.mustTeachContent === true || responseLooksLikeTeaching(finalResponse);
  const consecutiveQuestions = askedQuestion
    ? (session.state.consecutiveQuestions || 0) + 1
    : 0;
  const questionsThisSession = (session.state.questionsThisSession || 0) + (askedQuestion ? 1 : 0);
  const turnsSinceLastTeach = taught ? 0 : (session.state.turnsSinceLastTeach || 0) + 1;

  const resolvedSubject = navigationDecision?.nextSubject || currentSubject;
  const resolvedConcept = navigationDecision?.nextTopic || currentConcept || (
    signals.readyToLearn || signals.foundationGap || plan.mustTeachContent
      ? (await searchSyllabus({ query: perception.rawMessage, subject: resolvedSubject, limit: 1 }).catch(() => []))[0]?.topic || null
      : null
  );

  await updateSessionState(sessionId, {
    currentConcept: resolvedConcept,
    currentSubject: resolvedSubject,
    hintLevel: succeeded ? 0 : Math.min(90, struggleCount * 25),
    struggleCount,
    approachesTried: approachesTried.slice(-8),
    lastStrategy: plan.strategy,
    bloomLevel: plan.bloomTarget,
    unresolvedQuestion: askedQuestion ? finalResponse.slice(0, 200) : null,
    consecutiveQuestions,
    questionsThisSession,
    lastTutorAskedQuestion: askedQuestion,
    turnsSinceLastTeach,
    lastMove: plan.policyMove || plan.strategy,
    readinessSignal: session.state.readinessSignal || signals.readyToLearn,
    foundationGapDisclosed: session.state.foundationGapDisclosed || signals.foundationGap,
  }).catch(() => {});

  // ── 11. Persist the turn ───────────────────────────────────────────────
  const turn: ConversationTurn = {
    turnId: uuidv4(), sessionId, studentId,
    turnNumber: session.turnCount + 1,
    studentMessage: perception.rawMessage,
    tutorResponse: finalResponse,
    modality: perception.modality,
    aiAnalysis: {
      sessionPhase: perception.primaryIntent,
      pedagogicalStrategy: plan.strategy,
      emotionalReading: perception.emotionalSignals,
      inferredTopic: currentConcept || undefined,
      inferredSubject: currentSubject || undefined,
      hasMisconception: perception.hasMisconception,
      misconceptionDescription: perception.misconceptionDescription || undefined,
      masterySignalDetected: succeeded,
      bloomLevel: plan.bloomTarget,
    },
    modelUsed: generation.modelUsed,
    latencyMs,
    tokensIn: generation.tokensIn,
    tokensOut: generation.tokensOut,
    costUsd: generation.costUsd,
    toolsUsed,
    topic: currentConcept || undefined,
    subject: currentSubject || undefined,
    masteryEvidenced: succeeded,
    timestamp: new Date(),
  };

  await saveEpisode(turn).catch(err => logger.warn({ err }, '[Crew] saveEpisode failed'));
  await touchSession(sessionId).catch(() => {});

  const responseEvent: TutorResponseGenerated = {
    id: uuidv4(), type: 'tutor.response.generated', studentId, sessionId, timestamp: new Date(),
    responseText: finalResponse, modelUsed: generation.modelUsed, latencyMs,
    tokensIn: generation.tokensIn, tokensOut: generation.tokensOut, costUsd: generation.costUsd,
    toolsUsed, defensePassed: defense.passesAll,
    defenseIssues: defense.issues.map(i => i.issue),
    strategy: plan.strategy,
  };
  eventBus.publish(responseEvent).catch(() => {});

  recordTurnMetric({
    studentId,
    sessionId,
    turnNumber: turn.turnNumber,
    askedQuestion: plan.askQuestion === true || responseContainsQuestion(finalResponse),
    taughtContent: plan.mustTeachContent === true || responseLooksLikeTeaching(finalResponse),
    policyMove: plan.policyMove,
    strategy: plan.strategy,
    defenseIssues: defense.issues.length,
    latencyMs,
  }).catch(() => {});

  // ── 12. Async post-turn cognition (never blocks the reply) ───────────
  setImmediate(() => {
    runPostTurn(ctx, plan, turn, perception.masterySignal).catch(err =>
      logger.debug({ err }, '[Crew] Post-turn processing failed')
    );
  });

  return finalResponse;
}

async function runPostTurn(
  ctx: TurnContext,
  plan: TurnResult['plan'],
  turn: ConversationTurn,
  masterySignal: string
): Promise<void> {
  const { studentId, sessionId, profile, perception } = ctx;

  // Self-critique
  const reflection = await runReflection(
    studentId, sessionId, turn.turnNumber, turn.studentMessage, turn.tutorResponse,
    { strategy: plan.strategy, intent: perception.primaryIntent }
  ).catch(() => null);

  if (reflection) {
    await db.query(
      `UPDATE conversation_turns SET reflection_score = $1 WHERE turn_id = $2`,
      [reflection.confidenceScore, turn.turnId]
    ).catch(() => {});
  }

  // v3.0: Attribute Extraction Pipeline (replaces instant_facts)
  const activeAttributes = await getActiveAttributes(studentId).catch(() => ({}));
  await extractAttributesFromTurn(
    studentId,
    turn.turnId,
    turn.studentMessage,
    turn.tutorResponse,
    perception.primaryIntent,
    activeAttributes
  ).catch(err => logger.debug({ err }, '[Crew] Attribute extraction failed'));

  // v3.0: Archetype matching (lightweight, runs after attributes update)
  await matchArchetypes(studentId).catch(err => logger.debug({ err }, '[Crew] Archetype matching failed'));

  // The student model learns from this turn (legacy pathway, preserved)
  await updateStudentModel(profile, turn.studentMessage, turn.tutorResponse, perception, plan).catch(() => {});

  // Curriculum assessment -> knowledge tracing, spaced repetition, progress
  if (turn.topic) {
    const decision = await assessCurriculum(
      turn.topic, turn.subject || 'general', turn.studentMessage, turn.tutorResponse,
      masterySignal, profile.culturalContext.examBoards?.[0] || 'WAEC', studentId
    ).catch(() => null);

    if (decision) {
      if (decision.conceptBelief) {
        await updateSymbolicBelief(studentId, turn.topic, decision.conceptBelief.claim, decision.conceptBelief.status, decision.conceptBelief.confidence, decision.conceptBelief.evidence).catch(() => {});
      }
      if (decision.scheduleReview || masterySignal === 'strong') {
        const level = profile.conceptProgress[turn.topic]?.masteryLevel ?? (masterySignal === 'strong' ? 0.8 : 0.5);
        await scheduleConceptReview(studentId, turn.topic, turn.subject || 'general', level).catch(() => {});
      }
      if (decision.curriculumNote) {
        await applyMemoryEdit(studentId, 'progress', 'append', decision.curriculumNote).catch(() => {});
      }

      if (decision.masteryAssessment === 'mastered') {
        await applyMemoryEdit(studentId, 'breakthroughs', 'append', `Mastered "${turn.topic}" on ${new Date().toLocaleDateString('en-NG')}`).catch(() => {});
        
        // v3.0: Use AI navigator for next topic suggestion instead of hardcoded graph
        const navDecision = await decideNextTopic({
          studentId,
          currentTopic: turn.topic,
          currentSubject: turn.subject || 'general',
          studentMessage: turn.studentMessage,
          perceptionIntent: perception.primaryIntent,
          bktMastery: Object.fromEntries(
            Object.entries(profile.conceptProgress || {}).map(([k, v]) => [k, v.masteryLevel])
          ),
          recentErrors: [],
          emotionalState: {
            frustration: perception.emotionalSignals.frustration,
            curiosity: perception.emotionalSignals.curiosity,
            selfEfficacy: perception.emotionalSignals.selfEfficacy,
          },
        }).catch(() => null);

        const nextConcept = navDecision?.nextTopic;
        await queueNotification(
          studentId, 'breakthrough_celebration',
          `Student just mastered "${turn.topic}". Celebrate specifically.${nextConcept ? ` Suggest "${nextConcept}" as the next mountain to climb.` : ''}`,
          `breakthrough:${studentId}:${turn.topic}`
        );

        const masteryEvent: MasteryDetected = {
          id: uuidv4(), type: 'mastery.detected', studentId, sessionId, timestamp: new Date(),
          concept: turn.topic, evidenceType: 'curriculum_assessment',
          masteryLevel: profile.conceptProgress[turn.topic]?.masteryLevel ?? 0.8,
        };
        await eventBus.publish(masteryEvent).catch(() => {});
      }
    }
  }

  await recordPromptPerformance('generation.v2', studentId, sessionId, turn.turnNumber, {
    studentEngagement: turn.studentMessage.length > 50 ? 0.8 : 0.5,
    masterySignal: masterySignal === 'strong',
    shameSpike: perception.emotionalSignals.shamePotential > 0.7,
    frustrationSpike: perception.emotionalSignals.frustration > 0.7,
    flowMaintained: perception.emotionalSignals.flowIndicator > 0.6,
    answerLeak: false,
  }).catch(() => {});
}

async function queueNotification(studentId: string, type: string, content: string, dedupeKey: string): Promise<void> {
  await db.query(
    `INSERT INTO notification_queue (student_id, type, content, scheduled_at, priority, dedupe_key)
     VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes', 5, $4)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [studentId, type, content, dedupeKey]
  ).catch(() => {});
}

function inferSubjectFromGoal(goal: string | null | undefined): string | null {
  if (!goal) return null;
  const g = goal.toLowerCase();
  if (/anatomy|medicine|surgery|biology|physio|mbbs|nursing/.test(g)) return 'biology';
  if (/physics|engineering/.test(g)) return 'physics';
  if (/chem/.test(g)) return 'chemistry';
  if (/math|calcul|algebra/.test(g)) return 'mathematics';
  if (/econ|account|commerce/.test(g)) return 'economics';
  if (/english|lit/.test(g)) return 'english';
  return null;
}

function firstConceptForSubject(subject: string | null | undefined): string | null {
  const s = (subject || '').toLowerCase();
  if (s === 'biology') return 'cells_and_tissues';
  if (s === 'physics') return 'measurement_and_units';
  if (s === 'chemistry') return 'matter_and_particles';
  if (s === 'mathematics') return 'numbers_and_operations';
  if (s === 'english') return 'sentence_basics';
  if (s === 'economics') return 'basic_economic_problems';
  return s && s !== 'general' ? `${s}_foundations` : null;
}