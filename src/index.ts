/**
 * WaxPrep v3.0 — AI Tutor Backend.
 *
 * Entry point. Initializes the database, starts the Express server,
 * wires up the WhatsApp webhook, and registers admin routes for the
 * new cognitive architecture (attributes, archetypes, syllabus, tools).
 */
import 'dotenv/config';
import express, { Request, Response } from 'express';
import { initializeDatabase } from './db/client';
import { createWebhookRouter } from './whatsapp/webhook';
import { logger } from './middleware/logger';
import { db } from './db/client';
import { searchSyllabus, getAvailableSubjects, getTopicsForSubject } from './syllabus/store';
import { ingestSyllabusDirectory } from './syllabus/ingest';
import { getActiveAttributes, getPromptGradeAttributes } from './student_profile/attribute_pipeline';
import { matchArchetypes, warmStartFromArchetype } from './student_profile/archetypes';
import { getOnboardingState } from './onboarding/engine';
import { executeToolByName } from './tools/implementations';

const app = express();
const PORT = process.env.PORT || 3000;

// Capture raw body for Meta signature verification BEFORE express.json() parses
app.use((req: Request, res, next) => {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(data);
    next();
  });
});

app.use(express.json());
app.use(logger);

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', version: '3.0.0-cognitive' });
});

// ── Admin Routes: Student Profile ────────────────────────────────────────

app.get('/admin/students/:studentId/attributes', async (req: Request, res: Response) => {
  try {
    const attrs = await getActiveAttributes(req.params.studentId);
    res.json({ studentId: req.params.studentId, attributes: attrs });
  } catch (err) {
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
    res.status(500).json({ error: 'Failed to fetch archetypes' });
  }
});

app.post('/admin/students/:studentId/archetypes/refresh', async (req: Request, res: Response) => {
  try {
    const matches = await matchArchetypes(req.params.studentId);
    res.json({ studentId: req.params.studentId, matches });
  } catch (err) {
    res.status(500).json({ error: 'Failed to refresh archetypes' });
  }
});

app.post('/admin/students/:studentId/archetypes/warm-start', async (req: Request, res: Response) => {
  try {
    await warmStartFromArchetype(req.params.studentId);
    res.json({ studentId: req.params.studentId, status: 'warm-started' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to warm-start' });
  }
});

app.get('/admin/students/:studentId/onboarding', async (req: Request, res: Response) => {
  try {
    const state = await getOnboardingState(req.params.studentId);
    res.json({ studentId: req.params.studentId, onboarding: state });
  } catch (err) {
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
    res.status(500).json({ error: 'Syllabus search failed' });
  }
});

app.get('/admin/syllabus/subjects', async (_req: Request, res: Response) => {
  try {
    const subjects = await getAvailableSubjects();
    res.json({ subjects });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch subjects' });
  }
});

app.get('/admin/syllabus/subjects/:subject/topics', async (req: Request, res: Response) => {
  try {
    const topics = await getTopicsForSubject(req.params.subject, req.query.exam_board as string | undefined);
    res.json({ subject: req.params.subject, topics });
  } catch (err) {
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
    const result = await ingestSyllabusDirectory(directory);
    res.json({ directory, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Ingestion failed' });
  }
});

// ── Admin Routes: Tools ──────────────────────────────────────────────────

app.get('/admin/tools', async (_req: Request, res: Response) => {
  try {
    const result = await db.query(`SELECT name, description, is_enabled, input_schema FROM tools ORDER BY name`);
    res.json({ tools: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tools' });
  }
});

app.post('/admin/tools/:toolName/toggle', async (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;
    await db.query(`UPDATE tools SET is_enabled = $1, updated_at = NOW() WHERE name = $2`, [enabled === true, req.params.toolName]);
    res.json({ tool: req.params.toolName, enabled: enabled === true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle tool' });
  }
});

app.post('/admin/tools/:toolName/invoke', async (req: Request, res: Response) => {
  try {
    const { studentId, params } = req.body;
    const result = await executeToolByName(req.params.toolName, params || {}, studentId || 'admin');
    res.json({ tool: req.params.toolName, result });
  } catch (err) {
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
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// ── WhatsApp Webhook ───────────────────────────────────────────────────

app.use('/whatsapp', createWebhookRouter());

// ── Startup ──────────────────────────────────────────────────────────────

async function main() {
  await initializeDatabase();
  app.listen(PORT, () => {
    logger.info(`[Server] WaxPrep v3.0 listening on port ${PORT}`);
  });
}

main().catch(err => {
  logger.error({ err }, '[Server] Fatal startup error');
  process.exit(1);
});
