// Manages the on-premise llama.cpp server connections.
// Falls back to cloud LLMs if local server unavailable.
// The Brain and the Router are two separate models with different speeds.

import axios from 'axios';
import { logger } from '../middleware/logger';

const BRAIN_URL = process.env.LLAMA_BRAIN_URL || 'http://localhost:8080';
const ROUTER_URL = process.env.LLAMA_ROUTER_URL || 'http://localhost:8081';

export interface LocalLLMResponse {
  content: string;
  tokens_evaluated: number;
  tokens_predicted: number;
  latencyMs: number;
}

async function isServerAlive(url: string): Promise<boolean> {
  try {
    await axios.get(`${url}/health`, { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

export async function callBrain(
  prompt: string,
  temperature = 0.3,
  maxTokens = 1024
): Promise<string> {
  const alive = await isServerAlive(BRAIN_URL);

  if (!alive) {
    logger.warn('[LlamaServer] Brain offline — using cloud fallback');
    return callCloudFallback(prompt, 'orchestrator');
  }

  try {
    const start = Date.now();
    const response = await axios.post(
      `${BRAIN_URL}/completion`,
      {
        prompt,
        temperature,
        n_predict: maxTokens,
        stop: ['</s>', '<|end|>', '[INST]'],
      },
      { timeout: 30_000 }
    );

    logger.debug(`[Brain] ${Date.now() - start}ms`);
    return response.data.content || '';
  } catch (err) {
    logger.error('[Brain] Call failed:', err);
    return callCloudFallback(prompt, 'orchestrator');
  }
}

export async function callRouter(
  prompt: string,
  maxTokens = 128
): Promise<string> {
  const alive = await isServerAlive(ROUTER_URL);

  if (!alive) {
    return callCloudFallback(prompt, 'router');
  }

  try {
    const start = Date.now();
    const response = await axios.post(
      `${ROUTER_URL}/completion`,
      {
        prompt,
        temperature: 0.1,
        n_predict: maxTokens,
        stop: ['</s>', '\n\n'],
      },
      { timeout: 5_000 }
    );

    logger.debug(`[Router] ${Date.now() - start}ms`);
    return response.data.content || '';
  } catch {
    return callCloudFallback(prompt, 'router');
  }
}

async function callCloudFallback(prompt: string, role: string): Promise<string> {
  const { routeAndCall } = await import('../llm/router');
  const response = await routeAndCall([
    { role: 'system', content: `You are a ${role} for an AI tutoring system.` },
    { role: 'user', content: prompt },
  ]);
  return response.content;
}

export async function getBrainStatus(): Promise<{
  brainOnline: boolean;
  routerOnline: boolean;
  brainUrl: string;
  routerUrl: string;
}> {
  const [brainOnline, routerOnline] = await Promise.all([
    isServerAlive(BRAIN_URL),
    isServerAlive(ROUTER_URL),
  ]);

  return { brainOnline, routerOnline, brainUrl: BRAIN_URL, routerUrl: ROUTER_URL };
}