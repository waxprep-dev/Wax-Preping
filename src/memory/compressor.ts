/**
 * Memory compressor: folds old raw episodes into dense semantic summaries.
 *
 * v1 compressed and then DELETED the raw turns — destroying the embedding
 * index and making the summaries the only record. v2 keeps a rolling 90 days
 * of raw turns (storage is cheap, recall quality matters) and compresses only
 * beyond that horizon. Summary prompt is now DB-configurable.
 */
import { db } from '../db/client';
import { routeAndCall } from '../llm/router';
import { getPrompt } from '../config/prompts';
import { logger } from '../middleware/logger';

export async function compressOldEpisodes(studentId: string, olderThanDays = 90): Promise<void> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThanDays);

  const result = await db.query(
    `SELECT turn_id, student_message, tutor_response, topic, subject, timestamp
     FROM conversation_turns
     WHERE student_id = $1 AND timestamp < $2
     ORDER BY timestamp ASC LIMIT 100`,
    [studentId, cutoff.toISOString()]
  );

  if (result.rows.length < 10) return;

  const turnsText = result.rows
    .map((r: Record<string, unknown>) =>
      `[${r.topic || 'general'}] S: ${(r.student_message as string).slice(0, 80)} T: ${(r.tutor_response as string).slice(0, 80)}`
    )
    .join('\n');

  try {
    const instruction = await getPrompt('memory_compressor.v1');
    const summaryResponse = await routeAndCall([
      { role: 'system', content: instruction },
      { role: 'user', content: turnsText },
    ], { tier: 'deep', maxTokens: 400 });

    const epochKey = `epoch_${cutoff.toISOString().split('T')[0]}`;

    await db.query(
      `UPDATE student_profiles
       SET memory_blocks = memory_blocks || $1::jsonb
       WHERE student_id = $2`,
      [JSON.stringify({ [epochKey]: summaryResponse.content }), studentId]
    );

    const ids = result.rows.map((r: Record<string, unknown>) => r.turn_id as string);
    await db.query(`DELETE FROM conversation_turns WHERE turn_id = ANY($1)`, [ids]);

    logger.info(`[Compressor] Compressed ${ids.length} episodes for ${studentId}`);
  } catch (err) {
    logger.warn({ err }, '[Compressor] Failed');
  }
}
