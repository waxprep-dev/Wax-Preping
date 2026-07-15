import 'dotenv/config';
import express from 'express';
import { initializeDatabase } from './db/client';
import { eventBus } from './events/bus';
import { createWebhookRouter } from './whatsapp/webhook';
import { logger } from './middleware/logger';
import type { MasteryDetected, DefenseTriggered } from './types/events';

async function main(): Promise<void> {
  logger.info('[WaxPrep] Starting v1.0.0 — AI-Native Architecture');

  await initializeDatabase();
  await eventBus.connect();

  // Subscribe to system events
  eventBus.subscribe<MasteryDetected>('mastery.detected', async (event) => {
    logger.info(`[Event] Mastery: ${event.studentId} mastered "${event.concept}" via ${event.evidenceType}`);
  });

  eventBus.subscribe<DefenseTriggered>('defense.triggered', async (event) => {
    if (event.severity === 'critical') {
      logger.warn(`[Event] Defense CRITICAL: ${event.studentId} — ${event.layer}: ${event.issue}`);
    }
  });

  const app = express();
  app.use(express.json({ limit: '15mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '1.0.0', architecture: 'ai-native', timestamp: new Date().toISOString() });
  });

  app.get('/ready', (_req, res) => res.json({ ready: true }));

  app.get('/metrics', async (_req, res) => {
    try {
      const { db } = await import('./db/client');
      const [students, sessions, turns, costs, defenses, reflections] = await Promise.all([
        db.query('SELECT COUNT(*) FROM student_profiles'),
        db.query('SELECT COUNT(*) FROM sessions WHERE started_at > NOW() - INTERVAL \'24 hours\''),
        db.query('SELECT COUNT(*) FROM conversation_turns WHERE timestamp > NOW() - INTERVAL \'24 hours\''),
        db.query('SELECT COALESCE(SUM(cost_usd), 0) FROM cost_tracking WHERE timestamp > NOW() - INTERVAL \'24 hours\''),
        db.query('SELECT COUNT(*) FROM defense_log WHERE timestamp > NOW() - INTERVAL \'24 hours\''),
        db.query('SELECT AVG(confidence_score) FROM ai_reflections WHERE timestamp > NOW() - INTERVAL \'24 hours\''),
      ]);

      res.json({
        totalStudents: parseInt(students.rows[0].count),
        sessionsLast24h: parseInt(sessions.rows[0].count),
        turnsLast24h: parseInt(turns.rows[0].count),
        costLast24hUsd: parseFloat(costs.rows[0].coalesce || '0').toFixed(4),
        defenseTriggersLast24h: parseInt(defenses.rows[0].count),
        avgReflectionConfidenceLast24h: parseFloat(reflections.rows[0].avg || '0').toFixed(3),
        version: '1.0.0',
      });
    } catch (err) {
      res.status(500).json({ error: 'Metrics unavailable' });
    }
  });

  app.use('/', createWebhookRouter());

  const port = parseInt(process.env.PORT || '3000', 10);
  app.listen(port, '0.0.0.0', () => {
    logger.info(`[WaxPrep] Running on port ${port}`);
    logger.info(`[WaxPrep] Version: 1.0.0 — AI is the orchestrator`);
    logger.info(`[WaxPrep] Defense layers: 5 active`);
    logger.info(`[WaxPrep] Reflection engine: active`);
    logger.info(`[WaxPrep] Prompt evolution: scheduled weekly`);
  });
}

main().catch(err => {
  logger.error('[WaxPrep] Fatal startup error:', err);
  process.exit(1);
});