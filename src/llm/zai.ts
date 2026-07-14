import axios from 'axios';
import type { LLMMessage, LLMResponse } from '../types/llm';
import { CircuitBreaker } from './circuit_breaker';

const breaker = new CircuitBreaker('zai', 3, 20_000);

export async function callZAI(
  messages: LLMMessage[],
  model = 'glm-4.7-flash',
  maxTokens = 1024
): Promise<LLMResponse> {
  return breaker.call(async () => {
    const start = Date.now();

    const response = await axios.post(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      {
        model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        max_tokens: maxTokens,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.ZAI_API_KEY}`,
          'Content-Type': 'application/json',
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

export function isZAIAvailable(): boolean {
  return breaker.isAvailable();
}