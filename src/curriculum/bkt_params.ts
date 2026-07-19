/**
 * Per-concept BKT parameters with simple online updates from interaction logs.
 * Global DEFAULT_BKT remains the prior; observed success/fail rates pull pG/pS/pT.
 *
 * Full EM (Baum-Welch style) can replace this later; this is a stable online
 * estimator that improves as knowledge_trace_events accumulate.
 */
import { db } from '../db/client';
import { DEFAULT_BKT, type BktParams } from '../teaching/bkt';

export async function getConceptBktParams(conceptId: string): Promise<BktParams> {
  const r = await db.query(
    `SELECT p_l0, p_t, p_g, p_s FROM bkt_concept_params WHERE concept_id = $1`,
    [conceptId]
  ).catch(() => ({ rows: [] as Record<string, number>[] }));
  if (!r.rows[0]) return { ...DEFAULT_BKT };
  const row = r.rows[0];
  return {
    pL0: Number(row.p_l0) || DEFAULT_BKT.pL0,
    pT: Number(row.p_t) || DEFAULT_BKT.pT,
    pG: Number(row.p_g) || DEFAULT_BKT.pG,
    pS: Number(row.p_s) || DEFAULT_BKT.pS,
  };
}

export async function logTraceEvent(input: {
  studentId: string;
  conceptId: string;
  success: boolean;
  pBefore: number;
  pAfter: number;
  source?: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO knowledge_trace_events (student_id, concept_id, success, p_before, p_after, source)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [input.studentId, input.conceptId, input.success, input.pBefore, input.pAfter, input.source || 'tutor']
  ).catch(() => {});
}

/**
 * Refit pG / pS / pT lightly from recent events for a concept.
 * Called from workers — not on the WhatsApp hot path.
 */
export async function refitConceptParams(conceptId: string): Promise<BktParams> {
  const r = await db.query(
    `SELECT success, p_before FROM knowledge_trace_events
     WHERE concept_id = $1 ORDER BY created_at DESC LIMIT 500`,
    [conceptId]
  ).catch(() => ({ rows: [] as { success: boolean; p_before: number }[] }));

  const rows = r.rows;
  if (rows.length < 20) return getConceptBktParams(conceptId);

  // Crude online estimates:
  // pG ≈ P(success | low prior mastery)
  // pS ≈ P(fail | high prior mastery)
  let lowN = 0, lowSuccess = 0, highN = 0, highFail = 0, midSuccess = 0, midN = 0;
  for (const row of rows) {
    const p = Number(row.p_before) || 0.1;
    if (p < 0.35) {
      lowN++;
      if (row.success) lowSuccess++;
    } else if (p > 0.7) {
      highN++;
      if (!row.success) highFail++;
    } else {
      midN++;
      if (row.success) midSuccess++;
    }
  }

  const pG = lowN >= 5 ? clamp(lowSuccess / lowN, 0.05, 0.4) : DEFAULT_BKT.pG;
  const pS = highN >= 5 ? clamp(highFail / highN, 0.02, 0.3) : DEFAULT_BKT.pS;
  // pT: pull toward higher transition if mid-band often succeeds
  const midRate = midN >= 5 ? midSuccess / midN : 0.5;
  const pT = clamp(DEFAULT_BKT.pT * 0.6 + midRate * 0.25, 0.05, 0.4);

  const params: BktParams = { pL0: DEFAULT_BKT.pL0, pT, pG, pS };
  await db.query(
    `INSERT INTO bkt_concept_params (concept_id, p_l0, p_t, p_g, p_s, sample_size, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (concept_id) DO UPDATE SET
       p_t = EXCLUDED.p_t, p_g = EXCLUDED.p_g, p_s = EXCLUDED.p_s,
       sample_size = EXCLUDED.sample_size, updated_at = NOW()`,
    [conceptId, params.pL0, params.pT, params.pG, params.pS, rows.length]
  ).catch(() => {});

  return params;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}