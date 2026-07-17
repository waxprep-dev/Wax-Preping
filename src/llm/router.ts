/**
 * Tiered LLM router with circuit breaking, fallback chains, cost estimation
 * and usage accounting.
 *
 * v1 problems fixed here:
 * - One hardcoded model per provider for every task (a 70B model answered
 *   trivial classification calls; perception and routing burned the same
 *   budget as generation). Now: fast/smart/deep tiers map to per-provider
 *   models, overridable by env.
 * - v1 never recorded tokens or cost anywhere (cost_tracking table existed
 *   but nothing wrote to it; turns saved tokensIn=0). The router now returns
 *   real usage and recordUsage() persists it.
 * - isXAvailable() in v1 ignored missing API keys, so providers without keys
 *   were "available" until they failed. Now keys are checked up front.
 */
import { callGroq, isGroqAvailable } from './groq';
import { callOpenRouter, isOpenRouterAvailable } from './openrouter';
import { callZAI, isZAIAvailable } from './zai';
import { db } from '../db/client';
import { logger } from '../middleware/logger';
import type { LLMMessage, LLMResponse, TaskTier } from '../types/llm';

export interface RouteOptions {
  tier?: TaskTier;
  jsonMode?: boolean;
  maxTokens?: number;
  temperature?: number;
  studentId?: string;
  purpose?: string;
}

/** Tier -> per-provider model. Every value can be overridden via env vars. */
const TIER_MODELS: Record<TaskTier, { groq: string; openrouter: string; zai: string }> = {
  fast: {
    groq: process.env.MODEL_FAST_GROQ || 'llama-3.1-8b-instant',
    openrouter: process.env.MODEL_FAST_OPENROUTER || 'meta-llama/llama-3.1-8b-instruct:free',
    zai: process.env.MODEL_FAST_ZAI || 'glm-4-flash',
  },
  smart: {
    groq: process.env.MODEL_SMART_GROQ || 'llama-3.3-70b-versatile',
    openrouter: process.env.MODEL_SMART_OPENROUTER || 'meta-llama/llama-3.3-70b-instruct:free',
    zai: process.env.MODEL_SMART_ZAI || 'glm-4-flash',
  },
  deep: {
    groq: process.env.MODEL_DEEP_GROQ || 'llama-3.3-70b-versatile',
    openrouter: process.env.MODEL_DEEP_OPENROUTER || 'meta-llama/llama-3.3-70b-instruct:free',
    zai: process.env.MODEL_DEEP_ZAI || 'glm-4-flash',
  },
};

/** Rough USD per 1M tokens [input, output]. Free tiers are 0. Override via env if you pay. */
const MODEL_RATES: Record<string, [number, number]> = {
  'llama-3.1-8b-instant': [0.05, 0.08],
  'llama-3.3-70b-versatile': [0.59, 0.79],
  'glm-4-flash': [0, 0],
};

function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const rate = MODEL_RATES[model];
  if (!rate) return 0;
  return (tokensIn / 1_000_000) * rate[0] + (tokensOut / 1_000_000) * rate[1];
}

export async function routeAndCall(
  messages: LLMMessage[],
  options: RouteOptions = {}
): Promise<LLMResponse> {
  const { tier = 'smart', jsonMode = false, maxTokens = 1024, temperature = 0.7, studentId, purpose } = options;
  const models = TIER_MODELS[tier];

  const providers = [
    {
      name: 'groq',
      available: isGroqAvailable,
      call: () => callGroq(messages, models.groq, maxTokens, temperature, jsonMode),
    },
    {
      name: 'openrouter',
      available: isOpenRouterAvailable,
      call: () => callOpenRouter(messages, models.openrouter, maxTokens, temperature),
    },
    {
      name: 'zai',
      available: isZAIAvailable,
      call: () => callZAI(messages, models.zai, maxTokens, temperature),
    },
  ];

  let lastError: Error | null = null;

  for (const provider of providers) {
    if (!provider.available()) {
      logger.debug(`[LLMRouter] ${provider.name} unavailable — skipping`);
      continue;
    }

    try {
      const result = await provider.call();
      result.costUsd = estimateCost(result.modelUsed, result.tokensIn, result.tokensOut);
      if (studentId) {
        await recordUsage(studentId, result, purpose || tier).catch(() => {});
      }
      return result;
    } catch (err) {
      lastError = err as Error;
      const e = err as { status?: number };
      logger.warn(`[LLMRouter] ${provider.name} failed (${e?.status || 'unknown'}) — trying next`);
      if (e?.status === 429) await new Promise(r => setTimeout(r, 2000));
    }
  }

  throw lastError || new Error('All LLM providers exhausted');
}

async function recordUsage(studentId: string, response: LLMResponse, purpose: string): Promise<void> {
  await db.query(
    `INSERT INTO cost_tracking (student_id, model, tokens_in, tokens_out, cost_usd, purpose)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [studentId, response.modelUsed, response.tokensIn, response.tokensOut, response.costUsd, purpose]
  );
}
