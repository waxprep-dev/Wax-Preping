/**
 * Attribute Extraction Pipeline — Layer 2 of the Dynamic Student Profile.
 *
 * Replaces regex-based instant_facts.ts with open-ended LLM-driven discovery.
 * Every conversation turn triggers this pipeline asynchronously.
 *
 * Principles:
 * - No hardcoded attribute keys. The LLM decides what is relevant.
 * - Confidence thresholding: <0.3 rejected, 0.3-0.6 tentative, >=0.6 active, >=0.9 prompt-grade.
 * - Evidence is mandatory. Every attribute must quote the source text.
 * - Existing attributes are merged with Bayesian confidence updates.
 */
import { routeAndCall } from '../llm/router';
import { db } from '../db/client';
import { logger } from '../middleware/logger';
import { getPrompt } from '../config/prompts';

export interface CandidateAttribute {
  attribute: string;
  value: unknown;
  confidence: number;
  evidence: string[];
  category: 'goal' | 'cognitive_preference' | 'affective_state' | 'contextual_factor' | 'metacognitive_trait';
}

export interface ExtractionResult {
  candidates: CandidateAttribute[];
  rawLlmOutput: string;
}

/**
 * Main entry point. Called after every turn (async, off the critical path).
 */
export async function extractAttributesFromTurn(
  studentId: string,
  turnId: string | undefined,
  studentMessage: string,
  tutorResponse: string,
  perceptionIntent: string,
  existingActiveAttributes: Record<string, unknown>
): Promise<void> {
  const start = Date.now();

  try {
    const instruction = await getPrompt('attribute_extraction.v1');
    const existingAttrsText = Object.entries(existingActiveAttributes)
      .slice(0, 20)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('\n');

    const response = await routeAndCall([
      { role: 'system', content: instruction },
      {
        role: 'user',
        content: [
          `STUDENT SAID: "${studentMessage.slice(0, 800)}"`,
          `TUTOR REPLIED: "${tutorResponse.slice(0, 400)}"`,
          `PERCEIVED INTENT: ${perceptionIntent}`,
          `EXISTING ACTIVE ATTRIBUTES (do not duplicate — merge evidence instead):\n${existingAttrsText || 'None yet.'}`,
          `Generate candidate attributes that would help teach this student more effectively.`,
        ].join('\n\n'),
      },
    ], {
      tier: 'smart',
      jsonMode: true,
      maxTokens: 800,
      temperature: 0.2,
      studentId,
      purpose: 'attribute_extraction',
    });

    const rawOutput = response.content.replace(/```json|```/g, '').trim();
    let parsed: { candidates?: CandidateAttribute[] } = { candidates: [] };

    try {
      parsed = JSON.parse(rawOutput);
    } catch {
      logger.warn('[AttributePipeline] LLM returned invalid JSON, attempting recovery');
      const match = rawOutput.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    }

    const candidates = (parsed.candidates || []).filter(isValidCandidate);
    const accepted: CandidateAttribute[] = [];
    const rejected: CandidateAttribute[] = [];

    for (const candidate of candidates.slice(0, 8)) {
      if (candidate.confidence < 0.3) {
        rejected.push(candidate);
        continue;
      }

      const normalizedKey = normalizeAttributeKey(candidate.attribute);
      const existing = await getAttribute(studentId, normalizedKey);

      if (existing) {
        await mergeAttribute(studentId, normalizedKey, existing, candidate, turnId);
      } else {
        await insertAttribute(studentId, normalizedKey, candidate, turnId);
      }

      accepted.push(candidate);
    }

    await logExtraction(studentId, turnId, rawOutput, accepted, rejected, Date.now() - start, response.modelUsed);
  } catch (err) {
    logger.warn({ err }, '[AttributePipeline] Extraction failed this turn');
  }
}

function isValidCandidate(c: CandidateAttribute): boolean {
  return (
    !!c.attribute &&
    typeof c.attribute === 'string' &&
    c.attribute.length >= 2 &&
    c.attribute.length <= 100 &&
    typeof c.confidence === 'number' &&
    c.confidence >= 0 &&
    c.confidence <= 1 &&
    Array.isArray(c.evidence) &&
    c.evidence.length > 0 &&
    ['goal', 'cognitive_preference', 'affective_state', 'contextual_factor', 'metacognitive_trait'].includes(c.category)
  );
}

function normalizeAttributeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64);
}

async function getAttribute(studentId: string, key: string): Promise<{ confidence: number; value: unknown; evidence_json: unknown[] } | null> {
  const result = await db.query(
    `SELECT confidence, attribute_value as value, evidence_json 
     FROM student_attributes 
     WHERE student_id = $1 AND attribute_key = $2`,
    [studentId, key]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0];
}

async function insertAttribute(
  studentId: string,
  key: string,
  candidate: CandidateAttribute,
  turnId: string | undefined
): Promise<void> {
  const evidence = candidate.evidence.map((quote, idx) => ({
    quote: quote.slice(0, 300),
    turn_id: turnId || null,
    timestamp: new Date().toISOString(),
    source: 'llm_extraction',
    sequence: idx,
  }));

  const isActive = candidate.confidence >= 0.6;

  await db.query(
    `INSERT INTO student_attributes (
      student_id, attribute_key, attribute_value, confidence, 
      evidence_json, category, is_active, first_observed, last_updated
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
    [
      studentId,
      key,
      JSON.stringify(candidate.value),
      candidate.confidence,
      JSON.stringify(evidence),
      candidate.category,
      isActive,
    ]
  );
}

async function mergeAttribute(
  studentId: string,
  key: string,
  existing: { confidence: number; value: unknown; evidence_json: unknown[] },
  candidate: CandidateAttribute,
  turnId: string | undefined
): Promise<void> {
  const priorEvidence = Array.isArray(existing.evidence_json) ? existing.evidence_json : [];
  const newEvidence = candidate.evidence.map((quote, idx) => ({
    quote: quote.slice(0, 300),
    turn_id: turnId || null,
    timestamp: new Date().toISOString(),
    source: 'llm_extraction',
    sequence: idx + priorEvidence.length,
  }));

  const mergedEvidence = [...priorEvidence, ...newEvidence].slice(-10);

  const newConfidence = bayesianUpdate(existing.confidence, candidate.confidence, mergedEvidence.length);

  const isActive = newConfidence >= 0.6;

  await db.query(
    `UPDATE student_attributes 
     SET attribute_value = $1, 
         confidence = $2, 
         evidence_json = $3, 
         is_active = $4, 
         last_updated = NOW(),
         category = COALESCE(category, $5)
     WHERE student_id = $6 AND attribute_key = $7`,
    [
      JSON.stringify(candidate.value),
      newConfidence,
      JSON.stringify(mergedEvidence),
      isActive,
      candidate.category,
      studentId,
      key,
    ]
  );
}

/**
 * Bayesian-inspired confidence update.
 * As more evidence accumulates, confidence converges toward certainty
 * but requires agreement across multiple observations.
 */
function bayesianUpdate(prior: number, likelihood: number, evidenceCount: number): number {
  const k = Math.min(evidenceCount, 10);
  const weight = 0.5 + 0.05 * k;
  const updated = (prior * weight + likelihood) / (weight + 1);
  return Math.max(0, Math.min(1, updated));
}

async function logExtraction(
  studentId: string,
  turnId: string | undefined,
  rawOutput: string,
  accepted: CandidateAttribute[],
  rejected: CandidateAttribute[],
  latencyMs: number,
  modelUsed: string
): Promise<void> {
  await db.query(
    `INSERT INTO attribute_extraction_logs (
      student_id, turn_id, raw_llm_output, parsed_candidates, 
      accepted_attributes, rejected_attributes, latency_ms, model_used
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      studentId,
      turnId || null,
      JSON.stringify({ raw: rawOutput }),
      JSON.stringify([...accepted, ...rejected]),
      JSON.stringify(accepted),
      JSON.stringify(rejected),
      latencyMs,
      modelUsed,
    ]
  );
}

/**
 * Get all active attributes for a student (confidence >= 0.6).
 * Returns as a flat record for easy prompt injection.
 */
export async function getActiveAttributes(studentId: string): Promise<Record<string, unknown>> {
  const result = await db.query(
    `SELECT attribute_key, attribute_value, confidence, category
     FROM student_attributes
     WHERE student_id = $1 AND is_active = true
     ORDER BY confidence DESC, last_updated DESC`,
    [studentId]
  );

  const attrs: Record<string, unknown> = {};
  for (const row of result.rows) {
    attrs[row.attribute_key] = {
      value: row.attribute_value,
      confidence: row.confidence,
      category: row.category,
    };
  }
  return attrs;
}

/**
 * Get prompt-grade attributes (confidence >= 0.9).
 */
export async function getPromptGradeAttributes(studentId: string): Promise<Record<string, unknown>> {
  const result = await db.query(
    `SELECT attribute_key, attribute_value, category
     FROM student_attributes
     WHERE student_id = $1 AND is_active = true AND confidence >= 0.9
     ORDER BY last_updated DESC
     LIMIT 15`,
    [studentId]
  );

  const attrs: Record<string, unknown> = {};
  for (const row of result.rows) {
    attrs[row.attribute_key] = row.attribute_value;
  }
  return attrs;
}

/**
 * Build a natural-language summary of the student's attributes for prompt context.
 */
export async function buildAttributeContext(studentId: string): Promise<string> {
  const result = await db.query(
    `SELECT attribute_key, attribute_value, confidence, category, evidence_json
     FROM student_attributes
     WHERE student_id = $1 AND is_active = true
     ORDER BY confidence DESC, last_updated DESC
     LIMIT 20`,
    [studentId]
  );

  if (result.rows.length === 0) return 'No learner model established yet. Infer carefully from conversation.';

  const byCategory: Record<string, string[]> = {};
  for (const row of result.rows) {
    const cat = row.category;
    const val = typeof row.attribute_value === 'string' 
      ? row.attribute_value 
      : JSON.stringify(row.attribute_value);
    const line = `${row.attribute_key}: ${val} (confidence: ${(row.confidence as number).toFixed(2)})`;
    byCategory[cat] = byCategory[cat] || [];
    byCategory[cat].push(line);
  }

  const parts: string[] = [];
  const catNames: Record<string, string> = {
    goal: 'GOALS & ASPIRATIONS',
    cognitive_preference: 'COGNITIVE PREFERENCES',
    affective_state: 'AFFECTIVE & EMOTIONAL',
    contextual_factor: 'CONTEXT & CIRCUMSTANCE',
    metacognitive_trait: 'METACOGNITIVE TRAITS',
  };

  for (const [cat, lines] of Object.entries(byCategory)) {
    parts.push(`${catNames[cat] || cat}:\n${lines.join('\n')}`);
  }

  return parts.join('\n\n');
}