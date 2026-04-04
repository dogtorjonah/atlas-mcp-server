import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { listClusterFiles } from '../db.js';

function listClusters(runtime: AtlasRuntime, workspace: string): string[] {
  const rows = runtime.db.prepare(
    'SELECT DISTINCT cluster FROM atlas_files WHERE workspace = ? ORDER BY cluster ASC',
  ).all(workspace) as Array<{ cluster: string | null }>;
  return rows
    .map((row) => row.cluster)
    .filter((cluster): cluster is string => typeof cluster === 'string' && cluster.trim().length > 0);
}

export function registerClusterTool(server: McpServer, runtime: AtlasRuntime): void {
  server.tool(
    'atlas_cluster',
    {
      cluster: z.string().min(1),
      workspace: z.string().optional(),
    },
    async ({ cluster, workspace }: { cluster: string; workspace?: string }) => {
      const ws = workspace ?? runtime.config.workspace;
      const rows = listClusterFiles(runtime.db, ws, cluster);

      if (rows.length === 0) {
        const clusters = listClusters(runtime, ws);
        return {
          content: [{
            type: 'text',
            text: clusters.length > 0
              ? `No cluster "${cluster}". Available clusters:\n${clusters.map((name) => `  - ${name}`).join('\n')}`
              : `No cluster "${cluster}" in workspace "${ws}".`,
          }],
        };
      }

      const lines = rows.map((row) => {
        const shortPurpose = row.purpose.length > 120 ? `${row.purpose.slice(0, 120)}...` : row.purpose;
        return `  📄 ${row.file_path} (${row.loc} LOC)\n     ${shortPurpose}`;
      });

      const totalLoc = rows.reduce((sum, row) => sum + (row.loc || 0), 0);
      return {
        content: [{
          type: 'text',
          text: `Cluster: ${cluster} (${rows.length} files, ${totalLoc} LOC)\n\n${lines.join('\n\n')}`,
        }],
      };
    },
  );
}
