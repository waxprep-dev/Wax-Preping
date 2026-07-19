/**
 * The Crew — WaxPrep's unified turn pipeline (v3.1 Cognitive Fusion).
 *
 * Integrates:
 * - Dynamic student profile (attributes, archetypes)
 * - Onboarding engine (natural, goal-driven discovery)
 * - Syllabus vector store (no forced sequences)
 * - AI-driven navigation (the tutor decides what to teach)
 * - Tool registry + DTDR tool-memory symbiosis
 * - Dual-process session segmentation
 * - ACT-R / Oblivion activation-ranked memory retrieval
 * - Predictive memory pre-load
 * - Memory palace path hints
 * - Bidirectional memory write (episodes + palace + tool memory)
 *
 * Critical path: onboard → session → perceive → boundary → context
 *   → navigate → deliberate → tools (DTDR) → generate → defense → persist.
 * Async: attribute extraction, archetype matching, navigation logging,
 *        predictive refresh, palace ensure.
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
import { getStudentProfile, updateStudyStreak, applyMemoryEdit } from '../memory/semantic';
import { saveEpisode, getRecentHistory, recallRelevantEpisodes } from '../memory/episodic';
import { updateStudentModel } from '../memory/student_model';
import {
  getOrCreateSession,
  evaluateAndMaybeRotateSession,
  touchSession,
  updateSessionState,
} from '../session/manager';
import { scheduleConceptReview, getDueReviews } from '../features/spaced_repetition';
import { getWorldModelState } from '../world_model/predictive_model';
import { executeToolByName } from '../tools/implementations';
import { recordPromptPerformance } from '../reflection/evolution';
import { db } from '../db/client';
import { logger } from '../middleware/logger';

// v3.0 / v3.1 cognitive imports
import { handleOnboardingTurn, isInOnboarding } from '../onboarding/engine';
import {
  extractAttributesFromTurn,
  getActiveAttributes,
  buildAttributeContext,
} from '../student_profile/attribute_pipeline';
import { getArchetypePromptModifier, matchArchetypes } from '../student_profile/archetypes';
import { decideNextTopic, getRecentErrors } from '../navigation/ai_navigator';
import { searchSyllabus, formatSyllabusContext } from '../syllabus/store';
import { ensureSyllabusCoverage } from '../syllabus/auto_ingest';
import { retrieveMemories } from '../forgetting/engine';
import { checkPreloadCache, predictivePreLoad } from '../predictive/engine';
import { selectTools } from '../tool_memory/dtdr';
import { processToolOutput } from '../tool_memory/pipeline';
import { ensurePalace, autoConstructPalacePath, placeInPalace } from '../palace/organizer';
import { getCognitiveConfig } from '../config/cognitive';
import { getGraphAdapter } from '../graph/factory';

import type { ConversationTurn } from '../types/student';
import type { TurnContext, TurnResult, PerceptionResult, TeachingPlan } from '../types/teaching';
import type {
  StudentMessageReceived,
  TutorResponseGenerated,
  MasteryDetected,
  EmotionalAlert,
  SessionStarted,
} from '../types/events';
import type { MemoryChunk, PreloadContext, DTDRContext } from '../types/cognitive';

export interface ProcessMessageInput {
  studentId: string;
  rawMessage: string;
  messageId: string;
  modality: 'text' | 'image' | 'audio' | 'document';
  isFirstMessage?: boolean;
  mediaId?: string;
  mediaCaption?: string;
}

/**
 * Build a valid PerceptionResult for onboarding turns.
 * Using a typed factory instead of an inline `as` assertion prevents
 * silent breakage if the interface shape changes.
 */
function buildOnboardingPerception(rawMessage: string): PerceptionResult {
  return {
    rawMessage,
    modality: 'text',
    primaryIntent: 'greeting',
    inferredTopic: null,
    inferredSubject: null,
    hasMisconception: false,
    misconceptionDescription: null,
    emotionalSignals: {
      valence: 0.6,
      arousal: 0.4,
      dominance: 0.5,
      shamePotential: 0.2,
      curiosity: 0.5,
      selfEfficacy: 0.5,
      flowIndicator: 0.3,
      frustration: 0.2,
      tiredness: 0.1,
      excitement: 0.3,
      dominantEmotion: 'neutral',
    },
    urgency: 'normal',
    cognitiveLoad: 'medium',
    masterySignal: 'none',
    languageStyle: 'mixed',
    temporalPressure: 'none',
    isRepeatedQuestion: false,
    repetitionCount: 0,
  };
}

function formatActivatedMemories(chunks: MemoryChunk[]): string {
  if (!chunks.length) return '';
  return chunks
    .map((c, i) => {
      const act = typeof c.activation === 'number' ? c.activation.toFixed(3) : '?';
      const sal =
        typeof c.emotional_salience === 'number' ? c.emotional_salience.toFixed(2) : '?';
      const content = (c.content || '').slice(0, 180).replace(/\s+/g, ' ');
      return `${i + 1}. [${c.memory_type} act=${act} sal=${sal}] ${content}`;
    })
    .join('\n');
}

function formatPreloadContext(preload: PreloadContext | null | undefined): string {
  if (!preload) return '';
  const parts: string[] = [];
  if (preload.predicted_topic) {
    parts.push(`Predicted focus topic: ${preload.predicted_topic}`);
  }
  if (preload.review_queue?.length) {
    parts.push(`Due for review: ${preload.review_queue.slice(0, 5).join(', ')}`);
  }
  if (preload.predicted_struggle?.length) {
    parts.push(`Likely struggle concepts: ${preload.predicted_struggle.slice(0, 5).join(', ')}`);
  }
  if (preload.emotional_prep && preload.emotional_prep !== 'normal') {
    parts.push(`Emotional prep mode: ${preload.emotional_prep}`);
  }
  if (preload.recommended_strategies?.length) {
    parts.push(`Recommended strategies: ${preload.recommended_strategies.join(', ')}`);
  }
  if (preload.archetype_prompt_modifier) {
    parts.push(`Archetype modifier: ${preload.archetype_prompt_modifier}`);
  }
  const topic = preload.predicted_topic;
  if (topic && preload.pre_computed_hints?.[topic]) {
    parts.push(`Pre-computed hint: ${preload.pre_computed_hints[topic].slice(0, 200)}`);
  }
  if (topic && preload.pre_computed_analogies?.[topic]) {
    parts.push(`Pre-computed analogy: ${preload.pre_computed_analogies[topic].slice(0, 200)}`);
  }
  return parts.join('\n');
}

function emotionalSnapshotFromPerception(p: PerceptionResult): Record<string, number> {
  const e = p.emotionalSignals;
  return {
    valence: e.valence,
    arousal: e.arousal,
    dominance: e.dominance,
    shamePotential: e.shamePotential,
    curiosity: e.curiosity,
    selfEfficacy: e.selfEfficacy,
    flowIndicator: e.flowIndicator,
    frustration: e.frustration,
    tiredness: e.tiredness,
    excitement: e.excitement,
  };
}

export async function processTutorMessage(input: ProcessMessageInput): Promise<string> {
  const { studentId, rawMessage, modality, mediaId, mediaCaption } = input;
  const start = Date.now();

  // ── 0. ONBOARDING CHECK ──────────────────────────────────────────────────
  const inOnboarding = await isInOnboarding(studentId);
  if (inOnboarding || input.isFirstMessage) {
    const onboardingResult = await handleOnboardingTurn(
      studentId,
      rawMessage,
      buildOnboardingPerception(rawMessage),
      input.isFirstMessage || false
    );

    if (!onboardingResult.isComplete) {
      // Ensure palace exists even during onboarding (async, non-blocking)
      ensurePalace(studentId).catch(err =>
        logger.debug({ err }, '[Crew] ensurePalace during onboarding failed')
      );
      return onboardingResult.response;
    }
    // Onboarding complete — fall through to normal tutoring
  }

  // ── 1. Identity: session + profile + history ─────────────────────────────
  let session = await getOrCreateSession(studentId);
  let sessionId = session.sessionId;
  const [historyBeforeBoundary, profile] = await Promise.all([
    getRecentHistory(session.sessionId, 12),
    getStudentProfile(studentId),
  ]);

  const isFirstEverMessage = profile.totalTurns === 0;

  if (session.isNewSession) {
    const daysSince = profile.lastSeenAt
      ? Math.floor((Date.now() - profile.lastSeenAt.getTime()) / 86400000)
      : null;
    const ev: SessionStarted = {
      id: uuidv4(),
      type: 'session.started',
      studentId,
      sessionId,
      timestamp: new Date(),
      isReturningStudent: profile.totalTurns > 0,
      daysSinceLastSession: profile.totalTurns > 0 ? daysSince : null,
    };
    eventBus
      .publish(ev)
      .catch(err => logger.warn({ err }, '[Crew] EventBus publish failed (session.started)'));
  }

  const msgEvent: StudentMessageReceived = {
    id: uuidv4(),
    type: 'student.message.received',
    studentId,
    sessionId,
    timestamp: new Date(),
    modality,
    isFirstMessage: isFirstEverMessage,
  };
  eventBus
    .publish(msgEvent)
    .catch(err =>
      logger.warn({ err }, '[Crew] EventBus publish failed (student.message.received)')
    );

  await updateStudyStreak(studentId);

  // ── 2. Perception ────────────────────────────────────────────────────────
  const media: IncomingMedia = {
    type: modality,
    text: rawMessage,
    mediaId,
    caption: mediaCaption,
  };
  const perception = await perceive(
    media,
    historyBeforeBoundary.slice(-5).map(t => t.studentMessage),
    studentId
  );

  if (perception.urgency === 'critical' || perception.emotionalSignals.shamePotential > 0.8) {
    const alert: EmotionalAlert = {
      id: uuidv4(),
      type: 'emotional.alert',
      studentId,
      sessionId,
      timestamp: new Date(),
      emotion: perception.emotionalSignals.dominantEmotion,
      confidence: perception.emotionalSignals.shamePotential,
      urgency: perception.urgency === 'critical' ? 'immediate' : 'monitor',
      recommendedAction: 'Deliberation informed — prioritize emotional safety this turn',
    };
    eventBus
      .publish(alert)
      .catch(err => logger.warn({ err }, '[Crew] EventBus publish failed (emotional.alert)'));
  }

  // ── 2b. Dual-process session boundary (after perception) ─────────────────
  const previousMessage =
    historyBeforeBoundary.length > 0
      ? historyBeforeBoundary[historyBeforeBoundary.length - 1].studentMessage
      : null;
  const recentContext = historyBeforeBoundary
    .slice(-4)
    .map(t => `S: ${t.studentMessage.slice(0, 80)} | T: ${t.tutorResponse.slice(0, 80)}`)
    .join('\n');

  const rotation = await evaluateAndMaybeRotateSession({
    studentId,
    currentMessage: perception.rawMessage,
    previousMessage,
    currentTopic: perception.inferredTopic || session.state.currentConcept,
    emotionalSnapshot: emotionalSnapshotFromPerception(perception),
    recentContext,
    session,
  });

  session = rotation.session;
  sessionId = session.sessionId;
  const boundaryDecision = rotation.boundary;

  // History is session-scoped; reload if we rotated
  const history = rotation.rotated
    ? await getRecentHistory(sessionId, 12).catch(() => [] as ConversationTurn[])
    : historyBeforeBoundary;

  // ── 3. Dynamic Attribute Context ─────────────────────────────────────────
  const activeAttributes = await getActiveAttributes(studentId).catch(err => {
    logger.warn({ err }, '[Crew] getActiveAttributes failed');
    return {};
  });
  const attributeContext = await buildAttributeContext(studentId).catch(err => {
    logger.warn({ err }, '[Crew] buildAttributeContext failed');
    return 'No learner model yet.';
  });
  const archetypeModifier = await getArchetypePromptModifier(studentId).catch(err => {
    logger.warn({ err }, '[Crew] getArchetypePromptModifier failed');
    return '';
  });

  // ── 4. Context assembly (parallel) ───────────────────────────────────────
  const workingMemory = buildWorkingMemory(history, session.state);
  const historyText = formatHistoryForOrchestrator(history, 12);
  const currentConcept = perception.inferredTopic || session.state.currentConcept;
  const currentSubject = perception.inferredSubject || session.state.currentSubject || 'general';
  const workingMemoryText = [
    historyText,
    currentConcept ? `Current concept: ${currentConcept}` : '',
    currentSubject ? `Current subject: ${currentSubject}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const [
    recalled,
    dueReviews,
    reflectionSummary,
    worldModel,
    subjectPedagogy,
    recentErrors,
    preload,
    activatedMemories,
  ] = await Promise.all([
    recallRelevantEpisodes(studentId, perception.rawMessage, 4, sessionId).catch(err => {
      logger.warn({ err }, '[Crew] recallRelevantEpisodes failed');
      return [];
    }),
    getDueReviews(studentId).catch(err => {
      logger.warn({ err }, '[Crew] getDueReviews failed');
      return [];
    }),
    getReflectionSummary(studentId).catch(err => {
      logger.warn({ err }, '[Crew] getReflectionSummary failed');
      return '';
    }),
    getWorldModelState(studentId).catch(err => {
      logger.warn({ err }, '[Crew] getWorldModelState failed');
      return null;
    }),
    getSubjectPedagogy(currentSubject).catch(err => {
      logger.warn({ err }, '[Crew] getSubjectPedagogy failed');
      return null;
    }),
    getRecentErrors(studentId, 3).catch(err => {
      logger.warn({ err }, '[Crew] getRecentErrors failed');
      return [];
    }),
    // Predictive pre-load (cache first; compute async on miss)
    checkPreloadCache(studentId).catch(err => {
      logger.debug({ err }, '[Crew] checkPreloadCache failed');
      return null;
    }),
    // ACT-R / Oblivion activation-ranked retrieval
    (async (): Promise<MemoryChunk[]> => {
      try {
        const forgettingCfg = await getCognitiveConfig('forgetting');
        if (forgettingCfg.enabled === false) return [];
        return await retrieveMemories(perception.rawMessage, studentId, workingMemoryText, {
          limit: 5,
        });
      } catch (err) {
        logger.warn({ err }, '[Crew] retrieveMemories failed');
        return [];
      }
    })(),
  ]);

  // Warm predictive cache asynchronously on miss (does not block reply)
  if (!preload) {
    setImmediate(() => {
      predictivePreLoad(studentId).catch(err =>
        logger.debug({ err }, '[Crew] predictivePreLoad warm failed')
      );
    });
  }

  // Syllabus query for current topic
  let syllabusContext = '';
  if (currentConcept) {
    const syllabusResults = await searchSyllabus({
      query: currentConcept,
      subject: currentSubject !== 'general' ? currentSubject : undefined,
      limit: 3,
    }).catch(err => {
      logger.warn({ err }, '[Crew] searchSyllabus failed');
      return [];
    });
    syllabusContext = formatSyllabusContext(syllabusResults);

    // Demand-driven auto-ingest when store is thin (never blocks the reply path)
    if (syllabusResults.length < 2) {
      setImmediate(() => {
        ensureSyllabusCoverage({
          subject: currentSubject !== 'general' ? currentSubject : undefined,
          examBoard: profile.culturalContext.examBoards?.[0],
          topic: currentConcept || undefined,
          minChunks: 3,
          studentId,
        }).catch(err => logger.debug({ err }, '[Crew] ensureSyllabusCoverage failed'));
      });
    }
  }

  const recalledText =
    recalled.length > 0
      ? recalled
          .map(
            e =>
              `[${e.timestamp.toLocaleDateString('en-NG')}] Student: "${e.studentMessage.slice(0, 90)}" | You: "${e.tutorResponse.slice(0, 90)}"`
          )
          .join('\n')
      : '';

  const activatedText = formatActivatedMemories(activatedMemories);
  const preloadText = formatPreloadContext(preload);

  // Merge vector recall + activation-ranked memories for generation
  const cognitiveMemoryContext = [
    activatedText ? `ACTIVATION-RANKED MEMORIES (prefer these):\n${activatedText}` : '',
    recalledText && !activatedText ? `RECALLED EPISODES:\n${recalledText}` : '',
    recalledText && activatedText ? `VECTOR EPISODES (supplementary):\n${recalledText}` : '',
    preloadText ? `PREDICTIVE PRE-LOAD:\n${preloadText}` : '',
    boundaryDecision?.is_boundary
      ? `SESSION BOUNDARY: ${boundaryDecision.boundary_type} (p=${boundaryDecision.boundary_probability.toFixed(2)}). Re-establish pedagogical context gently.`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const dueReviewsText =
    dueReviews.length > 0
      ? dueReviews.map(r => `${r.concept} (${r.urgency})`).join(', ')
      : preload?.review_queue?.length
        ? preload.review_queue.slice(0, 5).join(', ')
        : '';

  const worldModelInsight = worldModel
    ? `Predicted next mistake: ${worldModel.predictedNextMistake || 'none'} | frustration risk: ${(worldModel.predictedFrustrationProbability * 100).toFixed(0)}% | forgetting risk: ${worldModel.predictedForgetConcepts.join(', ') || 'none'}`
    : '';

  const knowledgeLevel =
    currentConcept && profile.conceptProgress[currentConcept]
      ? profile.conceptProgress[currentConcept].masteryLevel
      : 0.5;

  // Palace path hint (non-blocking best-effort)
  let palacePathHint = '';
  try {
    const palaceCfg = await getCognitiveConfig('palace');
    if (palaceCfg.enabled !== false && currentConcept) {
      const subjectForPalace =
        currentSubject !== 'general' ? currentSubject : currentConcept;
      const path = await autoConstructPalacePath(
        studentId,
        subjectForPalace,
        currentConcept,
        currentConcept
      );
      palacePathHint = `Memory Palace: ${path.wing.name} → ${path.room.name} → ${path.drawer.name}`;
    }
  } catch (err) {
    logger.debug({ err }, '[Crew] palace path hint failed');
  }

  const subjectContext = [
    subjectPedagogy
      ? formatSubjectContext(subjectPedagogy, currentSubject, currentConcept, knowledgeLevel)
      : '',
    syllabusContext ? `SYLLABUS REFERENCE:\n${syllabusContext}` : '',
    `STUDENT ATTRIBUTES (use these — do not re-ask known facts):\n${attributeContext}`,
    archetypeModifier ? `ARCHETYPE GUIDANCE:\n${archetypeModifier}` : '',
    palacePathHint ? `PALACE PATH:\n${palacePathHint}` : '',
    cognitiveMemoryContext ? `COGNITIVE MEMORY:\n${cognitiveMemoryContext}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const ctx: TurnContext = {
    studentId,
    sessionId,
    messageId: input.messageId,
    isFirstMessage: isFirstEverMessage,
    profile,
    sessionState: session.state,
    workingMemory,
    perception,
    conversationHistory: historyText,
    recalledEpisodes: activatedText || recalledText,
    dueReviews: dueReviewsText,
    reflectionLessons: reflectionSummary,
    worldModelInsight,
    causalInsight: '',
    toolContext: '',
    subjectContext,
    boundaryDecision,
    preloadContext: preload,
    activatedMemories,
    cognitiveMemoryContext,
    palacePathHint,
  };

  // ── 5. AI-Driven Navigation ──────────────────────────────────────────────
  let navigationDecision = null;
  if (
    perception.primaryIntent === 'asking_explanation' ||
    perception.primaryIntent === 'exam_prep' ||
    perception.primaryIntent === 'expressing_confusion'
  ) {
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
    }).catch(err => {
      logger.warn({ err }, '[Crew] decideNextTopic failed');
      return null;
    });

    if (navigationDecision?.nextTopic) {
      ctx.sessionState.currentConcept = navigationDecision.nextTopic;
      ctx.sessionState.currentSubject = navigationDecision.nextSubject || currentSubject;
    }
  }

  // Prefer preload-recommended strategy bias via session state (soft)
  if (preload?.recommended_strategies?.length && !ctx.sessionState.lastStrategy) {
    // Deliberation still decides; preload is advisory via subjectContext already.
  }

  // ── 6. Deliberation ──────────────────────────────────────────────────────
  const plan = await deliberate(ctx);
  logger.info(
    `[Crew] strategy=${plan.strategy} | intent=${perception.primaryIntent} | emotion=${perception.emotionalSignals.dominantEmotion} | boundary=${boundaryDecision?.boundary_type || 'none'} | ${plan.strategyReason}`
  );

  // ── 7. Tools (DTDR + dynamic registry) ───────────────────────────────────
  const toolsUsed: string[] = [];
  const toolResults: string[] = [];
  let previousToolName: string | undefined;

  const resolvedSubjectNav = navigationDecision?.nextSubject || currentSubject;
  const resolvedConceptNav =
    navigationDecision?.nextTopic || currentConcept || perception.rawMessage.slice(0, 80);

  let toolMemoryEnabled = true;
  try {
    const tmCfg = await getCognitiveConfig('tool_memory');
    toolMemoryEnabled = tmCfg.enabled !== false;
  } catch {
    toolMemoryEnabled = true;
  }

  // Prefer DTDR when tool memory is enabled; fall back to deliberation needsTools
  let toolSelections: Array<{
    tool_name: string;
    params: Record<string, unknown>;
    reasoning?: string;
    confidence?: number;
  }> = [];

  if (toolMemoryEnabled) {
    const dtdrContext: DTDRContext = {
      initial_query: perception.rawMessage,
      executed_tools: [],
      intermediate_results: [],
      student_profile_summary: attributeContext.slice(0, 500),
    };
    toolSelections = await selectTools(dtdrContext, studentId).catch(err => {
      logger.warn({ err }, '[Crew] DTDR selectTools failed');
      return [];
    });
  }

  if (toolSelections.length === 0 && plan.needsTools.length > 0) {
    toolSelections = plan.needsTools.slice(0, 2).map(name => ({
      tool_name: name,
      params: {
        query: resolvedConceptNav,
        topic: resolvedConceptNav,
        exam_board: profile.culturalContext.examBoards?.[0] || undefined,
        subject: resolvedSubjectNav !== 'general' ? resolvedSubjectNav : undefined,
      },
      reasoning: 'deliberation_plan',
      confidence: 0.6,
    }));
  }

  for (const selection of toolSelections.slice(0, 2)) {
    const params: Record<string, unknown> = {
      query: resolvedConceptNav,
      topic: resolvedConceptNav,
      exam_board: profile.culturalContext.examBoards?.[0] || undefined,
      subject: resolvedSubjectNav !== 'general' ? resolvedSubjectNav : undefined,
      ...(selection.params || {}),
    };

    // Strip undefined exam_board so tools don't get a hardcoded default forced here
    if (params.exam_board === undefined) delete params.exam_board;

    const result = await executeToolByName(selection.tool_name, params, studentId);

    // Tool-memory write (async-safe but awaited lightly for ordering)
    if (toolMemoryEnabled) {
      await processToolOutput(
        studentId,
        selection.tool_name,
        params,
        result.data ?? result.output,
        result.latencyMs,
        result.success,
        result.error,
        previousToolName
      ).catch(err => logger.debug({ err }, '[Crew] processToolOutput failed'));
    }

    if (
      result.success &&
      !result.output.startsWith('No ') &&
      !result.output.startsWith('Unknown')
    ) {
      toolResults.push(result.output);
      toolsUsed.push(selection.tool_name);
      previousToolName = selection.tool_name;
    }
  }

  ctx.toolContext = toolResults.join('\n\n');

  // ── 8. Generation ────────────────────────────────────────────────────────
  const generation = await generate(ctx, plan);

  // ── 9. Defense ───────────────────────────────────────────────────────────
  const defense = await runDefenseChecks(
    perception.rawMessage,
    generation.content,
    studentId,
    sessionId,
    { studentAlreadySolved: perception.masterySignal === 'strong' }
  );
  const finalResponse = defense.finalResponse;
  const latencyMs = Date.now() - start;

  // ── 10. Session state update ─────────────────────────────────────────────
  const struggled =
    perception.primaryIntent === 'expressing_confusion' ||
    perception.emotionalSignals.frustration > 0.6 ||
    perception.isRepeatedQuestion;
  const succeeded = perception.masterySignal === 'strong';

  const struggleCount = succeeded
    ? 0
    : struggled
      ? session.state.struggleCount + 1
      : session.state.struggleCount;
  const approachesTried = [...session.state.approachesTried];
  if (!approachesTried.includes(plan.strategy)) approachesTried.push(plan.strategy);

  const signals = detectStudentSignals(perception.rawMessage);
  const askedQuestion = plan.askQuestion || responseContainsQuestion(finalResponse);
  const taught = plan.mustTeachContent === true || responseLooksLikeTeaching(finalResponse);
  const consecutiveQuestions = askedQuestion
    ? (session.state.consecutiveQuestions || 0) + 1
    : 0;
  const questionsThisSession =
    (session.state.questionsThisSession || 0) + (askedQuestion ? 1 : 0);
  const turnsSinceLastTeach = taught ? 0 : (session.state.turnsSinceLastTeach || 0) + 1;

  const resolvedSubject = navigationDecision?.nextSubject || currentSubject;
  const resolvedConcept =
    navigationDecision?.nextTopic ||
    currentConcept ||
    (signals.readyToLearn || signals.foundationGap || plan.mustTeachContent
      ? (
          await searchSyllabus({
            query: perception.rawMessage,
            subject: resolvedSubject !== 'general' ? resolvedSubject : undefined,
            limit: 1,
          }).catch(err => {
            logger.warn({ err }, '[Crew] Syllabus fallback search failed');
            return [];
          })
        )[0]?.topic || null
      : null);

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
  }).catch(err => logger.error({ err }, '[Crew] CRITICAL: updateSessionState failed'));

  // ── 11. Persist the turn ─────────────────────────────────────────────────
  const turn: ConversationTurn = {
    turnId: uuidv4(),
    sessionId,
    studentId,
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
  await touchSession(sessionId).catch(err => logger.warn({ err }, '[Crew] touchSession failed'));

  // Palace placement for this episode (async-safe)
  if (resolvedConcept || currentConcept) {
    setImmediate(() => {
      placeTurnInPalace(studentId, turn, resolvedSubject, resolvedConcept || currentConcept).catch(
        err => logger.debug({ err }, '[Crew] placeTurnInPalace failed')
      );
    });
  }

  const responseEvent: TutorResponseGenerated = {
    id: uuidv4(),
    type: 'tutor.response.generated',
    studentId,
    sessionId,
    timestamp: new Date(),
    responseText: finalResponse,
    modelUsed: generation.modelUsed,
    latencyMs,
    tokensIn: generation.tokensIn,
    tokensOut: generation.tokensOut,
    costUsd: generation.costUsd,
    toolsUsed,
    defensePassed: defense.passesAll,
    defenseIssues: defense.issues.map(i => i.issue),
    strategy: plan.strategy,
  };
  eventBus
    .publish(responseEvent)
    .catch(err =>
      logger.warn({ err }, '[Crew] EventBus publish failed (tutor.response.generated)')
    );

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
  }).catch(err => logger.warn({ err }, '[Crew] recordTurnMetric failed'));

  // ── 12. Async post-turn cognition (never blocks the reply) ───────────────
  setImmediate(() => {
    runPostTurn(ctx, plan, turn, perception.masterySignal).catch(err =>
      logger.debug({ err }, '[Crew] Post-turn processing failed')
    );
  });

  return finalResponse;
}

async function placeTurnInPalace(
  studentId: string,
  turn: ConversationTurn,
  subject: string | null | undefined,
  concept: string | null | undefined
): Promise<void> {
  if (!concept) return;
  try {
    const palaceCfg = await getCognitiveConfig('palace');
    if (palaceCfg.enabled === false) return;

    const subjectName = subject && subject !== 'general' ? subject : concept;
    const { drawer } = await autoConstructPalacePath(studentId, subjectName, concept, concept);

    // Find the episode graph node created by saveEpisode
    const graph = await getGraphAdapter();
    const episodeNodes = await graph.searchNodes(
      { labels: ['Episode'], turn_id: turn.turnId },
      1
    );
    if (episodeNodes.length > 0) {
      await placeInPalace(drawer.id, episodeNodes[0].id, 'episode');
    }
  } catch (err) {
    logger.debug({ err }, '[Crew] palace placement skipped');
  }
}

async function runPostTurn(
  ctx: TurnContext,
  plan: TeachingPlan,
  turn: ConversationTurn,
  masterySignal: string
): Promise<void> {
  const { studentId, sessionId, profile, perception } = ctx;

  // Self-critique
  const reflection = await runReflection(
    studentId,
    sessionId,
    turn.turnNumber,
    turn.studentMessage,
    turn.tutorResponse,
    { strategy: plan.strategy, intent: perception.primaryIntent }
  ).catch(err => {
    logger.debug({ err }, '[Crew] runReflection failed');
    return null;
  });

  if (reflection) {
    await db
      .query(`UPDATE conversation_turns SET reflection_score = $1 WHERE turn_id = $2`, [
        reflection.confidenceScore,
        turn.turnId,
      ])
      .catch(err => logger.warn({ err }, '[Crew] Failed to persist reflection score'));
  }

  // Attribute Extraction Pipeline (replaces instant_facts)
  const activeAttributes = await getActiveAttributes(studentId).catch(err => {
    logger.debug({ err }, '[Crew] getActiveAttributes (post-turn) failed');
    return {};
  });
  await extractAttributesFromTurn(
    studentId,
    turn.turnId,
    turn.studentMessage,
    turn.tutorResponse,
    perception.primaryIntent,
    activeAttributes
  ).catch(err => logger.debug({ err }, '[Crew] Attribute extraction failed'));

  // Archetype matching
  await matchArchetypes(studentId).catch(err =>
    logger.debug({ err }, '[Crew] Archetype matching failed')
  );

  // Ensure palace exists + tunnels discovery occasionally
  await ensurePalace(studentId).catch(err =>
    logger.debug({ err }, '[Crew] ensurePalace post-turn failed')
  );

  // Legacy student model pathway
  await updateStudentModel(
    profile,
    turn.studentMessage,
    turn.tutorResponse,
    perception,
    plan
  ).catch(err => {
    logger.debug({ err }, '[Crew] updateStudentModel failed');
  });

  // Curriculum assessment -> knowledge tracing, spaced repetition, progress
  if (turn.topic) {
    const examBoard =
      profile.culturalContext.examBoards?.[0] ||
      (typeof activeAttributes['exam_target'] === 'string'
        ? String(activeAttributes['exam_target'])
        : undefined) ||
      undefined;

    const decision = await assessCurriculum(
      turn.topic,
      turn.subject || 'general',
      turn.studentMessage,
      turn.tutorResponse,
      masterySignal,
      examBoard || 'unspecified',
      studentId
    ).catch(err => {
      logger.debug({ err }, '[Crew] assessCurriculum failed');
      return null;
    });

    if (decision) {
      if (decision.scheduleReview || masterySignal === 'strong') {
        const level =
          profile.conceptProgress[turn.topic]?.masteryLevel ??
          (masterySignal === 'strong' ? 0.8 : 0.5);
        await scheduleConceptReview(
          studentId,
          turn.topic,
          turn.subject || 'general',
          level
        ).catch(err => {
          logger.debug({ err }, '[Crew] scheduleConceptReview failed');
        });
      }
      if (decision.curriculumNote) {
        await applyMemoryEdit(studentId, 'progress', 'append', decision.curriculumNote).catch(
          err => {
            logger.debug({ err }, '[Crew] applyMemoryEdit (progress) failed');
          }
        );
      }

      if (decision.masteryAssessment === 'mastered') {
        await applyMemoryEdit(
          studentId,
          'breakthroughs',
          'append',
          `Mastered "${turn.topic}" on ${new Date().toLocaleDateString('en-NG')}`
        ).catch(err => {
          logger.debug({ err }, '[Crew] applyMemoryEdit (breakthroughs) failed');
        });

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
        }).catch(err => {
          logger.debug({ err }, '[Crew] decideNextTopic (post-mastery) failed');
          return null;
        });

        const nextConcept = navDecision?.nextTopic;
        await queueNotification(
          studentId,
          'breakthrough_celebration',
          `Student just mastered "${turn.topic}". Celebrate specifically.${nextConcept ? ` Suggest "${nextConcept}" as the next mountain to climb.` : ''}`,
          `breakthrough:${studentId}:${turn.topic}`
        );

        const masteryEvent: MasteryDetected = {
          id: uuidv4(),
          type: 'mastery.detected',
          studentId,
          sessionId,
          timestamp: new Date(),
          concept: turn.topic,
          evidenceType: 'curriculum_assessment',
          masteryLevel: profile.conceptProgress[turn.topic]?.masteryLevel ?? 0.8,
        };
        await eventBus
          .publish(masteryEvent)
          .catch(err => logger.warn({ err }, '[Crew] EventBus publish failed (mastery.detected)'));
      }
    }
  }

  // Refresh predictive pre-load after the turn so the next message is warm
  predictivePreLoad(studentId).catch(err =>
    logger.debug({ err }, '[Crew] post-turn predictivePreLoad failed')
  );

  await recordPromptPerformance('generation.v2', studentId, sessionId, turn.turnNumber, {
    studentEngagement: turn.studentMessage.length > 50 ? 0.8 : 0.5,
    masterySignal: masterySignal === 'strong',
    shameSpike: perception.emotionalSignals.shamePotential > 0.7,
    frustrationSpike: perception.emotionalSignals.frustration > 0.7,
    flowMaintained: perception.emotionalSignals.flowIndicator > 0.6,
    answerLeak: false,
  }).catch(err => logger.debug({ err }, '[Crew] recordPromptPerformance failed'));
}

async function queueNotification(
  studentId: string,
  type: string,
  content: string,
  dedupeKey: string
): Promise<void> {
  await db
    .query(
      `INSERT INTO notification_queue (student_id, type, content, scheduled_at, priority, dedupe_key)
     VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes', 5, $4)
     ON CONFLICT (dedupe_key) DO NOTHING`,
      [studentId, type, content, dedupeKey]
    )
    .catch(err => logger.warn({ err }, '[Crew] queueNotification failed'));
}
