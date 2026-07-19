/**
 * Document modality: extract text from PDFs and analyze structure.
 * v1 truncated to 2000 chars and lost the rest; v2 keeps a larger window and
 * a summary so deliberation can actually teach from the document.
 */
import { routeAndCall } from '../llm/router';
import { getPrompt } from '../config/prompts';
import { logger } from '../middleware/logger';

export interface DocumentAnalysis {
  rawText: string;
  examBoard: string;
  subject: string;
  topics: string[];
  questions: string[];
  difficulty: number;
  summary: string;
}

export async function analyzeDocument(documentBuffer: Buffer, filename?: string): Promise<DocumentAnalysis> {
  let rawText = '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(documentBuffer);
    rawText = (data.text as string) || '';
  } catch {
    logger.warn('[DocumentPerception] PDF parse unavailable');
  }

  const fallback: DocumentAnalysis = {
    rawText: rawText.slice(0, 6000),
    examBoard: 'unknown',
    subject: 'general',
    topics: [],
    questions: [],
    difficulty: 0.5,
    summary: filename ? `Document "${filename}" received` : 'Document received',
  };

  if (!rawText.trim()) return fallback;

  try {
    const instruction = await getPrompt('document_analysis.v1');
    const structured = await routeAndCall([
      { role: 'system', content: instruction },
      { role: 'user', content: rawText.slice(0, 4000) },
    ], { tier: 'fast', maxTokens: 350 });

    const parsed = JSON.parse(structured.content.replace(/```json|```/g, '').trim());
    return {
      ...fallback,
      examBoard: parsed.examBoard || fallback.examBoard,
      subject: parsed.subject || fallback.subject,
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      questions: Array.isArray(parsed.questions) ? parsed.questions : [],
      difficulty: typeof parsed.difficulty === 'number' ? parsed.difficulty : 0.5,
      summary: parsed.summary || fallback.summary,
    };
  } catch (err) {
    logger.warn({ err }, '[DocumentPerception] Analysis failed');
    return fallback;
  }
}
