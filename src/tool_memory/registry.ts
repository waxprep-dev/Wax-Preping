/**
 * WaxPrep v3.0 — Tool Memory Registry
 * Tools learn from their usage history. Memory learns from tool outputs.
 */

import { db } from '../db/client';
import { logger } from '../middleware/logger';
import type { ToolMemory } from '../types/cognitive';

/**
 * Get tool memory for a specific tool and student.
 */
export async function getToolMemory(toolName: string, studentId?: string): Promise<ToolMemory | null> {
  const result = await db.query(
    `SELECT * FROM tool_memories WHERE tool_name = $1 AND student_id ${studentId ? '= $2' : 'IS NULL'}
     LIMIT 1`,
    studentId ? [toolName, studentId] : [toolName]
  );

  if (result.rows.length === 0) return null;

  return mapToolMemory(result.rows[0]);
}

/**
 * Record a tool call outcome.
 */
export async function recordToolOutcome(
  toolName: string,
  studentId: string,
  params: Record<string, unknown>,
  latencyMs: number,
  success: boolean,
  error?: string
): Promise<void> {
  const existing = await getToolMemory(toolName, studentId);

  if (existing) {
    await db.query(
      `UPDATE tool_memories SET
        total_calls = total_calls + 1,
        successful_calls = successful_calls + $1,
        failed_calls = failed_calls + $2,
        avg_latency_ms = (avg_latency_ms * total_calls + $3) / (total_calls + 1),
        last_used_at = NOW(),
        last_updated = NOW()
       WHERE id = $4`,
      [success ? 1 : 0, success ? 0 : 1, latencyMs, existing.id]
    );

    if (!success && error) {
      // Record failure pattern
      const failures = existing.common_failures;
      const existingPattern = failures.find(f => error.includes(f.failure_pattern));
      if (existingPattern) {
        existingPattern.count++;
        existingPattern.last_occurrence = new Date().toISOString();
      } else {
        failures.push({
          failure_pattern: error.slice(0, 200),
          count: 1,
          last_occurrence: new Date().toISOString(),
        });
      }

      await db.query(
        `UPDATE tool_memories SET common_failures = $1 WHERE id = $2`,
        [JSON.stringify(failures.slice(-10)), existing.id]
      );
    }
  } else {
    await db.query(
      `INSERT INTO tool_memories (tool_name, student_id, total_calls, successful_calls, failed_calls, avg_latency_ms, last_used_at)
       VALUES ($1, $2, 1, $3, $4, $5, NOW())`,
      [toolName, studentId, success ? 1 : 0, success ? 0 : 1, latencyMs]
    );
  }

  // Also update global stats
  const global = await getToolMemory(toolName);
  if (global) {
    await db.query(
      `UPDATE tool_memories SET
        total_calls = total_calls + 1,
        successful_calls = successful_calls + $1,
        failed_calls = failed_calls + $2,
        last_updated = NOW()
       WHERE id = $3`,
      [success ? 1 : 0, success ? 0 : 1, global.id]
    );
  } else {
    await db.query(
      `INSERT INTO tool_memories (tool_name, student_id, total_calls, successful_calls, failed_calls)
       VALUES ($1, NULL, 1, $2, $3)`,
      [toolName, success ? 1 : 0, success ? 0 : 1]
    );
  }
}

/**
 * Update optimal parameters for a tool based on successful usage.
 */
export async function updateToolOptimalParams(
  toolName: string,
  studentId: string,
  params: Record<string, unknown>
): Promise<void> {
  await db.query(
    `UPDATE tool_memories SET optimal_params = optimal_params || $1::jsonb, last_updated = NOW()
     WHERE tool_name = $2 AND student_id = $3`,
    [JSON.stringify(params), toolName, studentId]
  );
}

/**
 * Record a tool dependency chain (tool A often followed by tool B).
 */
export async function recordToolDependency(
  toolA: string,
  toolB: string,
  studentId: string
): Promise<void> {
  const memory = await getToolMemory(toolA, studentId);
  if (!memory) return;

  const chains = memory.dependency_chains;
  const existing = chains.find(c => c[0] === toolA && c[1] === toolB);

  if (existing) {
    existing[2] += 0.1; // Increase co-occurrence probability
  } else {
    chains.push([toolA, toolB, 0.5]);
  }

  await db.query(
    `UPDATE tool_memories SET dependency_chains = $1 WHERE id = $2`,
    [JSON.stringify(chains), memory.id]
  );
}

/**
 * Get all tool memories for a student.
 */
export async function getAllToolMemoriesForStudent(studentId: string): Promise<ToolMemory[]> {
  const result = await db.query(
    `SELECT * FROM tool_memories WHERE student_id = $1 OR student_id IS NULL ORDER BY tool_name`,
    [studentId]
  );

  return result.rows.map(r => mapToolMemory(r));
}

function mapToolMemory(row: Record<string, unknown>): ToolMemory {
  return {
    id: row.id as string,
    tool_name: row.tool_name as string,
    student_id: (row.student_id as string) || null,
    total_calls: row.total_calls as number,
    successful_calls: row.successful_calls as number,
    failed_calls: row.failed_calls as number,
    avg_latency_ms: row.avg_latency_ms as number | null,
    optimal_params: (row.optimal_params as Record<string, unknown>) || {},
    common_failures: (row.common_failures as Array<{ failure_pattern: string; count: number; last_occurrence: string }>) || [],
    typical_use_cases: (row.typical_use_cases as string[]) || [],
    dependency_chains: (row.dependency_chains as Array<[string, string, number]>) || [],
    last_used_at: row.last_used_at ? new Date(row.last_used_at as string) : null,
    last_updated: new Date(row.last_updated as string),
  };
}