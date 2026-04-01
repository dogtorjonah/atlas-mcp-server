import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { enqueueReextract, listAtlasFiles } from '../db.js';
import { notifyAtlasContextUpdated } from '../resources/context.js';
import { estimateInitCost, formatUsd, resolveCostProfile, runRuntimeReindex } from '../pipeline/index.js';

let activeReindex: Promise<void> | null = null;

export function registerReindexTool(server: McpServer, runtime: AtlasRuntime): void {
  server.tool(
    'atlas_reindex',
    {
      filePath: z.string().optional(),
      workspace: z.string().optional(),
      confirm: z.boolean().optional(),
    },
    async ({ filePath, workspace, confirm }: { filePath?: string; workspace?: string; confirm?: boolean }) => {
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

      const fileCount = listAtlasFiles(runtime.db, activeWorkspace).length;
      const profile = resolveCostProfile(runtime.config);
      const estimate = estimateInitCost(fileCount, profile);

      if (!confirm) {
        return {
          content: [{
            type: 'text',
            text: [
              `atlas_reindex dry-run: ${fileCount} files (~${estimate.totalCalls} API calls)`,
              `Provider: ${profile.providerLabel} (${profile.modelLabel})`,
              `Estimated cost: ~${formatUsd(estimate.estimatedUsd)}`,
              ``,
              `Call atlas_reindex again with confirm=true to proceed.`,
            ].join('\n'),
          }],
        };
      }

      if (activeReindex) {
        return {
          content: [{ type: 'text', text: 'A reindex is already in progress.' }],
        };
      }

      activeReindex = runRuntimeReindex({
        db: runtime.db,
        workspace: activeWorkspace,
        rootDir: runtime.config.sourceRoot,
        provider: runtime.provider,
        concurrency: runtime.config.concurrency,
      }).then((result) => {
        console.log(`[atlas-reindex] complete: ${result.filesProcessed - result.filesFailed} succeeded, ${result.filesFailed} failed`);
        notifyAtlasContextUpdated(runtime.server).catch(() => {});
      }).catch((error: unknown) => {
        console.error('[atlas-reindex] failed:', error instanceof Error ? error.message : String(error));
      }).finally(() => {
        activeReindex = null;
      });

      return {
        content: [{
          type: 'text',
          text: [
            `Reindex started in background: ${fileCount} files (~${estimate.totalCalls} API calls)`,
            `Provider: ${profile.providerLabel} (${profile.modelLabel})`,
            `Estimated cost: ~${formatUsd(estimate.estimatedUsd)}`,
            `Atlas context will update when complete.`,
          ].join('\n'),
        }],
      };
    },
  );
}
