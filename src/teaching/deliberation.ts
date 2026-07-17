/**
 * Deliberation — the teacher's mind.
 *
 * ONE smart-tier call that sees everything (perception, profile, memory,
 * history, recalled episodes, world model, session state) and decides how to
 * teach this turn. Replaces v1's swarm router + emotional agent + cultural
 * agent + chain stages 1-3 (4-6 sequential calls, each partially blind) with
 * a single fully-informed decision, per the Perception→Orchestration→
 * Elicitation architecture validated in recent Socratic-tutor research.
 *
 * Fallback: a reasoned default plan derived from perception + session state
 * keeps the turn alive if the call fails.
 */
import { routeAndCall } from '../llm/router';
import { getPrompt } from '../config/prompts';
import { logger } from '../middleware/logger';
import type { TeachingPlan, TurnContext } from '../types/teaching';

export async function deliberate(ctx: TurnContext): Promise<TeachingPlan> {
  const { perception, profile, sessionState, workingMemory } = ctx;

  const relationshipStage: TeachingPlan['relationshipStage'] =
    profile.totalTurns === 0 ? 'new' : profile.totalTurns < 20 ? 'familiar' : 'established';

  const fallbackPlan = buildFallbackPlan(ctx, relationshipStage);

  try {
    const instruction = await getPrompt('deliberation.v1');

    const situation = [
      `RELATIONSHIP: ${relationshipStage} student (${profile.totalTurns} lifetime turns, streak ${profile.studyStreak} days)${ctx.isFirstMessage ? ' — THIS IS THEIR VERY FIRST MESSAGE. Help first. Zero interrogation. At most one natural get-to-know-you question woven into real help.' : ''}`,
      `\nPERCEPTION OF THIS MESSAGE:`,
      `- intent: ${perception.primaryIntent} | topic: ${perception.inferredTopic || 'none'} | subject: ${perception.inferredSubject || 'none'}`,
      `- emotion: ${perception.emotionalSignals.dominantEmotion} (shame ${f2(perception.emotionalSignals.shamePotential)}, frustration ${f2(perception.emotionalSignals.frustration)}, curiosity ${f2(perception.emotionalSignals.curiosity)}, self-efficacy ${f2(perception.emotionalSignals.selfEfficacy)}, flow ${f2(perception.emotionalSignals.flowIndicator)})`,
      `- urgency: ${perception.urgency} | cognitive load: ${perception.cognitiveLoad} | mastery signal: ${perception.masterySignal}`,
      perception.hasMisconception ? `- suspected misconception: ${perception.misconceptionDescription}` : '',
      perception.isRepeatedQuestion ? `- NOTE: repeated question (${perception.repetitionCount + 1}x) — previous approach is failing` : '',
      `\nTEACHING STATE (this session):`,
      `- current concept: ${sessionState.currentConcept || 'none'} | hint level: ${sessionState.hintLevel}% | struggles this session: ${sessionState.struggleCount}`,
      `- approaches already tried (do NOT repeat): ${sessionState.approachesTried.join(', ') || 'none'}`,
      `- last strategy used: ${sessionState.lastStrategy || 'none'}`,
      `\nWHO THE STUDENT IS:`,
      `- profile: ${profile.memoryBlocks.humanProfile.slice(0, 250)}`,
      `- learning style: ${profile.memoryBlocks.learningStyle.slice(0, 200)}`,
      `- curiosity hooks: ${profile.memoryBlocks.curiosityMap.slice(0, 150)}`,
      `- shame triggers: ${profile.memoryBlocks.shameMap.slice(0, 150)}`,
      Object.keys(profile.facts).length > 0 ? `- facts: ${Object.entries(profile.facts).slice(0, 10).map(([k, v]) => `${k}=${v.factValue}`).join('; ')}` : '',
      profile.examTargets.length > 0 ? `- exams: ${JSON.stringify(profile.examTargets).slice(0, 200)}` : '',
      `\nCONTEXT:`,
      ctx.conversationHistory ? `Recent conversation:\n${ctx.conversationHistory.slice(-900)}` : 'No conversation yet.',
      ctx.recalledEpisodes ? `\nRELEVANT PAST MOMENTS (other sessions):\n${ctx.recalledEpisodes}` : '',
      ctx.dueReviews ? `\nSPACED REVIEWS DUE: ${ctx.dueReviews} — consider weaving one in naturally IF the moment allows` : '',
      ctx.reflectionLessons ? `\n${ctx.reflectionLessons}` : '',
      ctx.worldModelInsight ? `\nWORLD MODEL: ${ctx.worldModelInsight}` : '',
      ctx.causalInsight ? `\nROOT-CAUSE ANALYSIS: ${ctx.causalInsight}` : '',
      ctx.subjectContext ? `\n${ctx.subjectContext}` : '',
      ctx.toolContext ? `\nRESOURCES:\n${ctx.toolContext.slice(0, 500)}` : '',
      `\nSTUDENT'S MESSAGE: "${perception.rawMessage.slice(0, 600)}"`,
    ].filter(Boolean).join('\n');

    const response = await routeAndCall([
      { role: 'system', content: instruction },
      { role: 'user', content: situation },
    ], { tier: 'smart', jsonMode: true, maxTokens: 550, temperature: 0.35, studentId: ctx.studentId, purpose: 'deliberation' });

    const parsed = JSON.parse(response.content.replace(/```json|```/g, '').trim());
    return normalizePlan(parsed, fallbackPlan, relationshipStage);
  } catch (err) {
    logger.warn({ err }, '[Deliberation] Failed — using reasoned fallback plan');
    return fallbackPlan;
  }
}

function buildFallbackPlan(ctx: TurnContext, relationshipStage: TeachingPlan['relationshipStage']): TeachingPlan {
  const { perception, sessionState } = ctx;
  const es = perception.emotionalSignals;

  let strategy: TeachingPlan['strategy'] = 'direct_explanation';
  if (perception.primaryIntent === 'expressing_emotion' || es.shamePotential > 0.6) strategy = 'reassurance';
  else if (perception.primaryIntent === 'casual_chat' || perception.primaryIntent === 'greeting') strategy = 'listen_and_connect';
  else if (sessionState.struggleCount >= 2 || perception.isRepeatedQuestion) strategy = 'pivot_completely';
  else if (es.flowIndicator > 0.6) strategy = 'socratic';
  else if (perception.hasMisconception) strategy = 'elaborative_interrogation';
  else if (perception.primaryIntent === 'asking_answer') strategy = 'hint_ladder';

  return {
    strategy,
    strategyReason: 'Fallback reasoning from perception and session state',
    warmthLevel: es.shamePotential > 0.5 || es.frustration > 0.5 ? 0.9 : 0.7,
    challengeLevel: es.flowIndicator > 0.6 ? 0.8 : 0.5,
    pacing: es.frustration > 0.5 || sessionState.struggleCount >= 2 ? 'slow' : 'normal',
    hintLevel: Math.min(90, sessionState.struggleCount * 25),
    useAnalogy: sessionState.struggleCount >= 1,
    analogyDomain: null,
    askQuestion: perception.primaryIntent !== 'expressing_emotion',
    questionPurpose: 'guide_thinking',
    addressMisconception: perception.hasMisconception,
    misconceptionCorrection: perception.misconceptionDescription,
    connectToMemory: null,
    emotionalApproach: es.shamePotential > 0.5 ? 'Maximum warmth, smallest possible first step' : 'Warm and encouraging',
    mustInclude: [],
    mustAvoid: ['giving the final answer'],
    sessionGoal: 'Move understanding one step forward',
    bloomTarget: 'understand',
    relationshipStage,
    needsTools: [],
    expectedOutcome: 'Student engages with the next step',
  };
}

function normalizePlan(
  parsed: Record<string, unknown>,
  fallback: TeachingPlan,
  relationshipStage: TeachingPlan['relationshipStage']
): TeachingPlan {
  return {
    strategy: (parsed.strategy as TeachingPlan['strategy']) || fallback.strategy,
    strategyReason: (parsed.strategyReason as string) || fallback.strategyReason,
    warmthLevel: clamp01(parsed.warmthLevel, fallback.warmthLevel),
    challengeLevel: clamp01(parsed.challengeLevel, fallback.challengeLevel),
    pacing: (parsed.pacing as TeachingPlan['pacing']) || fallback.pacing,
    hintLevel: Math.max(0, Math.min(100, typeof parsed.hintLevel === 'number' ? parsed.hintLevel : fallback.hintLevel)),
    useAnalogy: parsed.useAnalogy === true,
    analogyDomain: (parsed.analogyDomain as string) || null,
    askQuestion: parsed.askQuestion !== false,
    questionPurpose: (parsed.questionPurpose as TeachingPlan['questionPurpose']) || fallback.questionPurpose,
    addressMisconception: parsed.addressMisconception === true,
    misconceptionCorrection: (parsed.misconceptionCorrection as string) || null,
    connectToMemory: (parsed.connectToMemory as string) || null,
    emotionalApproach: (parsed.emotionalApproach as string) || fallback.emotionalApproach,
    mustInclude: Array.isArray(parsed.mustInclude) ? (parsed.mustInclude as string[]).slice(0, 4) : [],
    mustAvoid: Array.isArray(parsed.mustAvoid) ? (parsed.mustAvoid as string[]).slice(0, 4) : fallback.mustAvoid,
    sessionGoal: (parsed.sessionGoal as string) || fallback.sessionGoal,
    bloomTarget: (parsed.bloomTarget as TeachingPlan['bloomTarget']) || fallback.bloomTarget,
    relationshipStage,
    needsTools: Array.isArray(parsed.needsTools) ? (parsed.needsTools as string[]).slice(0, 3) : [],
    expectedOutcome: (parsed.expectedOutcome as string) || fallback.expectedOutcome,
  };
}

function clamp01(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : fallback;
  return Math.max(0, Math.min(1, n));
}

function f2(n: number): string {
  return n.toFixed(2);
}
