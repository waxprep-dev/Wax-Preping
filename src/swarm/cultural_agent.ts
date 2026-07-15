// The Cultural Agent. Specialist in Nigerian context and analogies.
// Invoked when a concept needs grounding in local reality.
// Generates original, situation-specific analogies — never from a template.

import { routeAndCall } from '../llm/router';
import type { LLMMessage } from '../types/llm';

const CULTURAL_SYSTEM = `You are the Cultural Grounding Agent for WaxPrep.

Your specialization: Making abstract concepts concrete through Nigerian daily life.

ANALOGY DOMAINS BY SUBJECT:
Mathematics: market trading, sharing food, measuring farm plots, phone data, keke fares
Physics: NEPA/generators, danfo buses, phone charging, cooking fire, water in buckets, okrika market
Chemistry: cooking reactions, soap making, palm wine, dyeing fabric, rusting metal in humid weather
Biology: cassava farming, goat breeding, malaria mosquitoes, human body analogies, local food chains
Economics: Lagos market, naira exchange rate, fuel scarcity, bread price inflation, artisan pricing
English: how people negotiate at market vs how they write letters, code-switching between English and Pidgin

ANALOGY QUALITY RULES:
1. The analogy must be something the student ACTUALLY experiences, not just something Nigerian in general
2. Use their cultural_context.region if available (Lagos → danfo, Kano → market at dawn, etc.)
3. The analogy must map CORRECTLY — every part of the analogy must correspond to the real concept
4. One analogy per response — do not stack multiple
5. After the analogy, explicitly name the connection: "So in the same way..."

OUTPUT FORMAT:
A single paragraph that introduces the analogy, develops it, and explicitly bridges to the concept.
Maximum 5 sentences. The student should be able to close their eyes and SEE it.`;

export async function runCulturalAgent(
  concept: string,
  subject: string,
  culturalContext: Record<string, unknown>,
  analogyLibrary: { concept: string; analogy: string; effectiveness: number }[],
  previousAnalogyFailed: boolean
): Promise<string> {
  // Check if we have a proven analogy for this concept
  const existingAnalogy = analogyLibrary.find(a =>
    a.concept.toLowerCase() === concept.toLowerCase() && a.effectiveness > 0.7
  );

  const messages: LLMMessage[] = [
    { role: 'system', content: CULTURAL_SYSTEM },
    {
      role: 'system',
      content: `Student cultural context:
Country: ${(culturalContext.country as string) || 'Nigeria'}
Region: ${(culturalContext.region as string) || 'unknown'}
Language: ${(culturalContext.language as string) || 'English'}
Cultural references: ${(culturalContext.culturalReferences as string[])?.join(', ') || 'general Nigerian'}`,
    },
    {
      role: 'user',
      content: `Concept to ground: "${concept}" in ${subject}
${existingAnalogy && !previousAnalogyFailed
  ? `A previous analogy that worked for this student: "${existingAnalogy.analogy}" — you can build on this or go deeper.`
  : previousAnalogyFailed
    ? 'The last analogy used DID NOT WORK. Generate a completely different one from a different domain.'
    : 'No previous analogy recorded. Generate a fresh one.'}

Generate the cultural grounding paragraph now.`,
    },
  ];

  const response = await routeAndCall(messages, { maxTokens: 400 });
  return response.content;
}