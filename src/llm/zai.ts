import axios from 'axios';
import type { LLMMessage, LLMResponse } from '../types/llm';
import { CircuitBreaker } from './circuit_breaker';

const breaker = new CircuitBreaker('zai', 3, 20_000);

export async function callZAI(
  messages: LLMMessage[],
  model: string,
  maxTokens = 1024,
  temperature = 0.7
): Promise<LLMResponse> {
  return breaker.call(async () => {
    const start = Date.now();
    const response = await axios.post(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      {
        model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        max_tokens: maxTokens,
        temperature,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.ZAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      }
    );

    return {
      content: response.data.choices?.[0]?.message?.content ?? '',
      modelUsed: model,
      provider: 'zai',
      tokensIn: response.data.usage?.prompt_tokens ?? 0,
      tokensOut: response.data.usage?.completion_tokens ?? 0,
      costUsd: 0,
      latencyMs: Date.now() - start,
    };
  });
}

export function isZAIAvailable(): boolean {
  return !!process.env.ZAI_API_KEY && breaker.isAvailable();
}
