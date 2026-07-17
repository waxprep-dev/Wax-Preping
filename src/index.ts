/**
 * WaxPrep v1.0 — main server.
 *
 * Boot order (unchanged from v1, which was correct): HTTP first so the
 * platform healthcheck passes immediately, then DB, event bus, and brain
 * status in the background.
 *
 * New in v2:
 * - /students/:id/memory — inspect the student model (admin).
 * - /students/:id/facts — inspect extracted facts (admin).
 * - Event subscriptions now cover the full event vocabulary.
 */
import 'dotenv/config';
import express from 'express';
import { initializeDatabase } from './db/client';
import { eventBus } from './events/bus';
import { createWebhookRouter } from './whatsapp/webhook';
import { getBrainStatus } from './brain/llama_server';
import { getConstitution, setConstitution } from './config/constitution';
import { logger } from './middleware/logger';
import type { MasteryDetected, DefenseTriggered, EmotionalAlert, PromptEvolved } from './types/events';

async function main(): Promise<void> {
  const app = express();

  // Capture the raw request body so the WhatsApp webhook can verify Meta's
  // X-Hub-Signature-256 HMAC against the exact bytes that were signed.
  app.use(express.json({
    limit: '15mb',
    verify: (req: express.Request, _res: express.Response, buf: Buffer) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }));

  let brainOnline = false;
  let routerOnline = false;

  const port = parseInt(process.env.PORT || '3000', 10);
  app.listen(port, '0.0.0.0', () => {
    logger.info(`[WaxPrep] HTTP server listening on port ${port}`);
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: '1.0.0',
      brain: brainOnline ? 'online' : 'cloud-fallback',
      router: routerOnline ? 'online' : 'cloud-fallback',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/ready', (_req, res) => res.json({ ready: true }));

  logger.info('[WaxPrep] Starting v2.0.0 — Unified Cognitive Architecture');

  try {
    await initializeDatabase();
    logger.info('[WaxPrep] Database initialized (schema v2)');
  } catch (err) {
    logger.error({ err }, '[WaxPrep] Database initialization failed');
  }

  try {
    await eventBus.connect();
  } catch (err) {
    logger.error({ err }, '[WaxPrep] EventBus connection failed');
  }

  getBrainStatus()
    .then((status: { brainOnline: boolean; routerOnline: boolean }) => {
      brainOnline = status.brainOnline;
      routerOnline = status.routerOnline;
      logger.info(`[WaxPrep] Brain (on-prem): ${brainOnline ? 'ONLINE' : 'OFFLINE → cloud'}`);
      logger.info(`[WaxPrep] Router (on-prem): ${routerOnline ? 'ONLINE' : 'OFFLINE → cloud'}`);
    })
    .catch((err: unknown) => {
      logger.warn({ err }, '[WaxPrep] Brain status check failed — using cloud fallback');
    });

  try {
    const constitution = await getConstitution();
    logger.info(`[WaxPrep] Constitution loaded: ${constitution.split('\n')[0]}`);
  } catch (err) {
    logger.warn({ err }, '[WaxPrep] Could not load constitution');
  }

  // ── Event observability ─────────────────────────────────────────────────
  eventBus.subscribe<MasteryDetected>('mastery.detected', async event => {
    logger.info(`[Event] MASTERY: ${event.studentId} → "${event.concept}" (${event.masteryLevel.toFixed(2)})`);
  });

  eventBus.subscribe<DefenseTriggered>('defense.triggered', async event => {
    if (event.severity === 'critical') logger.warn(`[Event] DEFENSE CRITICAL: ${event.layer}: ${event.issue}`);
  });

  eventBus.subscribe<EmotionalAlert>('emotional.alert', async event => {
    if (event.urgency === 'immediate') {
      logger.warn(`[Event] EMOTIONAL ALERT: ${event.studentId} — ${event.emotion} (${event.confidence.toFixed(2)})`);
    }
  });

  eventBus.subscribe<PromptEvolved>('prompt.evolved', async event => {
    logger.info(`[Event] PROMPT EVOLVED: ${event.componentId} ${event.oldFitness.toFixed(3)} → ${event.newFitness.toFixed(3)}`);
  });

  // ── Admin API ───────────────────────────────────────────────────────────
  const adminOnly = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = (req.headers['x-admin-key'] || req.body?.adminKey || req.query.adminKey) as string;
    if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    next();
  };

  app.get('/constitution', async (_req, res) => {
    try {
      const c = await getConstitution();
      res.json({ constitution: c });
    } catch {
      res.status(500).json({ error: 'Constitution unavailable' });
    }
  });

  app.post('/constitution', adminOnly, async (req, res) => {
    const { content } = req.body as { content: string };
    if (!content || content.length < 50) return res.status(400).json({ error: 'content required' });
    try {
      await setConstitution(content);
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'Failed to update constitution' });
    }
  });

  app.get('/students/:studentId/memory', adminOnly, async (req, res) => {
    try {
      const { getStudentProfile } = await import('./memory/semantic');
      const profile = await getStudentProfile(req.params.studentId);
      res.json({
        memoryBlocks: profile.memoryBlocks,
        conceptProgress: profile.conceptProgress,
        errorDiary: profile.errorDiary,
        analogyLibrary: profile.analogyLibrary,
        studyStreak: profile.studyStreak,
        totalTurns: profile.totalTurns,
      });
    } catch {
      res.status(500).json({ error: 'Memory unavailable' });
    }
  });

  app.get('/students/:studentId/facts', adminOnly, async (req, res) => {
    try {
      const { db } = await import('./db/client');
      const result = await db.query(`SELECT * FROM student_facts WHERE student_id = $1 ORDER BY confidence DESC`, [req.params.studentId]);
      res.json({ facts: result.rows });
    } catch {
      res.status(500).json({ error: 'Facts unavailable' });
    }
  });

  app.get('/metrics', async (_req, res) => {
    try {
      const { db } = await import('./db/client');
      const [students, sessions, turns, notifs, defenses, reflections, cost] = await Promise.all([
        db.query('SELECT COUNT(*) FROM student_profiles'),
        db.query(`SELECT COUNT(*) FROM sessions WHERE started_at > NOW() - INTERVAL '24 hours'`),
        db.query(`SELECT COUNT(*) FROM conversation_turns WHERE timestamp > NOW() - INTERVAL '24 hours'`),
        db.query(`SELECT COUNT(*) FROM notification_queue WHERE sent = TRUE AND sent_at > NOW() - INTERVAL '24 hours'`),
        db.query(`SELECT COUNT(*) FROM defense_log WHERE timestamp > NOW() - INTERVAL '24 hours'`),
        db.query(`SELECT AVG(confidence_score) FROM ai_reflections WHERE timestamp > NOW() - INTERVAL '24 hours'`),
        db.query(`SELECT COALESCE(SUM(cost_usd),0) as total, COALESCE(SUM(tokens_in),0) as tin, COALESCE(SUM(tokens_out),0) as tout FROM cost_tracking WHERE timestamp > NOW() - INTERVAL '24 hours'`),
      ]);

      res.json({
        version: '1.0.0',
        totalStudents: parseInt(students.rows[0].count),
        sessionsLast24h: parseInt(sessions.rows[0].count),
        turnsLast24h: parseInt(turns.rows[0].count),
        notificationsSentLast24h: parseInt(notifs.rows[0].count),
        defenseTriggers24h: parseInt(defenses.rows[0].count),
        avgReflectionConfidence: parseFloat(reflections.rows[0].avg || '0').toFixed(3),
        cost24hUsd: parseFloat(cost.rows[0].total).toFixed(4),
        tokens24h: { in: parseInt(cost.rows[0].tin), out: parseInt(cost.rows[0].tout) },
        brainOnline,
      });
    } catch {
      res.status(500).json({ error: 'Metrics unavailable' });
    }
  });

  app.get('/world-model/:studentId', adminOnly, async (req, res) => {
    try {
      const { getWorldModelState } = await import('./world_model/predictive_model');
      const state = await getWorldModelState(req.params.studentId);
      if (!state) return res.status(404).json({ error: 'No world model yet for this student' });
      res.json(state);
    } catch {
      res.status(500).json({ error: 'World model unavailable' });
    }
  });

  app.use('/', createWebhookRouter());

  logger.info('[WaxPrep] Pipeline: Perceive → Deliberate → Generate → Defend → Learn');
  logger.info('[WaxPrep] Memory: working + episodic (recall wired) + semantic + student model');
  logger.info('[WaxPrep] Backend brain, world model, evolution — all autonomous');
}

main().catch(err => {
  logger.fatal({ err }, '[WaxPrep] Fatal startup error');
  process.exit(1);
});
