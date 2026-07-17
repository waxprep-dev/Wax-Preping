/**
 * On-premise model bridge (llama.cpp servers) with cloud fallback.
 * v1 logic preserved — it was sound. Health checks are cached for 30s so a
 * busy turn doesn't hammer the local servers with /health probes.
 */
import axios from 'axios';
import { logger } from '../middleware/logger';

const BRAIN_URL = process.env.LLAMA_BRAIN_URL || 'http://localhost:8080';
const ROUTER_URL = process.env.LLAMA_ROUTER_URL || 'http://localhost:8081';

const healthCache = new Map<string, { alive: boolean; checkedAt: number }>();
const HEALTH_TTL_MS = 30_000;

async function isAlive(url: string): Promise<boolean> {
  const cached = healthCache.get(url);
  if (cached && Date.now() - cached.checkedAt < HEALTH_TTL_MS) return cached.alive;

  try {
    await axios.get(`${url}/health`, { timeout: 2000 });
    healthCache.set(url, { alive: true, checkedAt: Date.now() });
    return true;
  } catch {
    healthCache.set(url, { alive: false, checkedAt: Date.now() });
    return false;
  }
}

export async function callBrain(prompt: string, temperature = 0.3, maxTokens = 1024): Promise<string> {
  if (await isAlive(BRAIN_URL)) {
    try {
      const response = await axios.post(
        `${BRAIN_URL}/completion`,
        { prompt, temperature, n_predict: maxTokens, stop: ['</s>', '<|end|>'] },
        { timeout: 30_000 }
      );
      return response.data.content || '';
    } catch {
      logger.warn('[LlamaServer] Brain call failed — cloud fallback');
    }
  }

  const { routeAndCall } = await import('../llm/router');
  const result = await routeAndCall([
    { role: 'system', content: 'You are an autonomous backend agent for an AI tutoring system.' },
    { role: 'user', content: prompt },
  ], { tier: 'deep', maxTokens });
  return result.content;
}

export async function callRouter(prompt: string, maxTokens = 128): Promise<string> {
  if (await isAlive(ROUTER_URL)) {
    try {
      const response = await axios.post(
        `${ROUTER_URL}/completion`,
        { prompt, temperature: 0.1, n_predict: maxTokens, stop: ['</s>', '\n\n'] },
        { timeout: 5_000 }
      );
      return response.data.content || '';
    } catch { /* fall through to cloud */ }
  }

  const { routeAndCall } = await import('../llm/router');
  const result = await routeAndCall([
    { role: 'user', content: prompt },
  ], { tier: 'fast', maxTokens });
  return result.content;
}

export async function getBrainStatus(): Promise<{ brainOnline: boolean; routerOnline: boolean }> {
  const [brainOnline, routerOnline] = await Promise.all([isAlive(BRAIN_URL), isAlive(ROUTER_URL)]);
  return { brainOnline, routerOnline };
}
