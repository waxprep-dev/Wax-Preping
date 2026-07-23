/**
 * Deliberation — the teacher's mind.
 *
 * ONE smart-tier call that sees everything (perception, profile, memory,
 * history, recalled episodes, world model, session state, dynamic attributes,
 * archetype guidance, and available tools) and decides how to teach this turn.
 *
 * v3.0: Tool registry is injected dynamically from the database. The LLM knows
 * exactly which tools are available and can request them in needsTools.
 */
import { routeAndCall } from '../llm/router';
import { getPrompt } from '../config/prompts';
import { logger } from '../middleware/logger';
import { db } from '../db/client';
import { clamp01, f2 } from '../utils/math';
import {
  applyPolicyToPlan,
  decideTeachingPolicy,
  detectStudentSignals,
  type TeachingPolicy,
} from './policy';
import type { TeachingPlan, TurnContext } from '../types/teaching';

export async function deliberate(ctx: TurnContext): Promise<TeachingPlan> {
  const { perception, profile, sessionState } = ctx;

  const relationshipStage: TeachingPlan['relationshipStage'] =
    profile.totalTurns === 0 ? 'new' : profile.totalTurns < 20 ? 'familiar' : 'established';

  const policy = decideTeachingPolicy({
    perception,
    profile,
    sessionState,
    isFirstMessage: ctx.isFirstMessage,
  });

  const hardEnforce = shouldHardEnforce(policy.move, perception, sessionState);

  const fallbackPlan = hardEnforce
    ? applyPolicyToPlan(buildFallbackPlan(ctx, relationshipStage, policy), policy)
    : softAdvisePlan(buildFallbackPlan(ctx, relationshipStage, policy), policy);
  fallbackPlan.policyMove = policy.move;
  fallbackPlan.mustTeachContent = hardEnforce ? policy.mustTeachContent : (policy.mustTeachContent || false);
  fallbackPlan.maxQuestionsThisTurn = policy.maxQuestionsThisTurn;

  try {
    const instruction = await getPrompt('deliberation.v2');

    // v3.0: Fetch available tools from dynamic registry
    const availableTools = await getEnabledTools().catch(() => []);
    const toolDescriptions = availableTools.length > 0
      ? availableTools.map(t => `- ${t.name}: ${t.description}`).join('\n')
      : 'No tools currently available.';

    const signals = detectStudentSignals(perception.rawMessage);
    const situation = [
      `RELATIONSHIP: ${relationshipStage} student (${profile.totalTurns} lifetime turns, streak ${profile.studyStreak} days)${ctx.isFirstMessage ? ' — THIS IS THEIR VERY FIRST MESSAGE. Sound human. Zero formal onboarding. At most one natural question.' : ''}`,
      `\nHARD TEACHING POLICY (non-negotiable — your plan MUST obey this):`,
      `- move: ${policy.move}`,
      `- mustTeachContent: ${policy.mustTeachContent}`,
      `- forceAskQuestion: ${policy.forceAskQuestion === null ? 'your judgment (max 1)' : policy.forceAskQuestion}`,
      `- maxQuestionsThisTurn: ${policy.maxQuestionsThisTurn}`,
      `- preferred strategies: ${policy.preferredStrategies.join(', ')}`,
      `- banned strategies: ${policy.bannedStrategies.join(', ') || 'none'}`,
      `- policy reason: ${policy.reason}`,
      `- consecutive questions so far: ${sessionState.consecutiveQuestions ?? 0}`,
      `- questions this session: ${sessionState.questionsThisSession ?? 0}`,
      `- last tutor asked a question: ${sessionState.lastTutorAskedQuestion ?? false}`,
      `- turns since last teach: ${sessionState.turnsSinceLastTeach ?? 0}`,
      `\nSTUDENT SIGNALS:`,
      `- readyToLearn=${signals.readyToLearn} | doesNotKnow=${signals.doesNotKnow} | wantsExit=${signals.wantsExit} | foundationGap=${signals.foundationGap} | shortAck=${signals.shortAck}`,
      `\nPERCEPTION OF THIS MESSAGE:`,
      `- intent: ${perception.primaryIntent} | topic: ${perception.inferredTopic || 'none'} | subject: ${perception.inferredSubject || 'none'}`,
      `- emotion: ${perception.emotionalSignals.dominantEmotion} (shame ${f2(perception.emotionalSignals.shamePotential)}, frustration ${f2(perception.emotionalSignals.frustration)}, curiosity ${f2(perception.emotionalSignals.curiosity)}, self-efficacy ${f2(perception.emotionalSignals.selfEfficacy)}, flow ${f2(perception.emotionalSignals.flowIndicator)})`,
      `- urgency: ${perception.urgency} | cognitive load: ${perception.cognitiveLoad} | mastery signal: ${perception.masterySignal}`,
      perception.hasMisconception ? `- suspected misconception: ${perception.misconceptionDescription}` : '',
      perception.isRepeatedQuestion ? `- NOTE: repeated question (${perception.repetitionCount + 1}x) — previous approach is failing` : '',
      `\nTEACHING STATE (this session):`,
      `- current concept: ${sessionState.currentConcept || 'none'} | hint level: ${sessionState.hintLevel}% | struggles this session: ${sessionState.struggleCount}`,
      `- approaches already tried (do NOT repeat): ${sessionState.approachesTried.join(', ') || 'none'}`,
      `- last strategy used: ${sessionState.lastStrategy || 'none'} | last move: ${sessionState.lastMove || 'none'}`,
      `\nWHO THE STUDENT IS:`,
      `- profile: ${profile.memoryBlocks.humanProfile.slice(0, 250)}`,
      `- learning style: ${profile.memoryBlocks.learningStyle.slice(0, 200)}`,
      `- curiosity hooks: ${profile.memoryBlocks.curiosityMap.slice(0, 150)}`,
      `- shame triggers: ${profile.memoryBlocks.shameMap.slice(0, 150)}`,
      Object.keys(profile.facts).length > 0 ? `- facts: ${Object.entries(profile.facts).slice(0, 10).map(([k, v]) => `${k}=${v.factValue}`).join('; ')}` : '',
      profile.examTargets.length > 0 ? `- exams: ${JSON.stringify(profile.examTargets).slice(0, 200)}` : '',
      `\nAVAILABLE TOOLS (you may request up to 2 in needsTools):`,
      toolDescriptions,
      `\nCONTEXT:`,
      ctx.conversationHistory ? `Recent conversation:\n${ctx.conversationHistory.slice(-900)}` : 'No conversation yet.',
      ctx.recalledEpisodes ? `\nRELEVANT PAST MOMENTS (other sessions):\n${ctx.recalledEpisodes}` : '',
      ctx.dueReviews ? `\nSPACED REVIEWS DUE: ${ctx.dueReviews} — weave one in only if the moment allows AND policy allows a question` : '',
      ctx.reflectionLessons ? `\n${ctx.reflectionLessons}` : '',
      ctx.worldModelInsight ? `\nWORLD MODEL: ${ctx.worldModelInsight}` : '',
      ctx.causalInsight ? `\nROOT-CAUSE ANALYSIS: ${ctx.causalInsight}` : '',
      ctx.subjectContext ? `\n${ctx.subjectContext}` : '',
      ctx.toolContext ? `\nRESOURCES:\n${ctx.toolContext.slice(0, 500)}` : '',
      `\nSTUDENT'S MESSAGE: "${perception.rawMessage.slice(0, 600)}"`,
      `\nRemember: if mustTeachContent is true, your plan MUST deliver real content this turn. If maxQuestionsThisTurn is 0, set askQuestion=false.`,
    ].filter(Boolean).join('\n');

    const response = await routeAndCall([
      { role: 'system', content: instruction },
      { role: 'user', content: situation },
    ], { tier: 'smart', jsonMode: true, maxTokens: 550, temperature: 0.35, studentId: ctx.studentId, purpose: 'deliberation' });

    const parsed = JSON.parse(response.content.replace(/```json|```/g, '').trim());
    const rawPlan = normalizePlan(parsed, fallbackPlan, relationshipStage);
    const constrained = hardEnforce
      ? applyPolicyToPlan(rawPlan, policy)
      : softAdvisePlan(rawPlan, policy);
    constrained.policyMove = policy.move;
    if (hardEnforce) {
      constrained.mustTeachContent = policy.mustTeachContent;
      constrained.maxQuestionsThisTurn = policy.maxQuestionsThisTurn;
    } else {
      constrained.mustTeachContent = constrained.mustTeachContent || policy.mustTeachContent;
      constrained.maxQuestionsThisTurn = policy.maxQuestionsThisTurn;
      if (constrained.askQuestion && policy.maxQuestionsThisTurn === 0) {
        constrained.askQuestion = false;
        constrained.questionPurpose = 'none';
      }
    }
    return constrained;
  } catch (err) {
    logger.warn({ err }, '[Deliberation] Failed — using policy-driven fallback plan');
    return fallbackPlan;
  }
}

/** v3.0: Fetch enabled tools from the dynamic registry. */
async function getEnabledTools(): Promise<{ name: string; description: string }[]> {
  const result = await db.query(
    `SELECT name, description FROM tools WHERE is_enabled = true ORDER BY name`
  );
  return result.rows.map((r: Record<string, unknown>) => ({
    name: r.name as string,
    description: r.description as string,
  }));
}

function buildFallbackPlan(
  ctx: TurnContext,
  relationshipStage: TeachingPlan['relationshipStage'],
  policy: TeachingPolicy
): TeachingPlan {
  const { perception, sessionState } = ctx;
  const es = perception.emotionalSignals;

  let strategy: TeachingPlan['strategy'] = policy.preferredStrategies[0] || 'direct_explanation';
  if (perception.primaryIntent === 'expressing_emotion' || es.shamePotential > 0.6) strategy = 'reassurance';
  else if (perception.primaryIntent === 'casual_chat' || perception.primaryIntent === 'greeting') strategy = 'listen_and_connect';
  else if (sessionState.struggleCount >= 2 || perception.isRepeatedQuestion) strategy = 'pivot_completely';
  else if (policy.mustTeachContent) strategy = policy.preferredStrategies[0] || 'direct_explanation';
  else if (es.flowIndicator > 0.6 && policy.maxQuestionsThisTurn > 0) strategy = 'socratic';
  else if (perception.hasMisconception) strategy = policy.mustTeachContent ? 'direct_explanation' : 'elaborative_interrogation';
  else if (perception.primaryIntent === 'asking_answer') strategy = 'hint_ladder';

  const askQuestion =
    policy.forceAskQuestion === null
      ? false
      : policy.forceAskQuestion;

  return {
    strategy,
    strategyReason: `Fallback + policy:${policy.move}`,
    warmthLevel: policy.warmthLevel,
    challengeLevel: policy.challengeLevel,
    pacing: policy.pacing,
    hintLevel: Math.min(90, sessionState.struggleCount * 25),
    useAnalogy: policy.mustTeachContent && sessionState.struggleCount >= 1,
    analogyDomain: null,
    askQuestion: askQuestion && policy.maxQuestionsThisTurn > 0,
    questionPurpose: askQuestion ? 'guide_thinking' : 'none',
    addressMisconception: perception.hasMisconception,
    misconceptionCorrection: perception.misconceptionDescription,
    connectToMemory: null,
    emotionalApproach: policy.emotionalApproach,
    mustInclude: [...policy.mustInclude],
    mustAvoid: [...policy.mustAvoid, 'giving the final answer'],
    sessionGoal: policy.sessionGoal,
    bloomTarget: policy.bloomTarget,
    relationshipStage,
    needsTools: [],
    expectedOutcome: policy.mustTeachContent
      ? 'Student receives a clear micro-lesson they can stand on'
      : 'Student feels understood and knows the next step',
    policyMove: policy.move,
    mustTeachContent: policy.mustTeachContent,
    maxQuestionsThisTurn: policy.maxQuestionsThisTurn,
  };
}

function normalizePlan(
  parsed: Record<string, unknown>,
  fallback: TeachingPlan,
  relationshipStage: TeachingPlan['relationshipStage']
): TeachingPlan {
  const askQuestion =
    typeof parsed.askQuestion === 'boolean' ? parsed.askQuestion : fallback.askQuestion;

  return {
    strategy: (parsed.strategy as TeachingPlan['strategy']) || fallback.strategy,
    strategyReason: (parsed.strategyReason as string) || fallback.strategyReason,
    warmthLevel: clamp01(parsed.warmthLevel, fallback.warmthLevel),
    challengeLevel: clamp01(parsed.challengeLevel, fallback.challengeLevel),
    pacing: (parsed.pacing as TeachingPlan['pacing']) || fallback.pacing,
    hintLevel: Math.max(0, Math.min(100, typeof parsed.hintLevel === 'number' ? parsed.hintLevel : fallback.hintLevel)),
    useAnalogy: parsed.useAnalogy === true,
    analogyDomain: (parsed.analogyDomain as string) || null,
    askQuestion,
    questionPurpose: (parsed.questionPurpose as TeachingPlan['questionPurpose']) || (askQuestion ? fallback.questionPurpose : 'none'),
    addressMisconception: parsed.addressMisconception === true,
    misconceptionCorrection: (parsed.misconceptionCorrection as string) || null,
    connectToMemory: (parsed.connectToMemory as string) || null,
    emotionalApproach: (parsed.emotionalApproach as string) || fallback.emotionalApproach,
    mustInclude: Array.isArray(parsed.mustInclude) ? (parsed.mustInclude as string[]).slice(0, 6) : fallback.mustInclude,
    mustAvoid: Array.isArray(parsed.mustAvoid) ? (parsed.mustAvoid as string[]).slice(0, 8) : fallback.mustAvoid,
    sessionGoal: (parsed.sessionGoal as string) || fallback.sessionGoal,
    bloomTarget: (parsed.bloomTarget as TeachingPlan['bloomTarget']) || fallback.bloomTarget,
    relationshipStage,
    needsTools: Array.isArray(parsed.needsTools) ? (parsed.needsTools as string[]).slice(0, 3) : [],
    expectedOutcome: (parsed.expectedOutcome as string) || fallback.expectedOutcome,
  };
}

function shouldHardEnforce(
  move: string,
  perception: TurnContext['perception'],
  sessionState: TurnContext['sessionState']
): boolean {
  if (move === 'wrap_and_invite_back' || move === 'reassurance_only') return true;
  if ((sessionState.consecutiveQuestions || 0) >= 2) return true;
  const msg = perception.rawMessage || '';
  if (/\b(i'?m|i am|am)\s+ready\b/i.test(msg)) return true;
  if (/\bi\s+don'?t\s+know\b|\bidk\b/i.test(msg)) return true;
  if (/\bbye\b|\bi'?m\s+busy\b|\bwill\s+come\s+back\b/i.test(msg)) return true;
  if (perception.cognitiveLoad === 'overloaded' || perception.emotionalSignals.shamePotential > 0.75) return true;
  return false;
}

function softAdvisePlan(plan: TeachingPlan, policy: TeachingPolicy): TeachingPlan {
  let strategy = plan.strategy;
  if (policy.bannedStrategies.includes(strategy) && policy.preferredStrategies.length > 0) {
    strategy = policy.preferredStrategies[0];
  }
  return {
    ...plan,
    strategy,
    strategyReason: `${plan.strategyReason} | soft-policy:${policy.move}`,
    mustInclude: uniqueSoft([...policy.mustInclude.slice(0, 2), ...plan.mustInclude]).slice(0, 6),
    mustAvoid: uniqueSoft([...policy.mustAvoid.slice(0, 3), ...plan.mustAvoid]).slice(0, 8),
    warmthLevel: Math.max(plan.warmthLevel, policy.warmthLevel * 0.85),
    maxQuestionsThisTurn: policy.maxQuestionsThisTurn,
    policyMove: policy.move,
  };
}

function uniqueSoft(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
