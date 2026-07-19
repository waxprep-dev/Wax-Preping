/**
 * Syllabus Ingestion Pipeline.
 *
 * Sources: Official WAEC/JAMB syllabus PDFs.
 * Output: syllabus_chunks table with embeddings.
 *
 * No forced sequences. No prerequisites. Just searchable content.
 */
import { insertSyllabusChunk } from './store';
import { logger } from '../middleware/logger';

export interface RawSyllabusSection {
  subject: string;
  examBoard: string;
  level: string;
  topic: string;
  subTopic: string;
  objectives: string[];
  contentText: string;
  sourcePage?: number;
  examWeight?: number;
  relatedTopics?: string[];
}

/**
 * Ingest a batch of raw syllabus sections.
 */
export async function ingestSyllabusSections(sections: RawSyllabusSection[]): Promise<{ inserted: number; errors: number }> {
  let inserted = 0;
  let errors = 0;

  for (const section of sections) {
    try {
      await insertSyllabusChunk({
        subject: section.subject,
        examBoard: section.examBoard,
        level: section.level,
        topic: section.topic,
        subTopic: section.subTopic,
        objectives: section.objectives,
        examWeight: section.examWeight || null,
        relatedTopics: section.relatedTopics || [],
        contentText: section.contentText,
        sourceReference: section.sourcePage ? `Page ${section.sourcePage}` : null,
        metadata: { sourcePage: section.sourcePage },
      });
      inserted++;
    } catch (err) {
      logger.warn({ err }, `[SyllabusIngest] Failed to insert section: ${section.topic}/${section.subTopic}`);
      errors++;
    }
  }

  logger.info(`[SyllabusIngest] Inserted ${inserted} chunks, ${errors} errors`);
  return { inserted, errors };
}

/**
 * Parse a structured syllabus JSON (from PDF extraction) into sections.
 * Expected format:
 * {
 *   "subject": "biology",
 *   "exam_board": "WAEC",
 *   "level": "SS3",
 *   "sections": [
 *     {
 *       "topic": "ecology",
 *       "sub_topic": "food chains and webs",
 *       "objectives": ["Identify producers", "Construct food chains"],
 *       "content": "full text...",
 *       "page": 42,
 *       "exam_weight": 0.08,
 *       "related_topics": ["energy flow", "pyramids"]
 *     }
 *   ]
 * }
 */
export function parseSyllabusJson(raw: unknown): RawSyllabusSection[] {
  const data = raw as Record<string, unknown>;
  const subject = String(data.subject || 'unknown');
  const examBoard = data.exam_board ? String(data.exam_board) : 'unspecified';
  const level = String(data.level || 'SS3');

  const sections = Array.isArray(data.sections) ? data.sections : [];
  return sections.map((s: Record<string, unknown>) => ({
    subject,
    examBoard,
    level,
    topic: String(s.topic || 'unknown'),
    subTopic: String(s.sub_topic || s.topic || 'unknown'),
    objectives: Array.isArray(s.objectives) ? s.objectives.map(String) : [],
    contentText: String(s.content || s.content_text || ''),
    sourcePage: typeof s.page === 'number' ? s.page : undefined,
    examWeight: typeof s.exam_weight === 'number' ? s.exam_weight : undefined,
    relatedTopics: Array.isArray(s.related_topics) ? s.related_topics.map(String) : [],
  }));
}

/**
 * Ingest from a directory of syllabus JSON files.
 */
export async function ingestSyllabusDirectory(dirPath: string): Promise<{ inserted: number; errors: number }> {
  const fs = await import('fs');
  const path = await import('path');

  let totalInserted = 0;
  let totalErrors = 0;

  if (!fs.existsSync(dirPath)) {
    logger.warn(`[SyllabusIngest] Directory not found: ${dirPath}`);
    return { inserted: 0, errors: 0 };
  }

  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8'));
      const sections = parseSyllabusJson(raw);
      const result = await ingestSyllabusSections(sections);
      totalInserted += result.inserted;
      totalErrors += result.errors;
    } catch (err) {
      logger.warn({ err }, `[SyllabusIngest] Failed to parse ${file}`);
      totalErrors++;
    }
  }

  return { inserted: totalInserted, errors: totalErrors };
}