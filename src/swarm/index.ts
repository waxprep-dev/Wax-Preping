// The Swarm Coordinator.
// Orchestrates all agents in the right sequence.
// The Router classifies first (50ms).
// Then agents run in sequence or parallel based on urgency.
// The Defense Agent always runs last.

import { v4 as uuidv4 } from 'uuid';
import { routeMessage } from './router';
import { runEmotionalAgent } from './emotional_agent';
import { runPedagogyAgent } from './pedagogy_agent';
import { runCulturalAgent } from './cultural_agent';
import { runCurriculumAgent } from './curriculum_agent';
import { runDefenseChecks } from '../prompts/defense';
import { getSubjectContext } from '../prompts/subject_router';
import { getWorldModelState } from '../world_model/predictive_model';
import { logger } from '../middleware/logger';
import type { StudentProfile, WorkingMemorySnapshot } from '../types/student';

export interface SwarmInput {
  studentId: string;
  sessionId: string;
  rawMessage: string;
  modality: string;
  profile: StudentProfile;
  workingMemory: WorkingMemorySnapshot;
  isFirstMessage: boolean;
  visionContext?: Record<string, unknown>;
  paralinguistics?: Record<string, unknown>;
  conversationHistory: string;
}

export interface SwarmOutput {
  finalResponse: string;
  agentsUsed: string[];
  routing: Awaited<ReturnType<typeof routeMessage>>;
  curriculumDecision?: Awaited<ReturnType<typeof runCurriculumAgent>>;
  defensePassed: boolean;
  defenseIssues: string[];
}

export async function runSwarm(input: SwarmInput): Promise<SwarmOutput> {
  const {
    studentId, sessionId, rawMessage, modality,
    profile, workingMemory, conversationHistory,
  } = input;

  const agentsUsed: string[] = ['router'];

  // Step 1: Route (50ms with local model)
  const lastAnalysis = workingMemory.salienceRankedTurns[0];
  const lastShame = 0.3;
  const lastFlow = 0.3;

  const routing = await routeMessage(
    rawMessage,
    workingMemory.stuckRepetitionCount,
    lastShame,
    lastFlow,
    modality
  );

  logger.info(`[Swarm] Routing: ${routing.primaryAgent}, urgency: ${routing.urgency}, emotion: ${routing.emotionalFlag}`);

  // Step 2: World Model insight
  const worldModel = await getWorldModelState(studentId);
  const worldModelInsight = worldModel
    ? `Predicted next mistake: ${worldModel.predictedNextMistake || 'none'}. Frustration probability: ${(worldModel.predictedFrustrationProbability * 100).toFixed(0)}%. Flow probability: ${(worldModel.predictedFlowProbability * 100).toFixed(0)}%.`
    : '';

  // Step 3: Emotional Agent (if needed)
  let emotionalFraming = '';
  if (routing.emotionalFlag !== 'neutral' || routing.primaryAgent === 'emotional') {
    agentsUsed.push('emotional');
    emotionalFraming = await runEmotionalAgent(
      rawMessage,
      routing.emotionalFlag,
      workingMemory.stuckRepetitionCount,
      profile.memoryBlocks,
      conversationHistory
    );
  }

  // Step 4: Cultural Agent (if needed)
  let culturalGrounding = '';
  const needsCultural =
    routing.supportingAgents.includes('cultural') ||
    workingMemory.stuckRepetitionCount >= 2 ||
    routing.sessionPhase === 'struggling';

  if (needsCultural && workingMemory.currentTopic) {
    agentsUsed.push('cultural');
    const previousAnalogyFailed = workingMemory.stuckRepetitionCount >= 2 &&
      workingMemory.approachesAttempted.includes('analogy');

    culturalGrounding = await runCulturalAgent(
      workingMemory.currentTopic,
      workingMemory.currentSubject || 'general',
      profile.culturalContext,
      profile.analogyLibrary,
      previousAnalogyFailed
    );
  }

  // Step 5: Subject context
  const subjectContext = workingMemory.currentTopic
    ? getSubjectContext(
        workingMemory.currentSubject || 'general',
        workingMemory.currentTopic,
        workingMemory.studentConfidence
      )
    : '';

  // Step 6: Pedagogy Agent (always runs)
  agentsUsed.push('pedagogy');

  const combinedContext = [
    culturalGrounding ? `CULTURAL GROUNDING TO USE:\n${culturalGrounding}` : '',
    worldModelInsight ? `WORLD MODEL INSIGHTS:\n${worldModelInsight}` : '',
    subjectContext,
  ].filter(Boolean).join('\n\n');

  const pedagogyResponse = await runPedagogyAgent(
    rawMessage,
    emotionalFraming || 'No specific emotional concern — proceed naturally.',
    routing.sessionPhase,
    combinedContext,
    workingMemory,
    workingMemory.hintLevelCurrent,
    workingMemory.approachesAttempted,
    worldModelInsight
  );

  // Step 7: Defense Agent (always last)
  agentsUsed.push('defense');
  const defense = await runDefenseChecks(rawMessage, pedagogyResponse, studentId, sessionId);

  // Step 8: Curriculum Agent (async, non-blocking — updates graph for future sessions)
  let curriculumDecision;
  if (workingMemory.currentTopic) {
    curriculumDecision = await runCurriculumAgent(
      studentId,
      workingMemory.currentTopic,
      workingMemory.currentSubject || 'general',
      rawMessage,
      defense.finalResponse,
      false,
      profile.culturalContext.examBoards?.[0] || 'WAEC'
    ).catch(() => undefined);

    if (curriculumDecision) agentsUsed.push('curriculum');
  }

  return {
    finalResponse: defense.finalResponse,
    agentsUsed,
    routing,
    curriculumDecision,
    defensePassed: defense.passesAll,
    defenseIssues: defense.issues.map(i => i.issue),
  };
}