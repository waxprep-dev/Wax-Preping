// Groq LLM client — primary provider.
// Free tier: llama-3.3-70b-versatile
// Fast inference, good for tutoring dialogues.

import Groq from "groq-sdk";
import type { LLMMessage, LLMResponse } from "../types/llm";

let groqClient: Groq | null = null;

function getGroqClient(): Groq {
  if (!groqClient) {
    groqClient = new Groq({
      apiKey: process.env.GROQ_API_KEY,
    });
  }
  return groqClient;
}

export async function callGroq(
  messages: LLMMessage[],
  model = "llama-3.3-70b-versatile",
  maxTokens = 1024,
  temperature = 0.7
): Promise<LLMResponse> {
  const client = getGroqClient();
  const startTime = Date.now();

  const response = await client.chat.completions.create({
    model,
    messages: messages.map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    })),
    max_tokens: maxTokens,
    temperature,
  });

  const latencyMs = Date.now() - startTime;
  const content = response.choices[0]?.message?.content ?? "";
  const tokensIn = response.usage?.prompt_tokens ?? 0;
  const tokensOut = response.usage?.completion_tokens ?? 0;

  // Groq free tier: no per-token cost for free models
  const costUsd = 0;

  return {
    content,
    modelUsed: model,
    tokensIn,
    tokensOut,
    costUsd,
    latencyMs,
  };
}