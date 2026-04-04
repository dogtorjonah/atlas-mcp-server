import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { toolWithDescription } from './helpers.js';
import { listPatternFiles } from '../db.js';

export function registerPatternsTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_patterns',
    'Find all files that use a specific architectural pattern. Patterns are extracted during atlas indexing (e.g., "orchestrator-facade", "TTL-cache", "Supabase-client-singleton"). Use to find files following a convention or antipattern.',
    {
      pattern: z.string().min(1),
      workspace: z.string().optional(),
    },
    async ({ pattern, workspace }: { pattern: string; workspace?: string }) => {
      const ws = workspace ?? runtime.config.workspace;
      const rows = listPatternFiles(runtime.db, ws, pattern);

      if (rows.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No files with pattern "${pattern}" in workspace "${ws}".`,
          }],
        };
      }

      const lines = rows.map((row) =>
        `  📄 ${row.file_path} [${row.cluster ?? 'unknown'}] (${row.loc} LOC)\n     ${row.purpose.slice(0, 120)}`,
      );

      return {
        content: [{
          type: 'text',
          text: `Pattern: "${pattern}" (${rows.length} files)\n\n${lines.join('\n\n')}`,
        }],
      };
    },
  );
}
