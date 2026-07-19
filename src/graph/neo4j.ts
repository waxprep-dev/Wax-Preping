  async traverse(startNodeId: string, options: TraversalOptions): Promise<GraphPath[]> {
    if (!this.driver) throw new Error('Neo4j not connected');
    const session = (this.driver as { session: () => unknown }).session();
    try {
      const { edgeTypes = [], maxDepth = 3, direction = 'out' } = options;
      const typeFilter = edgeTypes.length > 0 ? `:${edgeTypes.join('|')}` : '';
      let relPattern: string;
      if (direction === 'out') relPattern = `-[r${typeFilter}*1..${maxDepth}]->`;
      else if (direction === 'in') relPattern = `<-[r${typeFilter}*1..${maxDepth}]-`;
      else relPattern = `-[r${typeFilter}*1..${maxDepth}]-`;

      const result = await (session as { run: (q: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }> }).run(
        `MATCH path = (start)${relPattern}(end)
         WHERE start.id = $id
         RETURN path
         LIMIT $limit`,
        { id: startNodeId, limit: options.limit || 50 }
      );

      return result.records.map(r => {
        const path = r.get('path') as unknown as {
          segments: Array<{
            start: Record<string, unknown>;
            relationship: Record<string, unknown>;
            end: Record<string, unknown>;
          }>;
        };
        const nodes: GraphNode[] = [];
        const edges: GraphEdge[] = [];
        for (const seg of path.segments) {
          if (nodes.length === 0) nodes.push(this.mapNeo4jNode(seg.start));
          nodes.push(this.mapNeo4jNode(seg.end));
          edges.push(this.mapNeo4jEdge(seg.relationship, '', ''));
        }
        return { nodes, edges, length: edges.length };
      });
    } finally {
      await (session as { close: () => Promise<void> }).close();
    }
  }
