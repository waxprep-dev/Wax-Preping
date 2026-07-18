/**
 * Onboarding Dialogue Engine — Layer 1 of the Dynamic Student Profile.
 *
 * NOT A SCRIPT. This is a goal-driven conversation system.
 * The AI knows what it needs to discover, but crafts natural conversation to get there.
 * If a student drops off, they resume exactly where they left off.
 */
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/client';
import { logger } from '../middleware/logger';
import { routeAndCall } from '../llm/router';
import { getPrompt } from '../config/prompts';
import { loadDiscoveryGoals, type DiscoveryGoal } from './config';
import { extractAttributesFromTurn, getActiveAttributes } from '../student_profile/attribute_pipeline';
import { matchArchetypes, warmStartFromArchetype } from '../student_profile/archetypes';
import type { PerceptionResult } from '../types/teaching';

export interface OnboardingState {
  studentId: string;
  isComplete: boolean;
  discoveryGoalsSatisfied: Record<string, boolean>;
  turnsCompleted: number;
  lastGoalAttempted: string | null;
  droppedOffAtGoal: string | null;
  startedAt: Date;
  completedAt: Date | null;
  resumedCount: number;
}

/**
 * Check if a student needs onboarding or is mid-onboarding.
 */
export async function getOnboardingState(studentId: string): Promise<OnboardingState> {
  const result = await db.query(
    `SELECT * FROM onboarding_state WHERE student_id = $1`,
    [studentId]
  );

  if (result.rows.length === 0) {
    return {
      studentId,
      isComplete: false,
      discoveryGoalsSatisfied: {},
      turnsCompleted: 0,
      lastGoalAttempted: null,
      droppedOffAtGoal: null,
      startedAt: new Date(),
      completedAt: null,
      resumedCount: 0,
    };
  }

  const row = result.rows[0];
  return {
    studentId: row.student_id,
    isComplete: row.is_complete,
    discoveryGoalsSatisfied: row.discovery_goals_satisfied || {},
    turnsCompleted: row.turns_completed,
    lastGoalAttempted: row.last_goal_attempted,
    droppedOffAtGoal: row.dropped_off_at_goal,
    startedAt: new Date(row.started_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    resumedCount: row.resumed_count,
  };
}

/**
 * Save onboarding state to database.
 */
async function saveOnboardingState(state: OnboardingState): Promise<void> {
  await db.query(
    `INSERT INTO onboarding_state (
      student_id, is_complete, discovery_goals_satisfied, turns_completed,
      last_goal_attempted, dropped_off_at_goal, started_at, completed_at, resumed_count
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (student_id) DO UPDATE SET
      is_complete = EXCLUDED.is_complete,
      discovery_goals_satisfied = EXCLUDED.discovery_goals_satisfied,
      turns_completed = EXCLUDED.turns_completed,
      last_goal_attempted = EXCLUDED.last_goal_attempted,
      dropped_off_at_goal = EXCLUDED.dropped_off_at_goal,
      started_at = EXCLUDED.started_at,
      completed_at = EXCLUDED.completed_at,
      resumed_count = EXCLUDED.resumed_count`,
    [
      state.studentId,
      state.isComplete,
      JSON.stringify(state.discoveryGoalsSatisfied),
      state.turnsCompleted,
      state.lastGoalAttempted,
      state.droppedOffAtGoal,
      state.startedAt,
      state.completedAt,
      state.resumedCount,
    ]
  );
}

/**
 * Main entry point. Called by the crew when a new student arrives.
 * Returns the tutor's response for this onboarding turn.
 */
export async function handleOnboardingTurn(
  studentId: string,
  studentMessage: string,
  perception: PerceptionResult,
  isFirstMessage: boolean
): Promise<{ response: string; isComplete: boolean; state: OnboardingState }> {
  const state = await getOnboardingState(studentId);

  // If they dropped off, note the resume
  if (state.droppedOffAtGoal && !state.isComplete) {
    state.resumedCount += 1;
    logger.info(`[Onboarding] ${studentId} resumed after dropping off at ${state.droppedOffAtGoal}`);
  }

  const goals = await loadDiscoveryGoals();
  const activeAttributes = await getActiveAttributes(studentId);

  // Determine which goals are already satisfied
  const satisfiedGoalIds = new Set<string>();
  for (const goal of goals) {
    if (isGoalSatisfied(goal, activeAttributes)) {
      satisfiedGoalIds.add(goal.id);
      state.discoveryGoalsSatisfied[goal.id] = true;
    }
  }

  // Find the next unsatisfied goal with highest priority
  const nextGoal = goals
    .filter(g => !satisfiedGoalIds.has(g.id))
    .sort((a, b) => a.priority - b.priority)[0];

  // If all goals satisfied, complete onboarding
  if (!nextGoal) {
    state.isComplete = true;
    state.completedAt = new Date();
    await saveOnboardingState(state);
    await matchArchetypes(studentId);
    await warmStartFromArchetype(studentId);
    logger.info(`[Onboarding] ${studentId} completed all discovery goals`);
    return { response: '', isComplete: true, state };
  }

  state.lastGoalAttempted = nextGoal.id;
  state.turnsCompleted += 1;

  // Build the prompt for the AI
  const instruction = await getPrompt('onboarding.v1');
  const goalContext = buildGoalContext(nextGoal, goals, satisfiedGoalIds, state, activeAttributes);

  const response = await routeAndCall([
    { role: 'system', content: instruction },
    {
      role: 'user',
      content: [
        isFirstMessage
          ? 'This is the VERY FIRST message from this student. They know nothing about you yet. Be warm, human, and natural. Do NOT say "Welcome to our tutoring sessions."'
          : `This is turn ${state.turnsCompleted} of onboarding. The student said: "${studentMessage.slice(0, 400)}"`,
        goalContext,
        `Perception: intent=${perception.primaryIntent}, emotion=${perception.emotionalSignals.dominantEmotion}, confidence=${perception.emotionalSignals.selfEfficacy.toFixed(2)}`,
        `\nIMPORTANT RULES:`,
        `- NEVER sound scripted. Adapt to whatever the student says.`,
        `- If the student asks a question, answer it naturally — do not force the discovery goal.`,
        `- If the student shares something personal, acknowledge it warmly before gently guiding back.`,
        `- If the student seems uncomfortable, back off. Mark the goal as partially satisfied and move on.`,
        `- Each response should feel like a real human conversation, not a survey.`,
        `- Do NOT ask more than ONE question per message.`,
        `- Keep responses under 3 WhatsApp bubbles (under 400 characters).`,
      ].join('\n\n'),
    },
  ], {
    tier: 'smart',
    maxTokens: 500,
    temperature: 0.7,
    studentId,
    purpose: 'onboarding',
  });

  const cleanResponse = response.content
    .replace(/welcome to our tutoring sessions?[!.]?/gi, '')
    .replace(/certainly[!.]?/gi, '')
    .replace(/great question[!.]?/gi, '')
    .trim();

  // After the AI responds, extract any new attributes from this turn
  setImmediate(async () => {
    try {
      await extractAttributesFromTurn(
        studentId,
        undefined,
        studentMessage,
        cleanResponse,
        perception.primaryIntent,
        activeAttributes
      );
    } catch (err) {
      logger.debug({ err }, '[Onboarding] Attribute extraction failed');
    }
  });

  // Check if this goal is now satisfied after the turn
  const updatedAttributes = await getActiveAttributes(studentId);
  if (isGoalSatisfied(nextGoal, updatedAttributes)) {
    state.discoveryGoalsSatisfied[nextGoal.id] = true;
    logger.info(`[Onboarding] ${studentId} satisfied goal: ${nextGoal.id}`);
  }

  // Safety valve: if we've spent too many turns on one goal, move on
  const turnsOnThisGoal = countTurnsOnGoal(state, nextGoal.id);
  if (turnsOnThisGoal >= nextGoal.maxTurnsToSpend) {
    state.discoveryGoalsSatisfied[nextGoal.id] = true;
    logger.info(`[Onboarding] ${studentId} max turns reached for goal ${nextGoal.id}, moving on`);
  }

  // If total turns exceed a reasonable limit, complete onboarding
  if (state.turnsCompleted >= 15) {
    state.isComplete = true;
    state.completedAt = new Date();
    logger.info(`[Onboarding] ${studentId} force-completed after ${state.turnsCompleted} turns`);
  }

  await saveOnboardingState(state);

  if (state.isComplete) {
    await matchArchetypes(studentId);
    await warmStartFromArchetype(studentId);
  }

  return { response: cleanResponse, isComplete: state.isComplete, state };
}

/**
 * Check if a discovery goal is satisfied based on active attributes.
 */
function isGoalSatisfied(goal: DiscoveryGoal, attributes: Record<string, unknown>): boolean {
  const satisfiedCount = goal.targetAttributes.filter(attrKey => {
    const attr = attributes[attrKey];
    if (!attr) return false;
    const confidence = typeof attr === 'object' && attr !== null 
      ? (attr as Record<string, unknown>).confidence as number 
      : 0;
    return confidence >= 0.6;
  }).length;

  if (goal.satisfactionCriteria.includes('At least')) {
    const match = goal.satisfactionCriteria.match(/at least (\d+)/i);
    const required = match ? parseInt(match[1], 10) : 1;
    return satisfiedCount >= required;
  }

  return satisfiedCount >= Math.ceil(goal.targetAttributes.length / 2);
}

function buildGoalContext(
  currentGoal: DiscoveryGoal,
  allGoals: DiscoveryGoal[],
  satisfiedIds: Set<string>,
  state: OnboardingState,
  attributes: Record<string, unknown>
): string {
  const satisfiedGoals = allGoals.filter(g => satisfiedIds.has(g.id));
  const pendingGoals = allGoals.filter(g => !satisfiedIds.has(g.id) && g.id !== currentGoal.id);

  const parts: string[] = [
    `CURRENT DISCOVERY GOAL: ${currentGoal.id}`,
    `Description: ${currentGoal.description}`,
    `Target attributes: ${currentGoal.targetAttributes.join(', ')}`,
    `Satisfaction criteria: ${currentGoal.satisfactionCriteria}`,
    `Example approaches (inspiration only — do NOT copy verbatim):`,
    ...currentGoal.exampleApproaches.map(a => `  - ${a}`),
  ];

  if (satisfiedGoals.length > 0) {
    parts.push(`\nALREADY DISCOVERED:`);
    for (const g of satisfiedGoals) {
      const foundAttrs = g.targetAttributes
        .filter(k => attributes[k])
        .map(k => `${k}=${JSON.stringify((attributes[k] as Record<string, unknown>).value)}`);
      parts.push(`  ${g.id}: ${foundAttrs.join(', ')}`);
    }
  }

  if (pendingGoals.length > 0) {
    parts.push(`\nPENDING GOALS (do not pursue yet): ${pendingGoals.map(g => g.id).join(', ')}`);
  }

  if (state.resumedCount > 0) {
    parts.push(`\nNOTE: Student dropped off previously and has resumed. Be extra warm.`);
  }

  return parts.join('\n');
}

function countTurnsOnGoal(state: OnboardingState, goalId: string): number {
  const totalUnsatisfied = Object.keys(state.discoveryGoalsSatisfied).filter(k => !state.discoveryGoalsSatisfied[k]).length;
  return Math.max(1, Math.floor(state.turnsCompleted / Math.max(1, 5 - totalUnsatisfied)));
}

/**
 * Check if a student is currently in onboarding.
 */
export async function isInOnboarding(studentId: string): Promise<boolean> {
  const state = await getOnboardingState(studentId);
  return !state.isComplete;
}