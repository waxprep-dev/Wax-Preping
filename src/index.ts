/**
 * WaxPrep v3.0 — AI Tutor Backend.
 *
 * Entry point. Initializes the database, starts the Express server,
 * wires up the WhatsApp webhook, and registers admin routes for the
 * new cognitive architecture (attributes, archetypes, syllabus, tools).
 */
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { initializeDatabase } from './db/client';
import { createWebhookRouter } from './whatsapp/webhook';
import { logger } from './middleware/logger';
import { db } from './db/client';
import { searchSyllabus, getAvailableSubjects, getTopicsForSubject } from './syllabus/store';
import { ingestSyllabusDirectory } from './syllabus/ingest';
import { autoIngestSyllabus, ingestFromUrl, ensureIngestSchema } from './syllabus/auto_ingest';
import { getActiveAttributes } from './student_profile/attribute_pipeline';
import { matchArchetypes, warmStartFromArchetype } from './student_profile/archetypes';
import { getOnboardingState } from './onboarding/engine';
import { executeToolByName } from './tools/implementations';
import { getGraphAdapter } from './graph/factory';
import { migrateExistingDataToGraph } from './graph/migration';
import { getCognitiveConfig, setCognitiveConfig, getSegmentationConfig, updateSegmentationWeights, getForgettingParams, updateForgettingParams } from './config/cognitive';
import { evaluateSessionBoundary, getRecentBoundaries, provideBoundaryFeedback } from './cognitive/segmentation';
import { retrieveMemories } from './forgetting/engine';
import { predictivePreLoad, checkPreloadCache } from './predictive/engine';
import { ensurePalace, discoverTunnels } from './palace/organizer';
import { getPalaceHierarchy, getPalaceStats } from './palace/hierarchy';
import { runSleepMode } from './sleep/pipeline';
import { startSleepScheduler, runTimezoneAwareTick, previewSleepCandidates, runNightlyConsolidation } from './sleep/scheduler';
import { checkRateLimit } from './middleware/rate_limiter';

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Admin authentication middleware.
 * Requires X-Admin-Key header or admin_key query param matching ADMIN_KEY env var.
 */
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-admin-key'] || req.query.admin_key;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

/**
 * Admin rate limiting middleware.
 * Limits admin routes to 100 requests per 15 minutes per IP.
 */
function requireAdminRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  checkRateLimit(`admin:${ip}`, 100, 900)
    .then(result => {
      if (!result.allowed) {
        res.status(429).json({ error: 'Too many requests. Try again later.' });
        return;
      }
      next();
    })
    .catch(() => next()); // If rate limiter fails, allow through
}

// Capture raw body for Meta signature verification
app.use(express.json({
  verify: (req: Request, _res: Response, buf: Buffer) => {
    (req as Request & { rawBody?: Buffer }).rawBody = buf;
  },
}));

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', version: '3.0.0-cognitive' });
});

// ── Admin Routes ─────────────────────────────────────────────────────────
// All /admin routes require authentication and rate limiting
app.use('/admin', requireAdminRateLimit, requireAdmin);

// ── Admin Routes: Student Profile ────────────────────────────────────────

app.get('/admin/students/:studentId/attributes', async (req: Request, res: Response) => {
  try {
    const attrs = await getActiveAttributes(req.params.studentId);
    res.json({ studentId: req.params.studentId, attributes: attrs });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to fetch attributes');
    res.status(500).json({ error: 'Failed to fetch attributes' });
  }
});

app.get('/admin/students/:studentId/archetypes', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT a.name, a.description, m.similarity_score, m.assigned_at
       FROM student_archetypes a
       JOIN student_archetype_memberships m ON a.id = m.archetype_id
       WHERE m.student_id = $1
       ORDER BY m.similarity_score DESC`,
      [req.params.studentId]
    );
    res.json({ studentId: req.params.studentId, archetypes: result.rows });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to fetch archetypes');
    res.status(500).json({ error: 'Failed to fetch archetypes' });
  }
});

app.post('/admin/students/:studentId/archetypes/refresh', async (req: Request, res: Response) => {
  try {
    const matches = await matchArchetypes(req.params.studentId);
    res.json({ studentId: req.params.studentId, matches });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to refresh archetypes');
    res.status(500).json({ error: 'Failed to refresh archetypes' });
  }
});

app.post('/admin/students/:studentId/archetypes/warm-start', async (req: Request, res: Response) => {
  try {
    await warmStartFromArchetype(req.params.studentId);
    res.json({ studentId: req.params.studentId, status: 'warm-started' });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to warm-start');
    res.status(500).json({ error: 'Failed to warm-start' });
  }
});

app.get('/admin/students/:studentId/onboarding', async (req: Request, res: Response) => {
  try {
    const state = await getOnboardingState(req.params.studentId);
    res.json({ studentId: req.params.studentId, onboarding: state });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to fetch onboarding state');
    res.status(500).json({ error: 'Failed to fetch onboarding state' });
  }
});

// ── Admin Routes: Syllabus ───────────────────────────────────────────────

app.get('/admin/syllabus/search', async (req: Request, res: Response) => {
  try {
    const { query, subject, exam_board, level, topic, limit } = req.query;
    const results = await searchSyllabus({
      query: String(query || ''),
      subject: subject ? String(subject) : undefined,
      examBoard: exam_board ? String(exam_board) : undefined,
      level: level ? String(level) : undefined,
      topic: topic ? String(topic) : undefined,
      limit: limit ? parseInt(String(limit), 10) : 5,
    });
    res.json({ query: String(query), results });
  } catch (err) {
    logger.error({ err }, '[Admin] Syllabus search failed');
    res.status(500).json({ error: 'Syllabus search failed' });
  }
});

app.get('/admin/syllabus/subjects', async (_req: Request, res: Response) => {
  try {
    const subjects = await getAvailableSubjects();
    res.json({ subjects });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to fetch subjects');
    res.status(500).json({ error: 'Failed to fetch subjects' });
  }
});

app.get('/admin/syllabus/subjects/:subject/topics', async (req: Request, res: Response) => {
  try {
    const topics = await getTopicsForSubject(req.params.subject, req.query.exam_board as string | undefined);
    res.json({ subject: req.params.subject, topics });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to fetch topics');
    res.status(500).json({ error: 'Failed to fetch topics' });
  }
});

app.post('/admin/syllabus/ingest', async (req: Request, res: Response) => {
  try {
    const { directory } = req.body;
    if (!directory || typeof directory !== 'string') {
      res.status(400).json({ error: 'directory path required' });
      return;
    }
    // Prevent directory traversal attacks
    if (directory.includes('..') || directory.startsWith('/')) {
      res.status(400).json({ error: 'Invalid directory path' });
      return;
    }
    const result = await ingestSyllabusDirectory(directory);
    res.json({ directory, ...result });
  } catch (err) {
    logger.error({ err }, '[Admin] Ingestion failed');
    res.status(500).json({ error: 'Ingestion failed' });
  }
});

// Automatic syllabus discovery (no manual PDF upload required)
app.post('/admin/syllabus/auto-ingest', async (req: Request, res: Response) => {
  try {
    const { subject, examBoard, level, queryHint, maxSources, force, url } = req.body || {};
    if (url && typeof url === 'string') {
      const result = await ingestFromUrl(url, {
        subject: typeof subject === 'string' ? subject : undefined,
        examBoard: typeof examBoard === 'string' ? examBoard : undefined,
        level: typeof level === 'string' ? level : undefined,
        force: force === true,
      });
      res.json(result);
      return;
    }
    const result = await autoIngestSyllabus({
      subject: typeof subject === 'string' ? subject : undefined,
      examBoard: typeof examBoard === 'string' ? examBoard : undefined,
      level: typeof level === 'string' ? level : undefined,
      queryHint: typeof queryHint === 'string' ? queryHint : undefined,
      maxSources: typeof maxSources === 'number' ? maxSources : undefined,
      force: force === true,
    });
    res.json(result);
  } catch (err) {
    logger.error({ err }, '[Admin] Auto-ingest failed');
    res.status(500).json({ error: 'Auto-ingest failed' });
  }
});

app.get('/admin/syllabus/ingest-runs', async (req: Request, res: Response) => {
  try {
    await ensureIngestSchema();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const result = await db.query(
      `SELECT id, source_url, subject, exam_board, status, chunks_inserted, error_message, started_at, completed_at
       FROM syllabus_ingest_runs
       ORDER BY started_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ runs: result.rows });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to list ingest runs');
    res.status(500).json({ error: 'Failed to list ingest runs' });
  }
});


// ── Admin Routes: Tools ──────────────────────────────────────────────────

app.get('/admin/tools', async (_req: Request, res: Response) => {
  try {
    const result = await db.query(`SELECT name, description, is_enabled, input_schema FROM tools ORDER BY name`);
    res.json({ tools: result.rows });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to fetch tools');
    res.status(500).json({ error: 'Failed to fetch tools' });
  }
});

app.post('/admin/tools/:toolName/toggle', async (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;
    await db.query(`UPDATE tools SET is_enabled = $1, updated_at = NOW() WHERE name = $2`, [enabled === true, req.params.toolName]);
    res.json({ tool: req.params.toolName, enabled: enabled === true });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to toggle tool');
    res.status(500).json({ error: 'Failed to toggle tool' });
  }
});

app.post('/admin/tools/:toolName/invoke', async (req: Request, res: Response) => {
  try {
    const { studentId, params } = req.body;
    if (!req.params.toolName || typeof req.params.toolName !== 'string') {
      res.status(400).json({ error: 'Tool name required' });
      return;
    }
    const result = await executeToolByName(req.params.toolName, params || {}, studentId || 'admin');
    res.json({ tool: req.params.toolName, result });
  } catch (err) {
    logger.error({ err }, '[Admin] Tool invocation failed');
    res.status(500).json({ error: 'Tool invocation failed' });
  }
});

// ── Admin Routes: Observability ──────────────────────────────────────────

app.get('/admin/observability/attribute-extraction', async (req: Request, res: Response) => {
  try {
    const { student_id, limit = '50' } = req.query;
    let query = `SELECT * FROM attribute_extraction_logs`;
    const params: unknown[] = [];
    if (student_id) {
      query += ` WHERE student_id = $1`;
      params.push(student_id);
    }
    query += ` ORDER BY timestamp DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(String(limit), 10));
    const result = await db.query(query, params);
    res.json({ logs: result.rows });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to fetch attribute extraction logs');
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

app.get('/admin/observability/tool-calls', async (req: Request, res: Response) => {
  try {
    const { student_id, tool_name, limit = '50' } = req.query;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (student_id) {
      conditions.push(`student_id = $${params.length + 1}`);
      params.push(student_id);
    }
    if (tool_name) {
      conditions.push(`tool_name = $${params.length + 1}`);
      params.push(tool_name);
    }
    let query = `SELECT * FROM tool_call_logs`;
    if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;
    query += ` ORDER BY timestamp DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(String(limit), 10));
    const result = await db.query(query, params);
    res.json({ logs: result.rows });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to fetch tool call logs');
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

app.get('/admin/observability/decisions', async (req: Request, res: Response) => {
  try {
    const { student_id, limit = '50' } = req.query;
    let query = `SELECT * FROM tutor_decision_logs`;
    const params: unknown[] = [];
    if (student_id) {
      query += ` WHERE student_id = $1`;
      params.push(student_id);
    }
    query += ` ORDER BY timestamp DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(String(limit), 10));
    const result = await db.query(query, params);
    res.json({ logs: result.rows });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to fetch decision logs');
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// ── v3.0 Admin Routes: Cognitive Memory Architecture ─────────────────────

// Graph migration
app.post('/admin/cognitive/migrate-graph', async (_req: Request, res: Response) => {
  try {
    const result = await migrateExistingDataToGraph();
    res.json({ status: 'migrated', result });
  } catch (err) {
    logger.error({ err }, '[Admin] Graph migration failed');
    res.status(500).json({ error: 'Graph migration failed' });
  }
});

// Graph health
app.get('/admin/cognitive/graph-health', async (_req: Request, res: Response) => {
  try {
    const graph = await getGraphAdapter();
    const healthy = await graph.healthCheck();
    res.json({ adapter: graph.name, healthy });
  } catch (err) {
    logger.error({ err }, '[Admin] Graph health check failed');
    res.status(500).json({ error: 'Graph health check failed' });
  }
});

// Segmentation config
app.get('/admin/cognitive/segmentation-config/:studentId?', async (req: Request, res: Response) => {
  try {
    const config = await getSegmentationConfig(req.params.studentId);
    res.json(config);
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to fetch segmentation config');
    res.status(500).json({ error: 'Failed to fetch segmentation config' });
  }
});

app.post('/admin/cognitive/segmentation-config/:studentId?', async (req: Request, res: Response) => {
  try {
    const { weights } = req.body;
    if (weights) {
      await updateSegmentationWeights(req.params.studentId || null, weights);
    }
    res.json({ status: 'updated' });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to update segmentation config');
    res.status(500).json({ error: 'Failed to update segmentation config' });
  }
});

// Boundary evaluation (test endpoint)
app.post('/admin/cognitive/evaluate-boundary', async (req: Request, res: Response) => {
  try {
    const { studentId, currentMessage, previousMessage, currentTopic, emotionalSnapshot, timeGapMinutes, recentContext } = req.body;
    const decision = await evaluateSessionBoundary(
      studentId,
      currentMessage,
      previousMessage,
      currentTopic,
      emotionalSnapshot || {},
      recentContext || '',
      timeGapMinutes || 0
    );
    res.json(decision);
  } catch (err) {
    logger.error({ err }, '[Admin] Boundary evaluation failed');
    res.status(500).json({ error: 'Boundary evaluation failed' });
  }
});

// Recent boundaries
app.get('/admin/cognitive/boundaries/:studentId', async (req: Request, res: Response) => {
  try {
    const boundaries = await getRecentBoundaries(req.params.studentId, parseInt(req.query.limit as string || '10', 10));
    res.json({ studentId: req.params.studentId, boundaries });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to fetch boundaries');
    res.status(500).json({ error: 'Failed to fetch boundaries' });
  }
});

// Boundary feedback
app.post('/admin/cognitive/boundary-feedback/:boundaryId', async (req: Request, res: Response) => {
  try {
    const { wasCorrect } = req.body;
    await provideBoundaryFeedback(req.params.boundaryId, wasCorrect === true);
    res.json({ boundaryId: req.params.boundaryId, feedback: wasCorrect });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to record feedback');
    res.status(500).json({ error: 'Failed to record feedback' });
  }
});

// Forgetting params
app.get('/admin/cognitive/forgetting-params/:studentId', async (req: Request, res: Response) => {
  try {
    const params = await getForgettingParams(req.params.studentId);
    res.json(params);
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to fetch forgetting params');
    res.status(500).json({ error: 'Failed to fetch forgetting params' });
  }
});

app.post('/admin/cognitive/forgetting-params/:studentId', async (req: Request, res: Response) => {
  try {
    await updateForgettingParams(req.params.studentId, req.body);
    res.json({ status: 'updated' });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to update forgetting params');
    res.status(500).json({ error: 'Failed to update forgetting params' });
  }
});

// Memory retrieval (test endpoint)
app.post('/admin/cognitive/retrieve-memories', async (req: Request, res: Response) => {
  try {
    const { studentId, query, workingMemoryContext, limit } = req.body;
    const memories = await retrieveMemories(query, studentId, workingMemoryContext || '', { limit });
    res.json({ studentId, query, memories });
  } catch (err) {
    logger.error({ err }, '[Admin] Memory retrieval failed');
    res.status(500).json({ error: 'Memory retrieval failed' });
  }
});

// Predictive pre-load
app.post('/admin/cognitive/preload/:studentId', async (req: Request, res: Response) => {
  try {
    const context = await predictivePreLoad(req.params.studentId);
    res.json({ studentId: req.params.studentId, context });
  } catch (err) {
    logger.error({ err }, '[Admin] Pre-load failed');
    res.status(500).json({ error: 'Pre-load failed' });
  }
});

app.get('/admin/cognitive/preload/:studentId', async (req: Request, res: Response) => {
  try {
    const context = await checkPreloadCache(req.params.studentId);
    res.json({ studentId: req.params.studentId, context });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to check preload');
    res.status(500).json({ error: 'Failed to check preload' });
  }
});

// Memory Palace
app.get('/admin/cognitive/palace/:studentId', async (req: Request, res: Response) => {
  try {
    const palace = await ensurePalace(req.params.studentId);
    const hierarchy = await getPalaceHierarchy(req.params.studentId);
    const stats = await getPalaceStats(req.params.studentId);
    res.json({ palace, hierarchy, stats });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to fetch palace');
    res.status(500).json({ error: 'Failed to fetch palace' });
  }
});

app.post('/admin/cognitive/palace/:studentId/discover-tunnels', async (req: Request, res: Response) => {
  try {
    const tunnels = await discoverTunnels(req.params.studentId);
    res.json({ studentId: req.params.studentId, tunnels });
  } catch (err) {
    logger.error({ err }, '[Admin] Tunnel discovery failed');
    res.status(500).json({ error: 'Tunnel discovery failed' });
  }
});

// Sleep mode
app.post('/admin/cognitive/sleep-mode/:studentId', async (req: Request, res: Response) => {
  try {
    const result = await runSleepMode(req.params.studentId);
    res.json({ studentId: req.params.studentId, result });
  } catch (err) {
    logger.error({ err }, '[Admin] Sleep mode failed');
    res.status(500).json({ error: 'Sleep mode failed' });
  }
});

app.post('/admin/cognitive/sleep-mode/tick', async (_req: Request, res: Response) => {
  try {
    const result = await runTimezoneAwareTick();
    res.json(result);
  } catch (err) {
    logger.error({ err }, '[Admin] Sleep tick failed');
    res.status(500).json({ error: 'Sleep tick failed' });
  }
});

app.get('/admin/cognitive/sleep-mode/preview', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const candidates = await previewSleepCandidates(limit);
    res.json({ candidates });
  } catch (err) {
    logger.error({ err }, '[Admin] Sleep preview failed');
    res.status(500).json({ error: 'Sleep preview failed' });
  }
});

app.post('/admin/cognitive/sleep-mode/bulk', async (req: Request, res: Response) => {
  try {
    const maxStudents = Math.min(500, Math.max(1, Number(req.body?.maxStudents) || 50));
    await runNightlyConsolidation(maxStudents);
    res.json({ ok: true, maxStudents });
  } catch (err) {
    logger.error({ err }, '[Admin] Sleep bulk failed');
    res.status(500).json({ error: 'Sleep bulk failed' });
  }
});


// Cognitive system config
app.get('/admin/cognitive/config/:key', async (req: Request, res: Response) => {
  try {
    const config = await getCognitiveConfig(req.params.key as any);
    res.json({ key: req.params.key, config });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to fetch config');
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

app.post('/admin/cognitive/config/:key', async (req: Request, res: Response) => {
  try {
    await setCognitiveConfig(req.params.key as any, req.body);
    res.json({ status: 'updated', key: req.params.key });
  } catch (err) {
    logger.error({ err }, '[Admin] Failed to update config');
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// ── WhatsApp Webhook ───────────────────────────────────────────────────

app.use('/whatsapp', createWebhookRouter());

// ── Startup ──────────────────────────────────────────────────────────────

async function main() {
  await initializeDatabase();
  await ensureIngestSchema().catch(err =>
    logger.warn({ err }, '[Startup] syllabus ingest schema failed')
  );

  // Start timezone-aware sleep mode scheduler in background
  startSleepScheduler().catch(err => logger.error({ err }, '[Startup] Sleep scheduler failed'));

  app.listen(PORT, () => {
    logger.info(`[Server] WaxPrep v3.1 listening on port ${PORT}`);
  });
}

main().catch(err => {
  logger.error({ err }, '[Server] Fatal startup error');
  process.exit(1);
});