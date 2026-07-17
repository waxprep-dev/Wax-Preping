/**
 * LLM abstraction types.
 *
 * v2.0 changes:
 * - Added TaskTier: every LLM call declares how much reasoning power it needs,
 *   and the router maps tiers to concrete models per provider. Replaces v1's
 *   single hardcoded model per provider.
 * - Removed the dead WaxData interface (defined in v1, referenced nowhere; its
 *   intended role is now filled by TeachingPlan in types/teaching.ts).
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  modelUsed: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
}

/**
 * fast  — classification, extraction, perception fusion. Small models, low latency.
 * smart — deliberation and student-facing generation. Best available quality.
 * deep  — background reasoning (reflection, world model, autonomous brain).
 */
export type TaskTier = 'fast' | 'smart' | 'deep';

export interface UsageSummary {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  models: string[];
}
