/**
 * Generation — the teacher's voice.
 *
 * Takes the TeachingPlan and the full turn context and writes the actual
 * WhatsApp message. One smart-tier call. The plan is rendered as compact
 * instructions; the generation prompt (DB-evolvable) governs voice.
 *
 * v3.1: Activation-ranked memories, predictive pre-load, palace path, and
 * boundary signals flow through dedicated cognitive context fields.
 */
import { routeAndCall } from '../llm/router';
import { getPrompt } from '../config/prompts';
import type { TeachingPlan, TurnContext } from '../types/teaching';
import type { LLMResponse } from '../types/llm';

export async function generate(ctx: TurnContext, plan: TeachingPlan): Promise<LLMResponse> {
  const voicePrompt = await getPrompt('generation.v2');

  const askLine = plan.askQuestion
    ? `- end with AT MOST one question whose purpose is: ${plan.questionPurpose.replace(/_/g, ' ')}. Never stack questions.`
    : `- DO NOT end with a question. DO NOT ask anything this turn. Close with a clear statement or a soft invitation like "when you're ready, reply and we'll continue" WITHOUT a ?`;

  const teachLine = plan.mustTeachContent
    ? `- MUST TEACH real content this turn: one micro-concept, definition, or worked micro-example. Do not only chat or only ask.`
    : `- Teaching content is optional this turn — relationship/safety may come first.`;

  const planBrief = [
    `TEACHING PLAN (follow faithfully, never mention it):`,
    `- policy move: ${plan.policyMove || 'n/a'}`,
    `- strategy: ${plan.strategy} (${plan.strategyReason})`,
    `- tone: warmth ${f2(plan.warmthLevel)}, challenge ${f2(plan.challengeLevel)}, pacing ${plan.pacing}. ${plan.emotionalApproach}`,
    plan.hintLevel > 0 ? `- hint level: ${plan.hintLevel}% (100 = everything except the last step)` : '',
    plan.useAnalogy
      ? `- use ONE analogy${plan.analogyDomain ? ` from: ${plan.analogyDomain}` : ''}; map it cleanly — do NOT force the phrase "So in the same way" every turn`
      : '- no forced analogy this turn',
    askLine,
    teachLine,
    plan.addressMisconception && plan.misconceptionCorrection
      ? `- gently correct this misconception: ${plan.misconceptionCorrection}`
      : '',
    plan.connectToMemory ? `- weave in naturally: ${plan.connectToMemory}` : '',
    plan.mustInclude.length > 0 ? `- MUST include: ${plan.mustInclude.join('; ')}` : '',
    plan.mustAvoid.length > 0 ? `- MUST avoid: ${plan.mustAvoid.join('; ')}` : '',
    `- goal of this turn: ${plan.sessionGoal}`,
  ]
    .filter(Boolean)
    .join('\n');

  const knownFacts = Object.entries(ctx.profile.facts || {})
    .slice(0, 12)
    .map(([k, v]) => `${k}=${v.factValue}`)
    .join('; ');

  const boundaryLine =
    ctx.boundaryDecision?.is_boundary
      ? `Session boundary detected (${ctx.boundaryDecision.boundary_type}, p=${ctx.boundaryDecision.boundary_probability.toFixed(2)}). Re-establish pedagogical context gently; do not assume prior thread continuity.`
      : '';

  const situation = [
    planBrief,
    '',
    knownFacts ? `Known facts about this student (use them — do not re-ask): ${knownFacts}` : '',
    ctx.cognitiveMemoryContext
      ? `COGNITIVE MEMORY (activation-ranked + predictive):\n${ctx.cognitiveMemoryContext.slice(0, 1800)}`
      : ctx.recalledEpisodes
        ? `Past moments you may reference:\n${ctx.recalledEpisodes}`
        : '',
    ctx.palacePathHint ? `Memory palace path: ${ctx.palacePathHint}` : '',
    boundaryLine,
    ctx.toolContext ? `Resources available:\n${ctx.toolContext.slice(0, 600)}` : '',
    ctx.subjectContext ? `STUDENT CONTEXT:\n${ctx.subjectContext}` : '',
    ctx.dueReviews ? `Due for spaced review: ${ctx.dueReviews}` : '',
    `Recent conversation:\n${ctx.conversationHistory.slice(-1200) || 'This is the start of your relationship.'}`,
    '',
    `STUDENT'S MESSAGE: "${ctx.perception.rawMessage.slice(0, 800)}"`,
    '',
    plan.askQuestion
      ? 'Write your reply now — only the message text. At most one question at the end.'
      : 'Write your reply now — only the message text. ZERO questions. Teach or close warmly.',
  ]
    .filter(Boolean)
    .join('\n');

  const response = await routeAndCall(
    [
      { role: 'system', content: voicePrompt },
      { role: 'user', content: situation },
    ],
    {
      tier: 'smart',
      maxTokens: 900,
      temperature: 0.7,
      studentId: ctx.studentId,
      purpose: 'generation',
    }
  );

  if (!plan.askQuestion) {
    response.content = stripTrailingQuestions(response.content);
  } else {
    response.content = collapseToSingleTrailingQuestion(response.content);
  }

  response.content = stripRoboticOpeners(response.content);

  return response;
}

function f2(n: number): string {
  return n.toFixed(2);
}

export function stripTrailingQuestions(text: string): string {
  if (!text) return text;
  let out = text.trim();
  const parts = out.split(/(?<=[.!])\s+|\n+/).filter(Boolean);
  while (parts.length > 1) {
    const last = parts[parts.length - 1].trim();
    if (
      /\?$/.test(last) ||
      /^(what|why|how|when|where|which|who|do you|did you|can you|could you|would you|are you)\b/i.test(
        last
      )
    ) {
      parts.pop();
      continue;
    }
    break;
  }
  out = parts.join(' ').trim();
  if (/\?$/.test(out) && out.split('?').length <= 2) {
    out = out.replace(/\?+\s*$/, '.').trim();
  }
  if (out.length < 20) {
    return text.replace(/\?/g, '.').trim();
  }
  return out;
}

export function collapseToSingleTrailingQuestion(text: string): string {
  if (!text) return text;
  const marks = (text.match(/\?/g) || []).length;
  if (marks <= 1) return text.trim();
  const lastIdx = text.lastIndexOf('?');
  const head = text.slice(0, lastIdx).replace(/\?/g, '.');
  const tail = text.slice(lastIdx);
  return (head + tail).replace(/\.\s*\./g, '.').trim();
}

const ROBOTIC_OPENERS = [
  /^welcome to our tutoring sessions?[!.]?\s*/i,
  /^i'?m super excited to have you on board[!.]?\s*/i,
  /^certainly[!.,]?\s*/i,
  /^of course[!.,]?\s*/i,
  /^great question[!.,]?\s*/i,
  /^absolutely[!.,]?\s*/i,
  /^as an ai[, ]+/i,
  /^i'?d be happy to help[!.,]?\s*/i,
  /^let me explain[!.,]?\s*/i,
];

export function stripRoboticOpeners(text: string): string {
  let out = text.trim();
  for (const re of ROBOTIC_OPENERS) {
    out = out.replace(re, '');
  }
  if (out && out[0] === out[0].toLowerCase()) {
    out = out[0].toUpperCase() + out.slice(1);
  }
  return out.trim();
}
