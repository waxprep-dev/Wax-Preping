/**
 * Tool registry — v3.0: delegates to the dynamic tool system.
 *
 * The old hardcoded switch statement has been replaced. This module now
 * serves as a thin compatibility layer that reads from the tools table
 * and delegates to src/tools/implementations.ts.
 */
import { executeToolByName } from './implementations';
import { db } from '../db/client';
import { logger } from '../middleware/logger';

export interface ToolDefinition {
  name: string;
  description: string;
}

/**
 * Get tool definitions for prompt injection.
 * Reads from the dynamic tools table.
 */
export async function getToolDefinitions(): Promise<ToolDefinition[]> {
  const result = await db.query(
    `SELECT name, description FROM tools WHERE is_enabled = true ORDER BY name`
  );
  return result.rows.map((r: Record<string, unknown>) => ({
    name: r.name as string,
    description: r.description as string,
  }));
}

/**
 * Legacy executeTool function — now delegates to the dynamic system.
 */
export async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  studentId: string
): Promise<string> {
  logger.info(`[ToolRegistry] Delegating: ${toolName}`);
  const result = await executeToolByName(toolName, params, studentId);
  return result.success ? result.output : result.error || `Tool ${toolName} failed`;
}
