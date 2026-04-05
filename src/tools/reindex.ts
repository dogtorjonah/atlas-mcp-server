import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { toolWithDescription } from './helpers.js';
import { enqueueReextract, listAtlasFiles } from '../db.js';
import { notifyAtlasContextUpdated } from '../resources/context.js';
import { estimateInitCost, formatUsd, resolveCostProfile, runRuntimeReindex } from '../pipeline/index.js';

const activeReindexes = new Map<string, Promise<void>>();
const reindexStartedAt = new Map<string, Date>();
const reindexFileCount = new Map<string, number>();
const reindexMode = new Map<string, 'full' | 'pass2'>();

function buildPercentBar(percent: number, width = 18): string {
  const normalized = Math.max(0, Math.min(percent, 100));
  const filled = Math.round((normalized / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(width - filled, 0))}`;
}

function readStatus(sourceRoot: string): null | {
  currentPhase: string;
  phases: Record<string, { total?: number; completed?: number; failed?: number; done?: boolean }>;
} {
  try {
    const raw = fs.readFileSync(path.join(sourceRoot, '.atlas', 'status.json'), 'utf8');
    return JSON.parse(raw) as {
      currentPhase: string;
      phases: Record<string, { total?: number; completed?: number; failed?: number; done?: boolean }>;
    };
  } catch {
    return null;
  }
}

export interface ReindexArgs {
  files?: string[];
  workspace?: string;
  confirm?: boolean;
  phase?: 'pass2';
}

type ReindexResult = { content: Array<{ type: 'text'; text: string }> };

export async function runReindexTool(runtime: AtlasRuntime, {
  files, workspace, confirm, phase,
}: ReindexArgs): Promise<ReindexResult> {
  const activeWorkspace = workspace ?? runtime.config.workspace;
  const requestedPhase = phase ?? 'full';
  if (!runtime.provider && requestedPhase !== 'pass2') {
    return {
      content: [{
        type: 'text',
        text: 'atlas_reindex phase="full" requires a configured provider. Use phase="pass2" for providerless cross-ref recompute.',
      }],
    };
  }
  const uniqueFiles = files ? [...new Set(files.map((f) => f.trim()).filter(Boolean))] : [];

  // ── Mode: flush specific files ──
  if (uniqueFiles.length > 0 && requestedPhase === 'full') {
    for (const filePath of uniqueFiles) {
      enqueueReextract(runtime.db, activeWorkspace, filePath, 'flush');
    }
    await notifyAtlasContextUpdated(runtime.server);
    return {
      content: [
        {
          type: 'text',
          text: `Queued ${uniqueFiles.length} file${uniqueFiles.length === 1 ? '' : 's'} for re-extraction.`,
        },
        {
          type: 'text',
          text: '💡 Run `atlas_admin action=reindex` to check pipeline status.',
        },
      ],
    };
  }

  // ── Mode: dry-run / status ──
  const atlasFiles = listAtlasFiles(runtime.db, activeWorkspace);
  const fileCount = atlasFiles.length;
  const pass2RequestedRows = uniqueFiles.length > 0
    ? atlasFiles.filter((file) => uniqueFiles.includes(file.file_path))
    : atlasFiles;
  const pass2TargetCount = pass2RequestedRows.filter((file) => file.purpose.trim() !== '' && file.extraction_model !== 'scaffold').length;
  const pass2MissingCount = uniqueFiles.length > 0 ? Math.max(uniqueFiles.length - pass2RequestedRows.length, 0) : 0;
  const profile = resolveCostProfile(runtime.config);
  const estimate = estimateInitCost(fileCount, profile);

  if (!confirm) {
    const startedAt = reindexStartedAt.get(activeWorkspace);
    if (activeReindexes.has(activeWorkspace) && startedAt) {
      const elapsed = Math.round((Date.now() - startedAt.getTime()) / 1000);
      const status = readStatus(runtime.config.sourceRoot);
      const activeMode = reindexMode.get(activeWorkspace) ?? 'full';
      if (status) {
        const phaseOrder = ['pass 0.5', 'pass 1', 'embed', 'pass 2'];
        const phaseLabels: Record<string, string> = {
          'pass 0.5': 'Blurbs',
          'pass 1': 'Extraction',
          embed: 'Vectorize',
          'pass 2': 'Cross-refs',
        };
        const normalized = phaseOrder.map((key) => {
          const p = status.phases[key];
          const total = Math.max(0, Number(p?.total ?? 0));
          const completed = Math.max(0, Number(p?.completed ?? 0));
          const failed = Math.max(0, Number(p?.failed ?? 0));
          const processed = Math.min(total, completed + failed);
          const done = Boolean(p?.done) || (total > 0 && processed >= total);
          return { key, total, processed, done };
        });
        const current = normalized.find((p) => p.key === status.currentPhase);
        const phaseUnits = normalized.reduce((sum, p) => {
          if (p.done) return sum + 1;
          if (p.key === status.currentPhase && p.total > 0) {
            return sum + (p.processed / p.total);
          }
          return sum;
        }, 0);
        const overallPercent = activeMode === 'pass2'
          ? Number((((current?.processed ?? 0) / Math.max(current?.total ?? 0, 1)) * 100).toFixed(1))
          : Number(((phaseUnits / phaseOrder.length) * 100).toFixed(1));
        const currentLabel = phaseLabels[status.currentPhase] ?? status.currentPhase;
        const currentPercent = current && current.total > 0
          ? `${((current.processed / current.total) * 100).toFixed(1)}%`
          : '—';
        return {
          content: [{
            type: 'text',
            text: [
              `${activeMode === 'pass2' ? 'Pass 2 rerun' : 'Reindex'} in progress: ${buildPercentBar(overallPercent)} ${overallPercent}%, running for ${elapsed}s`,
              `Phase: ${currentLabel} (${current?.processed ?? 0}/${current?.total ?? 0}, ${currentPercent})`,
              `Target files in current phase: ${current?.total ?? reindexFileCount.get(activeWorkspace) ?? '?'}`,
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
            `${activeMode === 'pass2' ? 'Pass 2 rerun' : 'Reindex'} in progress: ${reindexFileCount.get(activeWorkspace) ?? '?'} files, running for ${elapsed}s`,
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
          requestedPhase === 'pass2'
            ? `atlas_reindex dry-run (phase=pass2): ${pass2TargetCount} eligible file${pass2TargetCount === 1 ? '' : 's'}`
            : `atlas_reindex dry-run: ${fileCount} files (~${estimate.totalCalls} API calls)`,
          `Provider: ${profile.providerLabel} (${profile.modelLabel})`,
          requestedPhase === 'pass2'
            ? 'Mode: pass2-only rerun (cross-refs only, preserves existing extraction fields)'
            : `Estimated cost: ~${formatUsd(estimate.estimatedUsd)}`,
          requestedPhase === 'pass2'
            ? `Requested files: ${uniqueFiles.length > 0 ? uniqueFiles.length : 'all eligible files'}`
            : 'Mode: resume-safe (skip completed files)',
          requestedPhase === 'pass2' && pass2MissingCount > 0
            ? `Missing requested files: ${pass2MissingCount}`
            : '',
          ``,
          requestedPhase === 'pass2'
            ? 'Call atlas_reindex with confirm=true and phase="pass2" to rerun cross-refs only.'
            : 'Call atlas_reindex with confirm=true to proceed.',
          requestedPhase === 'pass2'
            ? 'Pass files=["path/to/file.ts"] with phase="pass2" to limit the rerun.'
            : 'Pass files=["path/to/file.ts"] to re-extract specific files instead.',
        ].filter(Boolean).join('\n'),
      }],
    };
  }

  // ── Mode: full pipeline ──
  if (activeReindexes.has(activeWorkspace)) {
    return {
      content: [{ type: 'text', text: 'A reindex is already in progress.' }],
    };
  }

  reindexStartedAt.set(activeWorkspace, new Date());
  reindexFileCount.set(activeWorkspace, requestedPhase === 'pass2' ? pass2TargetCount : fileCount);
  reindexMode.set(activeWorkspace, requestedPhase);

  activeReindexes.set(activeWorkspace, runRuntimeReindex({
    db: runtime.db,
    workspace: activeWorkspace,
    rootDir: runtime.config.sourceRoot,
    provider: runtime.provider,
    concurrency: runtime.config.concurrency,
    phase: requestedPhase,
    files: uniqueFiles.length > 0 ? uniqueFiles : undefined,
  }).then((result) => {
    console.log(`[atlas-reindex] complete: ${result.filesProcessed - result.filesFailed} succeeded, ${result.filesFailed} failed`);
    notifyAtlasContextUpdated(runtime.server).catch(() => {});
  }).catch((error: unknown) => {
    console.error('[atlas-reindex] failed:', error instanceof Error ? error.message : String(error));
  }).finally(() => {
    activeReindexes.delete(activeWorkspace);
    reindexStartedAt.delete(activeWorkspace);
    reindexFileCount.delete(activeWorkspace);
    reindexMode.delete(activeWorkspace);
  }));

  return {
    content: [
      {
        type: 'text',
        text: [
          requestedPhase === 'pass2'
            ? `Pass 2 rerun started in background: ${pass2TargetCount} eligible file${pass2TargetCount === 1 ? '' : 's'}`
            : `Reindex started in background (resume-safe): ${fileCount} indexed rows (~${estimate.totalCalls} API calls)`,
          `Provider: ${profile.providerLabel} (${profile.modelLabel})`,
          requestedPhase === 'pass2'
            ? 'Mode: pass2-only rerun (cross-refs only)'
            : `Estimated cost: ~${formatUsd(estimate.estimatedUsd)}`,
          `Run atlas_reindex again for live file counts and % progress.`,
          `Atlas context will update when complete.`,
        ].join('\n'),
      },
      {
        type: 'text',
        text: '💡 After the rerun settles, use `atlas_query action=search` to verify the refreshed Atlas data.',
      },
    ],
  };
}

export function registerReindexTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_reindex',
    'Re-run the atlas extraction pipeline. No args = dry-run status. files=["a.ts"] = re-extract specific files. confirm=true = full pipeline (resume-safe). confirm=true + phase="pass2" = recompute cross-references only. The pipeline is resume-safe — safe to kill and restart.',
    {
      files: z.array(z.string().min(1)).optional(),
      workspace: z.string().optional(),
      confirm: z.boolean().optional(),
      phase: z.enum(['pass2']).optional(),
    },
    async (args: ReindexArgs) => runReindexTool(runtime, args),
  );
}
