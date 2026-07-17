import Groq from 'groq-sdk';
import type { LLMMessage, LLMResponse } from '../types/llm';
import { CircuitBreaker } from './circuit_breaker';

let client: Groq | null = null;
const breaker = new CircuitBreaker('groq', 5, 30_000);

function getClient(): Groq {
  if (!client) client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return client;
}

export async function callGroq(
  messages: LLMMessage[],
  model: string,
  maxTokens = 1024,
  temperature = 0.7,
  jsonMode = false
): Promise<LLMResponse> {
  return breaker.call(async () => {
    const start = Date.now();
    const response = await getClient().chat.completions.create({
      model,
      messages: messages.map(m => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
      })),
      max_tokens: maxTokens,
      temperature,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    });

    return {
      content: response.choices[0]?.message?.content ?? '',
      modelUsed: model,
      provider: 'groq',
      tokensIn: response.usage?.prompt_tokens ?? 0,
      tokensOut: response.usage?.completion_tokens ?? 0,
      costUsd: 0,
      latencyMs: Date.now() - start,
    };
  });
}

export function isGroqAvailable(): boolean {
  return !!process.env.GROQ_API_KEY && breaker.isAvailable();
}
