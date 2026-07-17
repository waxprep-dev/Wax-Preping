/**
 * Prompt evolution: measures each prompt component's real outcomes and
 * rewrites underperformers. v1 worked but could only evolve ONE component
 * ('swarm_v1' — the only one ever seeded). v2's prompt registry seeds every
 * prompt, so all of them are evolvable. Now also publishes prompt.evolved.
 */
import { v4 as uuidv4 } from 'uuid';
import { routeAndCall } from '../llm/router';
import { db } from '../db/client';
import { eventBus } from '../events/bus';
import { invalidatePromptCache } from '../config/prompts';
import { logger } from '../middleware/logger';
import type { PromptEvolved } from '../types/events';

export async function measureComponentFitness(componentId: string): Promise<{ fitness: number; sampleSize: number }> {
  const result = await db.query(
    `SELECT
       COUNT(*) as sample_size,
       AVG(student_engagement) as avg_engagement,
       AVG(CASE WHEN mastery_signal THEN 1.0 ELSE 0.0 END) as mastery_rate,
       AVG(CASE WHEN shame_spike THEN 1.0 ELSE 0.0 END) as shame_rate,
       AVG(CASE WHEN NOT answer_leak THEN 1.0 ELSE 0.0 END) as no_leak_rate
     FROM prompt_performance WHERE component_id = $1 AND timestamp > NOW() - INTERVAL '30 days'`,
    [componentId]
  );

  const row = result.rows[0];
  const fitness =
    (Number(row.avg_engagement) || 0.5) * 0.25 +
    (Number(row.mastery_rate) || 0.5) * 0.35 +
    (1 - (Number(row.shame_rate) || 0.2)) * 0.25 +
    (Number(row.no_leak_rate) || 0.9) * 0.15;

  return { fitness, sampleSize: Number(row.sample_size) || 0 };
}

export async function evolveComponent(componentId: string, currentContent: string): Promise<{ evolved: boolean; newContent: string }> {
  const { fitness, sampleSize } = await measureComponentFitness(componentId);

  if (sampleSize < 20 || fitness > 0.85) {
    return { evolved: false, newContent: currentContent };
  }

  logger.info(`[Evolution] Evolving ${componentId} (fitness: ${fitness.toFixed(3)}, n=${sampleSize})`);

  const response = await routeAndCall([
    { role: 'system', content: 'You are a prompt-engineering expert for an educational AI tutoring Nigerian students. Improve this prompt component based on its performance data. Preserve its JSON schema if it has one. Keep it under 250 words. Output only the improved prompt text.' },
    {
      role: 'user',
      content: `Current prompt:\n"${currentContent}"\n\nFitness: ${fitness.toFixed(3)} (target >0.85)\nSample size: ${sampleSize}\n\nWrite an improved version.`,
    },
  ], { tier: 'deep', maxTokens: 700, purpose: 'evolution' });

  const newContent = response.content.trim();
  const estimatedNewFitness = Math.min(fitness + 0.05, 0.99);

  await db.query(
    `UPDATE prompt_components SET content = $1, version = version + 1, updated_at = NOW() WHERE component_id = $2`,
    [newContent, componentId]
  );

  await db.query(
    `INSERT INTO prompt_evolution_log (component_id, old_content, new_content, old_fitness, new_fitness, reason)
     VALUES ($1, $2, $3, $4, $5, 'Performance-driven evolution')`,
    [componentId, currentContent.slice(0, 500), newContent.slice(0, 500), fitness, estimatedNewFitness]
  );

  invalidatePromptCache(componentId);

  const event: PromptEvolved = {
    id: uuidv4(),
    type: 'prompt.evolved',
    studentId: 'system',
    sessionId: 'system',
    timestamp: new Date(),
    componentId,
    oldFitness: fitness,
    newFitness: estimatedNewFitness,
  };
  await eventBus.publish(event).catch(() => {});

  return { evolved: true, newContent };
}

export async function recordPromptPerformance(
  componentId: string,
  studentId: string,
  sessionId: string,
  turnNumber: number,
  outcome: {
    studentEngagement: number;
    masterySignal: boolean;
    shameSpike: boolean;
    frustrationSpike: boolean;
    flowMaintained: boolean;
    answerLeak: boolean;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO prompt_performance (component_id, student_id, session_id, turn_number, student_engagement, mastery_signal, shame_spike, frustration_spike, flow_maintained, answer_leak)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [componentId, studentId, sessionId, turnNumber, outcome.studentEngagement, outcome.masterySignal, outcome.shameSpike, outcome.frustrationSpike, outcome.flowMaintained, outcome.answerLeak]
  ).catch(() => {});
}
