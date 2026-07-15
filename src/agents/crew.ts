// The Crew. Now simplified to pure coordination.
// The Swarm does the thinking. This file handles the plumbing.

import { v4 as uuidv4 } from 'uuid';
import { eventBus } from '../events/bus';
import { runSwarm } from '../swarm';
import { runReflection } from '../orchestrator/reflection';
import { buildWorkingMemory, formatHistoryForOrchestrator } from '../memory/working';
import { getStudentProfile, applyMemoryEdit, updateStudyStreak, incrementTurns, updateSymbolicBelief } from '../memory/semantic';
import { saveEpisode, getRecentHistory } from '../memory/episodic';
import { getOrCreateSession, saveTurn, touchSession } from '../session/manager';
import { scheduleConceptReview, getDueReviews } from '../features/spaced_repetition';
import { routeAndEncode } from '../encoders/router';
import { recordPromptPerformance } from '../prompts/evolution';
import { logger } from '../middleware/logger';
import type { ConversationTurn } from '../types/student';

export interface ProcessMessageInput {
  studentId: string;
  sessionId: string;
  rawMessage: string;
  messageId: string;
  modality: 'text' | 'image' | 'audio' | 'document' | 'video';
  isFirstMessage?: boolean;
  mediaId?: string;
  mediaCaption?: string;
}

export async function processTutorMessage(input: ProcessMessageInput): Promise<string> {
  const { studentId, sessionId, rawMessage, modality, isFirstMessage, mediaId, mediaCaption } = input;

  // 1. Load session and history
  const session = await getOrCreateSession(studentId);
  const history = await getRecentHistory(session.sessionId, 14);

  // 2. Load profile
  const profile = await getStudentProfile(studentId);

  // 3. Update streak and turns
  const newStreak = await updateStudyStreak(studentId);
  await incrementTurns(studentId);

  // 4. Encode the input (handles text/image/voice/document)
  const { intent, modality: detectedModality } = await routeAndEncode(
    {
      type: modality === 'audio' ? 'audio' : modality,
      text: rawMessage,
      mediaId,
      caption: mediaCaption,
    },
    history.slice(-5).map(t => t.studentMessage)
  );

  // 5. Build working memory
  const workingMemory = buildWorkingMemory(history);
  const historyText = formatHistoryForOrchestrator(history, 12);

  // 6. Run the Swarm
  const start = Date.now();

  const swarmOutput = await runSwarm({
    studentId,
    sessionId,
    rawMessage: intent.rawMessage,
    modality: detectedModality,
    profile,
    workingMemory,
    isFirstMessage: isFirstMessage || false,
    visionContext: (intent as { _visionContext?: Record<string, unknown> })._visionContext,
    paralinguistics: (intent as { _paralinguistics?: Record<string, unknown> })._paralinguistics,
    conversationHistory: historyText,
  });

  const latencyMs = Date.now() - start;
  const finalResponse = swarmOutput.finalResponse;

  logger.info(`[Crew] Swarm used agents: ${swarmOutput.agentsUsed.join(' → ')} in ${latencyMs}ms`);

  // 7. Apply curriculum agent's knowledge graph updates
  if (swarmOutput.curriculumDecision?.conceptBelief && workingMemory.currentTopic) {
    const belief = swarmOutput.curriculumDecision.conceptBelief;
    await updateSymbolicBelief(
      studentId,
      workingMemory.currentTopic,
      belief.claim,
      belief.status,
      belief.confidence,
      belief.evidence
    ).catch(() => {});

    if (swarmOutput.curriculumDecision.scheduleReview && workingMemory.currentTopic) {
      await scheduleConceptReview(
        studentId,
        workingMemory.currentTopic,
        workingMemory.currentSubject || 'general',
        swarmOutput.curriculumDecision.masteryAssessment === 'mastered' ? 0.8 : 0.5
      ).catch(() => {});
    }

    if (swarmOutput.curriculumDecision.curriculumNote) {
      await applyMemoryEdit(studentId, 'progress', 'append', swarmOutput.curriculumDecision.curriculumNote).catch(() => {});
    }
  }

  // 8. Save turn
  const turn: ConversationTurn = {
    turnId: uuidv4(),
    sessionId: session.sessionId,
    studentId,
    turnNumber: session.turnCount + 1,
    studentMessage: intent.rawMessage,
    tutorResponse: finalResponse,
    modality: detectedModality,
    aiAnalysis: {
      sessionPhase: swarmOutput.routing.sessionPhase,
      pedagogicalStrategy: swarmOutput.routing.primaryAgent,
      stuckDetected: workingMemory.stuckRepetitionCount >= 2,
    },
    modelUsed: 'swarm/v1.0.0',
    latencyMs,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    toolsUsed: swarmOutput.agentsUsed,
    topic: workingMemory.currentTopic || undefined,
    subject: workingMemory.currentSubject || undefined,
    masteryEvidenced: swarmOutput.curriculumDecision?.masteryAssessment === 'mastered',
    timestamp: new Date(),
  };

  await saveEpisode(turn).catch(() => {});
  await saveTurn(turn).catch(() => {});
  await touchSession(session.sessionId).catch(() => {});

  // 9. Emit events
  await eventBus.publish({
    id: uuidv4(),
    type: 'tutor.response.generated',
    studentId,
    sessionId,
    timestamp: new Date(),
    responseText: finalResponse,
    modelUsed: 'swarm',
    latencyMs,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    toolsUsed: swarmOutput.agentsUsed,
    defensePassed: swarmOutput.defensePassed,
    defenseIssues: swarmOutput.defenseIssues,
  });

  if (swarmOutput.curriculumDecision?.masteryAssessment === 'mastered' && workingMemory.currentTopic) {
    await eventBus.publish({
      id: uuidv4(),
      type: 'mastery.detected',
      studentId,
      sessionId,
      timestamp: new Date(),
      concept: workingMemory.currentTopic,
      evidenceType: 'swarm_curriculum_assessment',
      masteryLevel: 0.8,
    });

    // Queue a personalized breakthrough celebration
    await db_queue(studentId, 'breakthrough_celebration',
      `Student just mastered "${workingMemory.currentTopic}". They previously struggled with it. Celebrate this specifically.`
    );
  }

  // 10. Self-reflection (non-blocking)
  setImmediate(async () => {
    await runReflection(
      studentId, sessionId, session.turnCount + 1,
      intent.rawMessage, finalResponse,
      { sessionPhase: swarmOutput.routing.sessionPhase }
    ).catch(() => {});
  });

  // 11. Record prompt performance
  await recordPromptPerformance('swarm_v1', studentId, sessionId, session.turnCount + 1, {
    studentEngagement: intent.rawMessage.length > 50 ? 0.8 : 0.5,
    masterySignal: swarmOutput.curriculumDecision?.masteryAssessment === 'mastered',
    shameSpike: swarmOutput.routing.emotionalFlag === 'shame',
    frustrationSpike: swarmOutput.routing.emotionalFlag === 'frustration',
    flowMaintained: swarmOutput.routing.emotionalFlag === 'flow',
    answerLeak: !swarmOutput.defensePassed && swarmOutput.defenseIssues.some(i => i.includes('answer')),
  }).catch(() => {});

  return finalResponse;
}

async function db_queue(studentId: string, type: string, context: string): Promise<void> {
  const { db } = await import('../db/client');
  await db.query(
    `INSERT INTO notification_queue (id, student_id, type, content, scheduled_at, priority)
     VALUES (gen_random_uuid(), $1, $2, $3, NOW() + INTERVAL '5 minutes', 5)`,
    [studentId, type, context]
  ).catch(() => {});
}