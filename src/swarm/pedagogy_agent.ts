// The Pedagogy Agent. Specialist in teaching strategy.
// Receives emotional framing from the Emotional Agent.
// Selects and executes the optimal teaching approach.

import { routeAndCall } from '../llm/router';
import type { LLMMessage } from '../types/llm';

const PEDAGOGY_SYSTEM = `You are the Pedagogy Agent for WaxPrep.

Your specialization: Selecting and executing the optimal teaching strategy for each moment.

STRATEGIES YOU CAN USE:
1. SOCRATIC — Only ask questions. Never state facts. Guide discovery.
2. DIRECT EXPLANATION — State the concept clearly, then show why it works.
3. ANALOGY BRIDGE — Find a bridge from something they know to something they don't.
4. SCAFFOLDED STEPS — Break it down. One micro-step at a time. Confirm each before advancing.
5. METACOGNITIVE — Ask them to explain their own thinking. "Walk me through how you got that."
6. CELEBRATORY — They got it. Deepen it. Ask them to extend it to a new situation.
7. PREREQUISITE FIRST — Stop. Address the missing foundation before touching the target concept.
8. PIVOT COMPLETELY — They've been stuck too long with this approach. Start fresh with a completely different entry point.
9. HINT LADDER — 10% hint → 30% → 50% → 70% → 90%. Never give 100%.
10. TEACH-BACK — Ask them to explain it to you. Play dumb. Let them teach.

NEVER:
- Give the final answer to a practice problem
- Use the same approach that already failed (check stuck history)
- Teach more than one concept per response
- Give a response longer than is necessary`;

export async function runPedagogyAgent(
  studentMessage: string,
  emotionalFraming: string,
  strategy: string,
  subjectContext: string,
  workingMemory: Record<string, unknown>,
  hintLevel: number,
  approachesAlreadyTried: string[],
  worldModelInsight: string
): Promise<string> {
  const messages: LLMMessage[] = [
    { role: 'system', content: PEDAGOGY_SYSTEM },
    {
      role: 'system',
      content: `EMOTIONAL FRAMING FROM EMOTIONAL AGENT:\n${emotionalFraming}`,
    },
    {
      role: 'system',
      content: `SUBJECT CONTEXT:\n${subjectContext}`,
    },
    {
      role: 'system',
      content: `APPROACHES ALREADY TRIED (DO NOT REPEAT): ${approachesAlreadyTried.join(', ') || 'none'}
CURRENT HINT LEVEL: ${hintLevel}% (if above 0%, you are on a hint ladder)
WORLD MODEL INSIGHT: ${worldModelInsight || 'none'}
CURRENT TOPIC: ${(workingMemory.currentTopic as string) || 'undetermined'}
STUCK COUNT: ${(workingMemory.stuckRepetitionCount as number) || 0}`,
    },
    {
      role: 'user',
      content: `Student message: "${studentMessage}"
Recommended strategy: ${strategy}
Generate the pedagogical response body. The Emotional Agent's framing must be woven into this.
Do NOT write a separate emotional section — blend it naturally.`,
    },
  ];

  const response = await routeAndCall(messages, { maxTokens: 1200 });
  return response.content;
}