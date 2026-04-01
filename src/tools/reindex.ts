import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { enqueueReextract, listAtlasFiles } from '../db.js';
import { notifyAtlasContextUpdated } from '../resources/context.js';
import { estimateInitCost, formatUsd, resolveCostProfile, runRuntimeReindex } from '../pipeline/index.js';

const activeReindexes = new Map<string, Promise<void>>();
const reindexStartedAt = new Map<string, Date>();
const reindexFileCount = new Map<string, number>();

export function registerReindexTool(server: McpServer, runtime: AtlasRuntime): void {
  server.tool(
    'atlas_reindex',
    {
      files: z.array(z.string().min(1)).optional(),
      workspace: z.string().optional(),
      confirm: z.boolean().optional(),
      force: z.boolean().optional(),
    },
    async ({ files, workspace, confirm, force }: {
      files?: string[];
      workspace?: string;
      confirm?: boolean;
      force?: boolean;
    }) => {
      if (!runtime.provider) {
        return {
          content: [{
            type: 'text',
            text: 'atlas_reindex requires a configured provider. Start the server with API credentials or use init mode first.',
          }],
        };
      }

      const activeWorkspace = workspace ?? runtime.config.workspace;

      // ── Mode: flush specific files ──
      if (files && files.length > 0) {
        const uniqueFiles = [...new Set(files.map((f) => f.trim()).filter(Boolean))];
        const triggerReason = force ? 'flush_force' : 'flush';
        for (const filePath of uniqueFiles) {
          enqueueReextract(runtime.db, activeWorkspace, filePath, triggerReason);
        }
        await notifyAtlasContextUpdated(runtime.server);
        return {
          content: [{
            type: 'text',
            text: `Queued ${uniqueFiles.length} file${uniqueFiles.length === 1 ? '' : 's'} for re-extraction.`,
          }],
        };
      }

      // ── Mode: dry-run / status ──
      const fileCount = listAtlasFiles(runtime.db, activeWorkspace).length;
      const profile = resolveCostProfile(runtime.config);
      const estimate = estimateInitCost(fileCount, profile);

      if (!confirm) {
        const startedAt = reindexStartedAt.get(activeWorkspace);
        if (activeReindexes.has(activeWorkspace) && startedAt) {
          const elapsed = Math.round((Date.now() - startedAt.getTime()) / 1000);
          return {
            content: [{
              type: 'text',
              text: [
                `Reindex in progress: ${reindexFileCount.get(activeWorkspace) ?? '?'} files, running for ${elapsed}s`,
                `Provider: ${profile.providerLabel} (${profile.modelLabel})`,
                `Atlas context will update when complete.`,
              ].join('\n'),
            }],
          };
        }
        return {
          content: [{
            type: 'text',
            text: [
              `atlas_reindex dry-run: ${fileCount} files (~${estimate.totalCalls} API calls)`,
              `Provider: ${profile.providerLabel} (${profile.modelLabel})`,
              `Estimated cost: ~${formatUsd(estimate.estimatedUsd)}`,
              `Mode: ${force ? 'FORCE (re-extract all files, overwrite in-place)' : 'resume-safe (skip completed files)'}`,
              ``,
              `Call atlas_reindex with confirm=true to proceed.`,
              `Pass files=["path/to/file.ts"] to re-extract specific files instead.`,
            ].join('\n'),
          }],
        };
      }

      // ── Mode: full pipeline ──
      if (activeReindexes.has(activeWorkspace)) {
        return {
          content: [{ type: 'text', text: 'A reindex is already in progress.' }],
        };
      }

      const modeLabel = force ? 'force rebuild' : 'resume-safe';
      reindexStartedAt.set(activeWorkspace, new Date());
      reindexFileCount.set(activeWorkspace, fileCount);
      activeReindexes.set(activeWorkspace, runRuntimeReindex({
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
        activeReindexes.delete(activeWorkspace);
        reindexStartedAt.delete(activeWorkspace);
        reindexFileCount.delete(activeWorkspace);
      }));

      return {
        content: [{
          type: 'text',
          text: [
            `Reindex started in background (${modeLabel}): ${fileCount} files (~${estimate.totalCalls} API calls)`,
            `Provider: ${profile.providerLabel} (${profile.modelLabel})`,
            `Estimated cost: ~${formatUsd(estimate.estimatedUsd)}`,
            `Atlas context will update when complete.`,
          ].join('\n'),
        }],
      };
    },
  );
}
