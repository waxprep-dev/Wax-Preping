/**
 * The Crew — WaxPrep's unified turn pipeline (v2.0).
 *
 * v1 ran: encoder -> swarm router -> world model -> causal -> tools ->
 * subject context -> [chain(4 calls) | emotional+cultural+pedagogy(3 calls)]
 * -> defense -> curriculum. That is 6-9 sequential LLM calls per message,
 * each seeing a different slice of the truth, with the vision analysis and
 * most emotional signals silently dropped along the way.
 *
 * v2 runs ONE coherent cognitive cycle:
 *
 *   perceive (1 fast call)
 *     -> assemble context (memory, episodes, world model, tools)
 *     -> deliberate (1 smart call -> TeachingPlan)
 *     -> generate (1 smart call)
 *     -> defend (0-1 fix calls)
 *     -> persist + update session state
 *     -> async: reflect, update student model, assess curriculum
 *
 * 3 calls on the critical path instead of 6-9: faster replies on WhatsApp,
 * lower cost, and every decision made with full information.
 */
import { v4 as uuidv4 } from 'uuid';
import { eventBus } from '../events/bus';
import { perceive, type IncomingMedia } from '../perception';
import { deliberate } from '../teaching/deliberation';
import { generate } from '../teaching/generation';
import { assessCurriculum } from '../teaching/curriculum';
import { getSubjectPedagogy, formatSubjectContext } from '../teaching/strategies';
import { runDefenseChecks } from '../defense/defense';
import { runReflection, getReflectionSummary } from '../reflection/reflection';
import { buildWorkingMemory, formatHistoryForOrchestrator } from '../memory/working';
import { getStudentProfile, updateStudyStreak, incrementTurns, updateSymbolicBelief, applyMemoryEdit } from '../memory/semantic';
import { saveEpisode, getRecentHistory, recallRelevantEpisodes } from '../memory/episodic';
import { updateStudentModel } from '../memory/student_model';
import { getOrCreateSession, touchSession, updateSessionState } from '../session/manager';
import { scheduleConceptReview, getDueReviews } from '../features/spaced_repetition';
import { suggestNextConcept } from '../neuro_symbolic/knowledge_graph';
import { analyzeCausally } from '../neuro_symbolic/causal_reasoner';
import { getWorldModelState } from '../world_model/predictive_model';
import { executeTool } from '../tools/registry';
import { recordPromptPerformance } from '../reflection/evolution';
import { db } from '../db/client';
import { logger } from '../middleware/logger';
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

  // ── 3. Context assembly (all in parallel) ───────────────────────────────
  const workingMemory = buildWorkingMemory(history, session.state);
  const historyText = formatHistoryForOrchestrator(history, 12);
  const currentConcept = perception.inferredTopic || session.state.currentConcept;
  const currentSubject = perception.inferredSubject || session.state.currentSubject || 'general';

  const [recalled, dueReviews, reflectionSummary, worldModel, subjectPedagogy] = await Promise.all([
    recallRelevantEpisodes(studentId, perception.rawMessage, 4, sessionId).catch(() => []),
    getDueReviews(studentId).catch(() => []),
    getReflectionSummary(studentId).catch(() => ''),
    getWorldModelState(studentId).catch(() => null),
    getSubjectPedagogy(currentSubject).catch(() => null),
  ]);

  const recalledText = recalled.length > 0
    ? recalled.map(e => `[${e.timestamp.toLocaleDateString('en-NG')}] Student: "${e.studentMessage.slice(0, 90)}" | You: "${e.tutorResponse.slice(0, 90)}"`).join('\n')
    : '';

  const dueReviewsText = dueReviews.length > 0
    ? dueReviews.map(r => `${r.concept} (${r.urgency})`).join(', ')
    : '';

  const worldModelInsight = worldModel
    ? `Predicted next mistake: ${worldModel.predictedNextMistake || 'none'} | frustration risk: ${(worldModel.predictedFrustrationProbability * 100).toFixed(0)}% | forgetting risk: ${worldModel.predictedForgetConcepts.join(', ') || 'none'}`
    : '';

  // Root-cause analysis only when genuinely stuck — expensive, so gated.
  let causalInsight = '';
  if (session.state.struggleCount >= 2 && currentConcept) {
    const causal = await analyzeCausally(studentId, currentConcept, currentSubject).catch(() => null);
    if (causal) {
      causalInsight = `Root cause: ${causal.rootCause} | Prerequisite gaps: ${causal.prerequisiteGaps.join(', ') || 'none'} | Intervention: ${causal.recommendedIntervention}`;
    }
  }

  const knowledgeLevel = currentConcept && profile.conceptProgress[currentConcept]
    ? profile.conceptProgress[currentConcept].masteryLevel
    : 0.5;

  const subjectContext = subjectPedagogy
    ? formatSubjectContext(subjectPedagogy, currentSubject, currentConcept, knowledgeLevel)
    : '';

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
    causalInsight,
    toolContext: '',
    subjectContext,
  };

  // ── 4. Deliberation ─────────────────────────────────────────────────────
  const plan = await deliberate(ctx);
  logger.info(`[Crew] strategy=${plan.strategy} | intent=${perception.primaryIntent} | emotion=${perception.emotionalSignals.dominantEmotion} | ${plan.strategyReason}`);

  // ── 5. Tools (only those the plan calls for) ────────────────────────────
  const toolsUsed: string[] = [];
  if (plan.needsTools.length > 0) {
    const examBoard = profile.culturalContext.examBoards?.[0] || 'WAEC';
    const toolResults: string[] = [];

    for (const toolName of plan.needsTools.slice(0, 2)) {
      const params: Record<string, unknown> = {
        query: currentConcept || perception.rawMessage.slice(0, 80),
        topic: currentConcept || perception.rawMessage.slice(0, 80),
        examBoard,
      };
      const result = await executeTool(toolName, params, studentId).catch(() => '');
      if (result && !result.startsWith('No ') && !result.startsWith('Unknown')) {
        toolResults.push(result);
        toolsUsed.push(toolName);
      }
    }

    // Auto-create a study plan when exam pressure is real and none exists
    if (perception.temporalPressure !== 'none' && !profile.studyPlan) {
      const nextExam = (profile.examTargets || []).find(
        (e: ExamTarget) => e.examDate && new Date(e.examDate).getTime() > Date.now()
      );
      if (nextExam) {
        const gaps = Object.entries(profile.conceptProgress || {})
          .filter(([, v]) => v.masteryLevel < 0.5)
          .map(([k]) => k)
          .join(', ');
        const planResult = await executeTool('generate_study_plan', {
          studentId, subject: nextExam.subjects?.[0] || currentSubject, examDate: nextExam.examDate, conceptGaps: gaps,
        }, studentId).catch(() => '');
        if (planResult && !planResult.startsWith('Unknown')) {
          toolResults.push(planResult);
          toolsUsed.push('generate_study_plan');
        }
      }
    }

    ctx.toolContext = toolResults.join('\n\n');
  }

  // ── 6. Generation ───────────────────────────────────────────────────────
  const generation = await generate(ctx, plan);

  // ── 7. Defense ──────────────────────────────────────────────────────────
  const defense = await runDefenseChecks(
    perception.rawMessage,
    generation.content,
    studentId,
    sessionId,
    { studentAlreadySolved: perception.masterySignal === 'strong' }
  );
  const finalResponse = defense.finalResponse;
  const latencyMs = Date.now() - start;

  // ── 8. Session state update (ground truth for next turn) ────────────────
  const struggled =
    perception.primaryIntent === 'expressing_confusion' ||
    perception.emotionalSignals.frustration > 0.6 ||
    perception.isRepeatedQuestion;
  const succeeded = perception.masterySignal === 'strong';

  const struggleCount = succeeded ? 0 : struggled ? session.state.struggleCount + 1 : session.state.struggleCount;
  const approachesTried = [...session.state.approachesTried];
  if (!approachesTried.includes(plan.strategy)) approachesTried.push(plan.strategy);

  await updateSessionState(sessionId, {
    currentConcept: currentConcept || session.state.currentConcept,
    currentSubject: currentSubject || session.state.currentSubject,
    hintLevel: succeeded ? 0 : Math.min(90, struggleCount * 25),
    struggleCount,
    approachesTried: approachesTried.slice(-8),
    lastStrategy: plan.strategy,
    bloomLevel: plan.bloomTarget,
    unresolvedQuestion: null,
  }).catch(() => {});

  // ── 9. Persist the turn ─────────────────────────────────────────────────
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

  // ── 10. Async post-turn cognition (never blocks the reply) ─────────────
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

  // The student model learns from this turn
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
        const nextConcept = await suggestNextConcept(studentId, turn.subject || 'general', profile.culturalContext.examBoards?.[0] || 'WAEC').catch(() => null);
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

  await recordPromptPerformance('generation.v1', studentId, sessionId, turn.turnNumber, {
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
