/**
 * WaxPrep v3.0 — Graph Adapter Factory
 * Selects the appropriate graph adapter based on cognitive_system_config.
 * Defaults to PostgreSQL. Swaps to Neo4j when configured.
 */

import type { GraphAdapter } from './interfaces';
import { PostgresGraphAdapter } from './postgres';
import { Neo4jGraphAdapter } from './neo4j';
import { getCognitiveConfig } from '../config/cognitive';
import { logger } from '../middleware/logger';

let adapterInstance: GraphAdapter | null = null;

export async function getGraphAdapter(): Promise<GraphAdapter> {
  if (adapterInstance) return adapterInstance;

  const config = await getCognitiveConfig('graph');
  const adapterType = config.adapter || 'postgres';

  if (adapterType === 'neo4j') {
    logger.info('[GraphFactory] Attempting Neo4j adapter');
    const neo4jAdapter = new Neo4jGraphAdapter();
    try {
      await neo4jAdapter.connect();
      adapterInstance = neo4jAdapter;
      logger.info('[GraphFactory] Neo4j connected');
      return adapterInstance;
    } catch (err) {
      logger.warn({ err }, '[GraphFactory] Neo4j connect failed — falling back to PostgreSQL');
    }
  }

  logger.info('[GraphFactory] Using PostgreSQL-native adapter');
  adapterInstance = new PostgresGraphAdapter();
  await adapterInstance.connect();
  return adapterInstance;
}

export function resetGraphAdapter(): void {
  adapterInstance = null;
  logger.info('[GraphFactory] Adapter reset');
}
