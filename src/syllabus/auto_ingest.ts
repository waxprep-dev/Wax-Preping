/**
 * Automatic syllabus discovery + ingest (no manual PDF uploads).
 *
 * Flow:
 * 1) Discover candidate official/public syllabus URLs via Brave/Tavily search
 *    (query is dynamic — subject/exam board from caller or student demand).
 * 2) Fetch page/PDF bytes (HTTP).
 * 3) Extract text (pdf-parse for PDFs, HTML strip for pages).
 * 4) LLM structures text into syllabus sections (no hardcoded topic lists).
 * 5) Insert into syllabus_chunks via existing ingest pipeline.
 * 6) Track sources in syllabus_ingest_runs to avoid thrashing.
 *
 * FORBIDDEN: admin-only manual banks as the only path.
 * Manual JSON directory ingest remains as an optional operator escape hatch.
 */
import axios from 'axios';
import { routeAndCall } from '../llm/router';
import { searchBrave, searchTavily } from '../tools/search';
import { logger } from '../middleware/logger';
import { db } from '../db/client';
import {
  ingestSyllabusSections,
  parseSyllabusJson,
  type RawSyllabusSection,
} from './ingest';

export interface AutoIngestRequest {
  /** Free-text subject, e.g. "biology" — discovered, not enum-checked */
  subject?: string;
  /** Free-text exam board label, e.g. "WAEC" | "JAMB" | "IGCSE" | student-specific */
  examBoard?: string;
  /** Optional level hint e.g. SS1/SS2/SS3 */
  level?: string;
  /** Extra search terms */
  queryHint?: string;
  /** Max source URLs to try */
  maxSources?: number;
  /** Force re-ingest even if source seen recently */
  force?: boolean;
  studentId?: string;
}

export interface AutoIngestResult {
  ok: boolean;
  query: string;
  sourcesTried: string[];
  sourcesIngested: string[];
  inserted: number;
  errors: number;
  skipped: string[];
  message: string;
}

const DEFAULT_MAX_SOURCES = 3;
const SOURCE_COOLDOWN_HOURS = 72;

/**
 * Ensure tracking table exists (idempotent).
 */
export async function ensureIngestSchema(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS syllabus_ingest_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source_url TEXT NOT NULL,
      subject TEXT,
      exam_board TEXT,
      status TEXT NOT NULL DEFAULT 'started',
      chunks_inserted INT NOT NULL DEFAULT 0,
      error_message TEXT,
      metadata JSONB NOT NULL DEFAULT '{}',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_syllabus_ingest_url ON syllabus_ingest_runs(source_url);
    CREATE INDEX IF NOT EXISTS idx_syllabus_ingest_started ON syllabus_ingest_runs(started_at DESC);
  `).catch(err => logger.debug({ err }, '[AutoIngest] schema ensure failed'));
}

/**
 * Main entry: discover + fetch + structure + store.
 */
export async function autoIngestSyllabus(
  req: AutoIngestRequest
): Promise<AutoIngestResult> {
  await ensureIngestSchema();

  const subject = (req.subject || '').trim();
  const examBoard = (req.examBoard || '').trim();
  const level = (req.level || '').trim();
  const maxSources = Math.min(8, Math.max(1, req.maxSources || DEFAULT_MAX_SOURCES));

  const query = [
    examBoard,
    subject,
    level,
    req.queryHint || '',
    'official syllabus PDF site:.gov OR site:.edu OR syllabus objectives',
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!query || query.length < 8) {
    return {
      ok: false,
      query,
      sourcesTried: [],
      sourcesIngested: [],
      inserted: 0,
      errors: 0,
      skipped: [],
      message: 'Need at least a subject or exam board to discover syllabi.',
    };
  }

  const urls = await discoverSyllabusUrls(query, maxSources * 3);
  if (urls.length === 0) {
    return {
      ok: false,
      query,
      sourcesTried: [],
      sourcesIngested: [],
      inserted: 0,
      errors: 0,
      skipped: [],
      message:
        'No syllabus URLs discovered. Configure BRAVE_SEARCH_API_KEY or TAVILY_API_KEY, or pass a direct URL via ingestFromUrl.',
    };
  }

  let inserted = 0;
  let errors = 0;
  const sourcesTried: string[] = [];
  const sourcesIngested: string[] = [];
  const skipped: string[] = [];

  for (const url of urls) {
    if (sourcesIngested.length >= maxSources) break;
    sourcesTried.push(url);

    if (!req.force && (await recentlyIngested(url))) {
      skipped.push(url);
      continue;
    }

    const runId = await startRun(url, subject, examBoard);
    try {
      const text = await fetchSourceText(url);
      if (!text || text.trim().length < 200) {
        throw new Error('Extracted text too short');
      }

      const sections = await structureSyllabusText(text, {
        subject: subject || undefined,
        examBoard: examBoard || undefined,
        level: level || undefined,
        sourceUrl: url,
        studentId: req.studentId,
      });

      if (sections.length === 0) {
        throw new Error('LLM produced zero sections');
      }

      // Stamp source reference
      for (const s of sections) {
        if (!s.contentText) continue;
      }

      const result = await ingestSyllabusSections(
        sections.map(s => ({
          ...s,
          subject: s.subject || subject || 'general',
          examBoard: s.examBoard || examBoard || 'unspecified',
          level: s.level || level || 'unspecified',
        }))
      );

      inserted += result.inserted;
      errors += result.errors;
      sourcesIngested.push(url);
      await completeRun(runId, 'success', result.inserted, null, {
        sectionCount: sections.length,
      });
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err, url }, '[AutoIngest] source failed');
      await completeRun(runId, 'error', 0, msg, {});
    }
  }

  return {
    ok: inserted > 0,
    query,
    sourcesTried,
    sourcesIngested,
    inserted,
    errors,
    skipped,
    message:
      inserted > 0
        ? `Ingested ${inserted} chunks from ${sourcesIngested.length} source(s).`
        : `No chunks inserted. Tried ${sourcesTried.length} source(s), errors=${errors}.`,
  };
}

/**
 * Ingest a single known URL (PDF or HTML) without search.
 */
export async function ingestFromUrl(
  url: string,
  meta: { subject?: string; examBoard?: string; level?: string; studentId?: string; force?: boolean } = {}
): Promise<AutoIngestResult> {
  await ensureIngestSchema();
  if (!meta.force && (await recentlyIngested(url))) {
    return {
      ok: true,
      query: url,
      sourcesTried: [url],
      sourcesIngested: [],
      inserted: 0,
      errors: 0,
      skipped: [url],
      message: 'Source ingested recently — skipped (pass force=true to override).',
    };
  }

  const runId = await startRun(url, meta.subject || '', meta.examBoard || '');
  try {
    const text = await fetchSourceText(url);
    const sections = await structureSyllabusText(text, {
      subject: meta.subject,
      examBoard: meta.examBoard,
      level: meta.level,
      sourceUrl: url,
      studentId: meta.studentId,
    });
    const result = await ingestSyllabusSections(
      sections.map(s => ({
        ...s,
        subject: s.subject || meta.subject || 'general',
        examBoard: s.examBoard || meta.examBoard || 'unspecified',
        level: s.level || meta.level || 'unspecified',
      }))
    );
    await completeRun(runId, 'success', result.inserted, null, {
      sectionCount: sections.length,
    });
    return {
      ok: result.inserted > 0,
      query: url,
      sourcesTried: [url],
      sourcesIngested: result.inserted > 0 ? [url] : [],
      inserted: result.inserted,
      errors: result.errors,
      skipped: [],
      message: `Inserted ${result.inserted} chunks from URL.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await completeRun(runId, 'error', 0, msg, {});
    return {
      ok: false,
      query: url,
      sourcesTried: [url],
      sourcesIngested: [],
      inserted: 0,
      errors: 1,
      skipped: [],
      message: msg,
    };
  }
}

/**
 * Demand-driven: if syllabus store is thin for a topic, auto-ingest in background.
 */
export async function ensureSyllabusCoverage(options: {
  subject?: string;
  examBoard?: string;
  topic?: string;
  minChunks?: number;
  studentId?: string;
}): Promise<AutoIngestResult | null> {
  const minChunks = options.minChunks ?? 3;
  try {
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (options.subject) {
      params.push(options.subject.toLowerCase());
      clauses.push(`LOWER(subject) = $${params.length}`);
    }
    if (options.examBoard) {
      params.push(options.examBoard.toUpperCase());
      clauses.push(`UPPER(exam_board) = $${params.length}`);
    }
    if (options.topic) {
      params.push(`%${options.topic.toLowerCase()}%`);
      clauses.push(`(LOWER(topic) LIKE $${params.length} OR LOWER(sub_topic) LIKE $${params.length})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const countRes = await db.query(
      `SELECT COUNT(*)::int AS c FROM syllabus_chunks ${where}`,
      params
    );
    const count = countRes.rows[0]?.c ?? 0;
    if (count >= minChunks) return null;

    logger.info(
      { count, minChunks, subject: options.subject, topic: options.topic },
      '[AutoIngest] Coverage low — triggering discovery'
    );

    return await autoIngestSyllabus({
      subject: options.subject,
      examBoard: options.examBoard,
      queryHint: options.topic,
      maxSources: 2,
      studentId: options.studentId,
    });
  } catch (err) {
    logger.warn({ err }, '[AutoIngest] ensureSyllabusCoverage failed');
    return null;
  }
}

async function discoverSyllabusUrls(query: string, limit: number): Promise<string[]> {
  const [brave, tavily] = await Promise.allSettled([
    searchBrave(query),
    searchTavily(query),
  ]);
  const hits = [
    ...(brave.status === 'fulfilled' ? brave.value : []),
    ...(tavily.status === 'fulfilled' ? tavily.value : []),
  ];

  const urls: string[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const u = (h.url || '').trim();
    if (!u || seen.has(u)) continue;
    if (!/^https?:\/\//i.test(u)) continue;
    // Prefer PDFs and education domains but do not hardcode boards
    seen.add(u);
    urls.push(u);
    if (urls.length >= limit) break;
  }

  // Stable preference: PDFs first
  urls.sort((a, b) => Number(b.toLowerCase().includes('.pdf')) - Number(a.toLowerCase().includes('.pdf')));
  return urls;
}

async function fetchSourceText(url: string): Promise<string> {
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: 25_000,
    maxContentLength: 25 * 1024 * 1024,
    headers: {
      'User-Agent': 'WaxPrepSyllabusBot/3.1 (+educational; respectful fetch)',
      Accept: 'application/pdf,text/html,application/xhtml+xml,text/plain,*/*',
    },
    validateStatus: s => s >= 200 && s < 400,
  });

  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  const buf = Buffer.from(response.data);
  const looksPdf =
    contentType.includes('pdf') ||
    url.toLowerCase().includes('.pdf') ||
    buf.slice(0, 4).toString() === '%PDF';

  if (looksPdf) {
    return extractPdfText(buf);
  }

  const html = buf.toString('utf8');
  return stripHtml(html);
}

async function extractPdfText(buf: Buffer): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buf);
    return String(data.text || '');
  } catch (err) {
    logger.warn({ err }, '[AutoIngest] pdf-parse failed');
    throw new Error('PDF text extraction failed');
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80_000);
}

async function structureSyllabusText(
  text: string,
  meta: {
    subject?: string;
    examBoard?: string;
    level?: string;
    sourceUrl: string;
    studentId?: string;
  }
): Promise<RawSyllabusSection[]> {
  // Chunk long documents
  const window = text.slice(0, 14_000);

  const response = await routeAndCall(
    [
      {
        role: 'system',
        content: [
          'You convert official syllabus / curriculum documents into structured JSON chunks.',
          'Do NOT invent exam boards or subjects not supported by the text — use hints only when consistent.',
          'No prerequisite chains. No forced sequences. Just topics, subtopics, objectives, content.',
          'JSON only.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          meta.subject ? `Subject hint: ${meta.subject}` : 'Subject hint: discover from text',
          meta.examBoard
            ? `Exam board hint: ${meta.examBoard}`
            : 'Exam board hint: discover from text or use "unspecified"',
          meta.level ? `Level hint: ${meta.level}` : '',
          `Source URL: ${meta.sourceUrl}`,
          '',
          'DOCUMENT TEXT:',
          window,
          '',
          'Return JSON:',
          '{',
          '  "subject": "string",',
          '  "exam_board": "string",',
          '  "level": "string",',
          '  "sections": [',
          '    {',
          '      "topic": "string",',
          '      "sub_topic": "string",',
          '      "objectives": ["..."],',
          '      "content": "2-8 sentence teaching-relevant summary of this section",',
          '      "page": null,',
          '      "exam_weight": null,',
          '      "related_topics": []',
          '    }',
          '  ]',
          '}',
          'Aim for 5-25 sections covering distinct topics found in the text.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
    {
      tier: 'smart',
      jsonMode: true,
      maxTokens: 3500,
      temperature: 0.2,
      studentId: meta.studentId,
      purpose: 'syllabus_auto_structure',
    }
  );

  const cleaned = response.content.replace(/```json|```/g, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to salvage embedded JSON
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Invalid JSON from structure step');
    parsed = JSON.parse(m[0]);
  }

  const sections = parseSyllabusJson(parsed);
  // Attach source page metadata via content prefix when missing
  return sections.map(s => ({
    ...s,
    contentText:
      s.contentText ||
      `${s.topic} / ${s.subTopic}: ${s.objectives.join('; ')}`.slice(0, 2000),
    relatedTopics: s.relatedTopics || [],
  }));
}

async function recentlyIngested(url: string): Promise<boolean> {
  try {
    const result = await db.query(
      `SELECT 1 FROM syllabus_ingest_runs
       WHERE source_url = $1
         AND status = 'success'
         AND started_at > NOW() - ($2::text || ' hours')::interval
       LIMIT 1`,
      [url, String(SOURCE_COOLDOWN_HOURS)]
    );
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

async function startRun(url: string, subject: string, examBoard: string): Promise<string> {
  const result = await db.query(
    `INSERT INTO syllabus_ingest_runs (source_url, subject, exam_board, status)
     VALUES ($1, $2, $3, 'started')
     RETURNING id`,
    [url, subject || null, examBoard || null]
  );
  return result.rows[0].id as string;
}

async function completeRun(
  id: string,
  status: string,
  chunks: number,
  error: string | null,
  metadata: Record<string, unknown>
): Promise<void> {
  await db
    .query(
      `UPDATE syllabus_ingest_runs SET
         status = $1,
         chunks_inserted = $2,
         error_message = $3,
         metadata = $4::jsonb,
         completed_at = NOW()
       WHERE id = $5`,
      [status, chunks, error, JSON.stringify(metadata), id]
    )
    .catch(() => {});
}
