import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { enqueueReextract, rebuildFts } from '../db.js';
import { notifyAtlasContextUpdated } from '../resources/context.js';
import { runPass0 } from '../pipeline/pass0.js';

export function registerReindexTool(server: McpServer, runtime: AtlasRuntime): void {
  server.tool(
    'atlas_reindex',
    {
      filePath: z.string().optional(),
      workspace: z.string().optional(),
    },
    async ({ filePath, workspace }: { filePath?: string; workspace?: string }) => {
      if (!runtime.provider) {
        return {
          content: [{
            type: 'text',
            text: 'atlas_reindex requires a configured provider. Start the server with API credentials or use init mode first.',
          }],
        };
      }

      const activeWorkspace = workspace ?? runtime.config.workspace;

      if (filePath) {
        enqueueReextract(runtime.db, activeWorkspace, filePath, 'manual_reindex');
        await notifyAtlasContextUpdated(runtime.server);
        return {
          content: [{ type: 'text', text: `Queued ${filePath} for re-extraction.` }],
        };
      }

      const pass0 = await runPass0(runtime.config.sourceRoot, activeWorkspace, runtime.db);
      rebuildFts(runtime.db);
      await notifyAtlasContextUpdated(runtime.server);
      return {
        content: [{
          type: 'text',
          text: `Scanned ${pass0.files.length} source files for a full reindex scaffold.`,
        }],
      };
    },
  );
}
