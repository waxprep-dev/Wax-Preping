/**
 * Syllabus Vector Store — replaces hardcoded curriculum packs.
 *
 * Principles:
 * - No prerequisite chains. No sequence numbers. No next_topic fields.
 * - Content is chunked, embedded, and searched by semantic similarity.
 * - The AI queries this store on-demand and decides what to teach.
 */
import { db } from '../db/client';
import { logger } from '../middleware/logger';
import { embed } from '../memory/embeddings';

export interface SyllabusChunk {
  id: string;
  subject: string;
  examBoard: string;
  level: string;
  topic: string;
  subTopic: string;
  objectives: string[];
  examWeight: number | null;
  relatedTopics: string[];
  contentText: string;
  sourceReference: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Insert a syllabus chunk with embedding.
 */
export async function insertSyllabusChunk(chunk: Omit<SyllabusChunk, 'id'>): Promise<string> {
  const embeddingText = `${chunk.subject} ${chunk.topic} ${chunk.subTopic} ${chunk.objectives.join(' ')} ${chunk.contentText}`;
  const { vector } = await embed(embeddingText);

  const result = await db.query(
    `INSERT INTO syllabus_chunks (
      subject, exam_board, level, topic, sub_topic, objectives,
      exam_weight, related_topics, content_text, source_reference, embedding, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector, $12)
    RETURNING id`,
    [
      chunk.subject,
      chunk.examBoard,
      chunk.level,
      chunk.topic,
      chunk.subTopic,
      chunk.objectives,
      chunk.examWeight,
      chunk.relatedTopics,
      chunk.contentText,
      chunk.sourceReference,
      `[${vector.join(',')}]`,
      JSON.stringify(chunk.metadata || {}),
    ]
  );

  return result.rows[0].id;
}

/**
 * Semantic search over syllabus chunks.
 */
export async function searchSyllabus(options: {
  query: string;
  subject?: string;
  examBoard?: string;
  level?: string;
  topic?: string;
  limit?: number;
  minSimilarity?: number;
}): Promise<(SyllabusChunk & { similarity: number })[]> {
  const { query, subject, examBoard, level, topic, limit = 5, minSimilarity = 0.25 } = options;

  const { vector } = await embed(query);
  const embeddingStr = `[${vector.join(',')}]`;

  const conditions: string[] = [];
  const params: (string | number)[] = [embeddingStr, limit];

  if (subject) {
    conditions.push(`subject = $${params.length + 1}`);
    params.push(subject.toLowerCase());
  }
  if (examBoard) {
    conditions.push(`exam_board = $${params.length + 1}`);
    params.push(examBoard.toUpperCase());
  }
  if (level) {
    conditions.push(`level = $${params.length + 1}`);
    params.push(level.toUpperCase());
  }
  if (topic) {
    conditions.push(`topic = $${params.length + 1}`);
    params.push(topic.toLowerCase());
  }

  const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

  const result = await db.query(
    `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
     FROM syllabus_chunks
     WHERE embedding IS NOT NULL ${whereClause}
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    params
  );

  return result.rows
    .filter((r: Record<string, unknown>) => (r.similarity as number) >= minSimilarity)
    .map((r: Record<string, unknown>) => ({
      id: r.id as string,
      subject: r.subject as string,
      examBoard: r.exam_board as string,
      level: r.level as string,
      topic: r.topic as string,
      subTopic: r.sub_topic as string,
      objectives: r.objectives as string[],
      examWeight: r.exam_weight as number | null,
      relatedTopics: r.related_topics as string[],
      contentText: r.content_text as string,
      sourceReference: r.source_reference as string | null,
      metadata: r.metadata as Record<string, unknown>,
      similarity: r.similarity as number,
    }));
}

/**
 * Get chunks by exact topic match (for when the AI already knows the topic).
 */
export async function getChunksByTopic(topic: string, subject?: string, examBoard?: string): Promise<SyllabusChunk[]> {
  const conditions = ['topic = $1'];
  const params: (string | number)[] = [topic.toLowerCase()];

  if (subject) {
    conditions.push(`subject = $${params.length + 1}`);
    params.push(subject.toLowerCase());
  }
  if (examBoard) {
    conditions.push(`exam_board = $${params.length + 1}`);
    params.push(examBoard.toUpperCase());
  }

  const result = await db.query(
    `SELECT * FROM syllabus_chunks WHERE ${conditions.join(' AND ')} ORDER BY sub_topic`,
    params
  );

  return result.rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    subject: r.subject as string,
    examBoard: r.exam_board as string,
    level: r.level as string,
    topic: r.topic as string,
    subTopic: r.sub_topic as string,
    objectives: r.objectives as string[],
    examWeight: r.exam_weight as number | null,
    relatedTopics: r.related_topics as string[],
    contentText: r.content_text as string,
    sourceReference: r.source_reference as string | null,
    metadata: r.metadata as Record<string, unknown>,
  }));
}

/**
 * Get all distinct subjects in the syllabus store.
 */
export async function getAvailableSubjects(): Promise<string[]> {
  const result = await db.query(`SELECT DISTINCT subject FROM syllabus_chunks ORDER BY subject`);
  return result.rows.map((r: Record<string, unknown>) => r.subject as string);
}

/**
 * Get all distinct topics for a subject.
 */
export async function getTopicsForSubject(subject: string, examBoard?: string): Promise<string[]> {
  const params: (string | number)[] = [subject.toLowerCase()];
  let query = `SELECT DISTINCT topic FROM syllabus_chunks WHERE subject = $1`;
  if (examBoard) {
    query += ` AND exam_board = $2`;
    params.push(examBoard.toUpperCase());
  }
  query += ` ORDER BY topic`;
  const result = await db.query(query, params);
  return result.rows.map((r: Record<string, unknown>) => r.topic as string);
}

/**
 * Format syllabus chunks for prompt context.
 */
export function formatSyllabusContext(chunks: SyllabusChunk[]): string {
  if (chunks.length === 0) return 'No syllabus content found for this query.';

  return chunks.map(c => {
    const weight = c.examWeight ? ` [Exam weight: ${(c.examWeight * 100).toFixed(0)}%]` : '';
    const objectives = c.objectives.length > 0 ? `\nObjectives: ${c.objectives.join('; ')}` : '';
    return `[${c.subject.toUpperCase()} — ${c.topic} / ${c.subTopic}]${weight}${objectives}\n${c.contentText.slice(0, 400)}`;
  }).join('\n\n---\n\n');
}