import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime, AtlasFileRecord } from '../types.js';
import { toolWithDescription } from './helpers.js';
import { deleteAtlasFile, enqueueReextract, getFilePhase, listAtlasFiles } from '../db.js';
import type { AtlasDatabase } from '../db.js';
import { notifyAtlasContextUpdated } from '../resources/context.js';
import { estimateInitCost, formatUsd, resolveCostProfile, runRuntimeReindex } from '../pipeline/index.js';

const activeReindexes = new Map<string, Promise<void>>();
const reindexStartedAt = new Map<string, Date>();
const reindexFileCount = new Map<string, number>();
const reindexMode = new Map<string, 'full' | 'pass2'>();

// Track last-completed reindex so status checks after a fast run don't
// fall through to the dry-run path with no indication it already ran.
interface ReindexCompletion {
  mode: 'full' | 'pass2';
  succeeded: number;
  failed: number;
  durationMs: number;
  completedAt: Date;
}
const lastCompletion = new Map<string, ReindexCompletion>();

// ── Staleness detection for dry-run reporting ──

function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

interface StaleStats {
  total: number;
  complete: number;
  stale: number;
  staleFiles: string[];
  incomplete: number;
  incompleteFiles: string[];
  pruned: number;
  prunedFiles: string[];
}

function computeStaleStats(
  db: AtlasDatabase,
  workspace: string,
  sourceRoot: string,
  atlasFiles: AtlasFileRecord[],
): StaleStats {
  let complete = 0;
  let stale = 0;
  let incomplete = 0;
  let pruned = 0;
  const staleFiles: string[] = [];
  const incompleteFiles: string[] = [];
  const prunedFiles: string[] = [];

  for (const record of atlasFiles) {
    const absPath = path.join(sourceRoot, record.file_path);
    let currentHash: string;
    try {
      const content = fs.readFileSync(absPath, 'utf8');
      currentHash = hashContent(content);
    } catch {
      // Source file no longer exists — prune the orphaned atlas entry
      deleteAtlasFile(db, workspace, record.file_path);
      pruned++;
      prunedFiles.push(record.file_path);
      continue;
    }

    const phase = getFilePhase(db, workspace, record.file_path, currentHash);
    if (phase === 'pass2') {
      complete++;
    } else if (record.file_hash !== currentHash) {
      stale++;
      staleFiles.push(record.file_path);
    } else {
      incomplete++;
      incompleteFiles.push(record.file_path);
    }
  }

  return { total: atlasFiles.length, complete, stale, staleFiles, incomplete, incompleteFiles, pruned, prunedFiles };
}

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
    // Check if a recent reindex just completed (avoids confusing dry-run
    // output when the user checks right after a fast run finishes).
    const completed = lastCompletion.get(activeWorkspace);
    if (completed) {
      const agoMs = Date.now() - completed.completedAt.getTime();
      // Show completion notice for up to 5 minutes after the run ends
      if (agoMs < 5 * 60 * 1000) {
        const agoSec = Math.round(agoMs / 1000);
        const durationSec = Math.round(completed.durationMs / 1000);
        const modeLabel = completed.mode === 'pass2' ? 'Pass 2 rerun' : 'Reindex';
        lastCompletion.delete(activeWorkspace);
        return {
          content: [{
            type: 'text',
            text: [
              `✅ ${modeLabel} completed ${agoSec}s ago (ran for ${durationSec}s)`,
              `  ${completed.succeeded} succeeded, ${completed.failed} failed`,
              `Provider: ${profile.providerLabel} (${profile.modelLabel})`,
              '',
              'Atlas data is now up-to-date. Use `atlas_query` to explore the refreshed data.',
            ].join('\n'),
          }],
        };
      }
      lastCompletion.delete(activeWorkspace);
    }

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
    // ── Compute staleness for accurate dry-run reporting ──
    if (requestedPhase === 'pass2') {
      // Compute actual phase-level breakdown using getFilePhase, mirroring
      // the pipeline's selectPass2Targets prerequisite check.
      const targetRows = uniqueFiles.length > 0
        ? atlasFiles.filter((file) => uniqueFiles.includes(file.file_path))
        : atlasFiles;
      let alreadyComplete = 0;
      let eligible = 0;
      let missingPrereq = 0;
      for (const record of targetRows) {
        const absPath = path.join(runtime.config.sourceRoot, record.file_path);
        let currentHash: string;
        try {
          const content = fs.readFileSync(absPath, 'utf8');
          currentHash = hashContent(content);
        } catch {
          continue; // source file gone, skip
        }
        const phase = getFilePhase(runtime.db, activeWorkspace, record.file_path, currentHash);
        if (phase === 'pass2') {
          alreadyComplete++;
        } else if (phase === 'pass1' || phase === 'embed') {
          eligible++;
        } else {
          missingPrereq++;
        }
      }

      const lines: string[] = [
        `atlas_reindex dry-run (phase=pass2): ${targetRows.length} total files`,
        `  ✅ ${alreadyComplete} already have cross-refs (will be re-computed)`,
        `  📊 ${eligible} eligible (pass1+ complete, ready for cross-refs)`,
      ];
      if (missingPrereq > 0) {
        lines.push(`  ⚠️  ${missingPrereq} missing prerequisites (need pass1 first, will be skipped)`);
      }
      if (pass2MissingCount > 0) {
        lines.push(`  ❌ ${pass2MissingCount} requested files not found in atlas`);
      }
      const willProcess = alreadyComplete + eligible;
      lines.push(
        `Provider: ${profile.providerLabel} (${profile.modelLabel})`,
        `Mode: pass2-only rerun (cross-refs only, preserves existing extraction fields)`,
        `Requested files: ${uniqueFiles.length > 0 ? uniqueFiles.length : 'all eligible files'}`,
        `Files to process: ${willProcess}`,
        '',
        'Call atlas_reindex with confirm=true and phase="pass2" to rerun cross-refs only.',
        'Pass files=["path/to/file.ts"] with phase="pass2" to limit the rerun.',
      );

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    const stats = computeStaleStats(runtime.db, activeWorkspace, runtime.config.sourceRoot, atlasFiles);
    const needsWork = stats.stale + stats.incomplete;
    const staleEstimate = estimateInitCost(needsWork, profile);
    // Adjust total to reflect pruned orphans
    const effectiveTotal = fileCount - stats.pruned;

    const lines: string[] = [
      `atlas_reindex dry-run: ${effectiveTotal} total files in atlas`,
      `  ✅ ${stats.complete} complete (up-to-date, will be skipped)`,
    ];
    if (stats.stale > 0) {
      lines.push(`  🔄 ${stats.stale} stale (source changed since last extraction)`);
    }
    if (stats.incomplete > 0) {
      lines.push(`  ⚠️  ${stats.incomplete} incomplete (extraction not finished)`);
    }
    if (stats.pruned > 0) {
      lines.push(`  🗑️  ${stats.pruned} orphaned (source deleted, pruned from atlas)`);
    }
    if (needsWork === 0) {
      lines.push(`  🎉 All files are up-to-date — nothing to do.`);
    } else {
      lines.push(`  📊 ${needsWork} file${needsWork === 1 ? '' : 's'} need processing (~${staleEstimate.totalCalls} API calls)`);
    }
    lines.push(`Provider: ${profile.providerLabel} (${profile.modelLabel})`);
    if (needsWork > 0) {
      lines.push(`Estimated cost: ~${formatUsd(staleEstimate.estimatedUsd)}`);
    }
    lines.push('Mode: resume-safe (skip completed files)');
    if (stats.prunedFiles.length > 0 && stats.prunedFiles.length <= 20) {
      lines.push('', 'Pruned orphans:');
      for (const f of stats.prunedFiles) lines.push(`  • ${f}`);
    }
    if (stats.staleFiles.length > 0 && stats.staleFiles.length <= 20) {
      lines.push('', 'Stale files:');
      for (const f of stats.staleFiles) lines.push(`  • ${f}`);
    }
    if (stats.incompleteFiles.length > 0 && stats.incompleteFiles.length <= 20) {
      lines.push('', 'Incomplete files:');
      for (const f of stats.incompleteFiles) lines.push(`  • ${f}`);
    }
    lines.push('', needsWork > 0
      ? 'Call atlas_reindex with confirm=true to proceed.'
      : 'No reindex needed — all extractions are current.',
    );
    if (needsWork > 0) {
      lines.push('Pass files=["path/to/file.ts"] to re-extract specific files instead.');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // ── Mode: full pipeline ──
  if (activeReindexes.has(activeWorkspace)) {
    return {
      content: [{ type: 'text', text: 'A reindex is already in progress.' }],
    };
  }

  // Compute accurate stale count for the start message
  const confirmStats = requestedPhase !== 'pass2'
    ? computeStaleStats(runtime.db, activeWorkspace, runtime.config.sourceRoot, atlasFiles)
    : null;
  const confirmNeedsWork = confirmStats ? confirmStats.stale + confirmStats.incomplete : pass2TargetCount;
  const confirmEstimate = confirmStats ? estimateInitCost(confirmNeedsWork, profile) : estimate;

  const runStartedAt = new Date();
  reindexStartedAt.set(activeWorkspace, runStartedAt);
  reindexFileCount.set(activeWorkspace, requestedPhase === 'pass2' ? pass2TargetCount : confirmNeedsWork);
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
    const succeeded = result.filesProcessed - result.filesFailed;
    console.log(`[atlas-reindex] complete: ${succeeded} succeeded, ${result.filesFailed} failed`);
    lastCompletion.set(activeWorkspace, {
      mode: requestedPhase,
      succeeded,
      failed: result.filesFailed,
      durationMs: Date.now() - runStartedAt.getTime(),
      completedAt: new Date(),
    });
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
            : `Reindex started in background (resume-safe): ${fileCount} total, ${confirmNeedsWork} need processing (~${confirmEstimate.totalCalls} API calls)`,
          `Provider: ${profile.providerLabel} (${profile.modelLabel})`,
          requestedPhase === 'pass2'
            ? 'Mode: pass2-only rerun (cross-refs only)'
            : `Estimated cost: ~${formatUsd(confirmEstimate.estimatedUsd)}`,
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
