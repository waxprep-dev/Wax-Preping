import { db } from '../db/client';
import { routeAndCall } from '../llm/router';
import { logger } from '../middleware/logger';

// Compresses old episodes into epoch memories and deletes them
// Run this as a nightly cron job — see src/workers/memory_compressor.ts
export async function compressOldEpisodes(
  studentId: string,
  olderThanDays = 30
): Promise<void> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThanDays);

  const result = await db.query(
    `SELECT turn_id, student_message, tutor_response, topic, subject, timestamp
     FROM conversation_turns
     WHERE student_id = $1 AND timestamp < $2
     ORDER BY timestamp ASC
     LIMIT 100`,
    [studentId, cutoff.toISOString()]
  );

  if (result.rows.length < 10) return; // Not enough to compress

  const turnsText = result.rows
    .map((r: Record<string, unknown>) => `[${r.topic || 'general'}] S: ${(r.student_message as string).slice(0, 100)} T: ${(r.tutor_response as string).slice(0, 100)}`)
    .join('\n');

  const summaryResponse = await routeAndCall([
    {
      role: 'system',
      content: 'You are a memory archivist. Compress these tutoring turns into a 3-sentence memory that captures: what concepts were covered, what the student struggled with, and what worked. Be concrete. No fluff.',
    },
    { role: 'user', content: turnsText },
  ]);

  const epochMemoryKey = `epoch_${cutoff.toISOString().split('T')[0]}`;

  await db.query(
    `UPDATE student_profiles
     SET memory_blocks = memory_blocks || $1::jsonb
     WHERE student_id = $2`,
    [JSON.stringify({ [epochMemoryKey]: summaryResponse.content }), studentId]
  );

  const ids = result.rows.map((r: Record<string, unknown>) => r.turn_id as string);
  await db.query(
    `DELETE FROM conversation_turns WHERE turn_id = ANY($1)`,
    [ids]
  );

  logger.info(`[Compressor] Compressed ${ids.length} episodes for ${studentId}`);
}