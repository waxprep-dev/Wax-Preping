/**
 * Generation — the teacher's voice.
 *
 * Takes the TeachingPlan and the full turn context and writes the actual
 * WhatsApp message. One smart-tier call. The plan is rendered as compact
 * instructions; the generation prompt (DB-evolvable) governs voice.
 */
import { routeAndCall } from '../llm/router';
import { getPrompt } from '../config/prompts';
import type { TeachingPlan, TurnContext } from '../types/teaching';
import type { LLMResponse } from '../types/llm';

export async function generate(ctx: TurnContext, plan: TeachingPlan): Promise<LLMResponse> {
  const voicePrompt = await getPrompt('generation.v1');

  const planBrief = [
    `TEACHING PLAN (follow faithfully, never mention it):`,
    `- strategy: ${plan.strategy} (${plan.strategyReason})`,
    `- tone: warmth ${f2(plan.warmthLevel)}, challenge ${f2(plan.challengeLevel)}, pacing ${plan.pacing}. ${plan.emotionalApproach}`,
    plan.hintLevel > 0 ? `- hint level: ${plan.hintLevel}% (100 = everything except the last step)` : '',
    plan.useAnalogy ? `- use ONE analogy${plan.analogyDomain ? ` from: ${plan.analogyDomain}` : ''}; name the bridge explicitly` : '- no analogy this turn',
    plan.askQuestion ? `- end with exactly one question whose purpose is: ${plan.questionPurpose.replace(/_/g, ' ')}` : '- do not end with a question this turn',
    plan.addressMisconception && plan.misconceptionCorrection ? `- gently correct this misconception: ${plan.misconceptionCorrection}` : '',
    plan.connectToMemory ? `- weave in naturally: ${plan.connectToMemory}` : '',
    plan.mustInclude.length > 0 ? `- MUST include: ${plan.mustInclude.join('; ')}` : '',
    plan.mustAvoid.length > 0 ? `- MUST avoid: ${plan.mustAvoid.join('; ')}` : '',
    `- goal of this turn: ${plan.sessionGoal}`,
  ].filter(Boolean).join('\n');

  const situation = [
    planBrief,
    '',
    ctx.recalledEpisodes ? `Past moments you may reference:\n${ctx.recalledEpisodes}` : '',
    ctx.toolContext ? `Resources available:\n${ctx.toolContext.slice(0, 600)}` : '',
    `Recent conversation:\n${ctx.conversationHistory.slice(-1200) || 'This is the start of your relationship.'}`,
    '',
    `STUDENT'S MESSAGE: "${ctx.perception.rawMessage.slice(0, 800)}"`,
    '',
    'Write your reply now — only the message text, nothing else.',
  ].filter(Boolean).join('\n');

  return routeAndCall([
    { role: 'system', content: voicePrompt },
    { role: 'user', content: situation },
  ], { tier: 'smart', maxTokens: 900, temperature: 0.75, studentId: ctx.studentId, purpose: 'generation' });
}

function f2(n: number): string {
  return n.toFixed(2);
}
