import axios from 'axios';
import type { LLMMessage, LLMResponse } from '../types/llm';
import { CircuitBreaker } from './circuit_breaker';

const breaker = new CircuitBreaker('openrouter', 3, 20_000);

export async function callOpenRouter(
  messages: LLMMessage[],
  model = 'meta-llama/llama-3.1-8b-instruct:free',
  maxTokens = 1024
): Promise<LLMResponse> {
  return breaker.call(async () => {
    const start = Date.now();

    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        max_tokens: maxTokens,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://waxprep.app',
          'X-Title': 'WaxPrep',
        },
        timeout: 30_000,
      }
    );

    const latencyMs = Date.now() - start;
    const content = response.data.choices?.[0]?.message?.content ?? '';
    const tokensIn = response.data.usage?.prompt_tokens ?? 0;
    const tokensOut = response.data.usage?.completion_tokens ?? 0;

    return { content, modelUsed: model, tokensIn, tokensOut, costUsd: 0, latencyMs };
  });
}

export function isOpenRouterAvailable(): boolean {
  return breaker.isAvailable();
}