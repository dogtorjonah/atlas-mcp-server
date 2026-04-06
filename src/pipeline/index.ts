import path from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import { getAtlasFile, getFilePhase, listAtlasFiles, openAtlasDatabase, rebuildFts, resetAtlasDatabase, upsertAtlasMeta, upsertFileRecord } from '../db.js';
import type { AtlasCrossRefs, AtlasFileRecord, AtlasServerConfig } from '../types.js';
import { toFileUpsertInput } from './shared.js';
import { runScan, type ScanFileInfo } from './scan.js';
import { persistCrossRefs, runCrossref } from './crossref.js';
import { runStructure } from './structure.js';
import { runFlow } from './flow.js';
import { runCommunityDetection } from './community.js';
import { createPhaseProgressReporter } from './progress.js';

export interface AtlasPipelineConfig extends AtlasServerConfig {
  migrationDir: string;
  skipCostConfirmation?: boolean;
  phase?: 'full' | 'crossref';
  files?: string[];
}

export interface FullPipelineResult {
  workspace: string;
  rootDir: string;
  filesProcessed: number;
  filesFailed: number;
  filesSkipped?: number;
  filesMissing?: number;
  phase?: 'full' | 'crossref';
}

interface BatchPipelineContext {
  db: ReturnType<typeof openAtlasDatabase>;
  workspace: string;
  rootDir: string;
  concurrency: number;
  atlasRecords: Map<string, AtlasFileRecord>;
  failedFiles: Set<string>;
  cancelled: boolean;
  /** When true, skip resume logic and re-process all files from scratch */
  force: boolean;
}

// Heuristic-only phases — semantic fields populated organically via atlas_commit
type BatchPhaseKey = 'structure' | 'flow' | 'crossref' | 'cluster';

async function runBatch<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    await Promise.allSettled(chunk.map(fn));
  }
}

function getAtlasRecord(context: BatchPipelineContext, filePath: string): AtlasFileRecord | null {
  return context.atlasRecords.get(filePath) ?? getAtlasFile(context.db, context.workspace, filePath);
}

function refreshAtlasRecord(context: BatchPipelineContext, filePath: string): AtlasFileRecord {
  context.atlasRecords.delete(filePath);
  const refreshed = getAtlasFile(context.db, context.workspace, filePath);
  if (!refreshed) {
    throw new Error(`Atlas record missing after update: ${filePath}`);
  }
  context.atlasRecords.set(filePath, refreshed);
  return refreshed;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`;
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60).toString().padStart(2, '0');
  return `${minutes}m ${remainder}s`;
}

async function runPhaseBatch(
  phaseKey: BatchPhaseKey,
  label: string,
  files: ScanFileInfo[],
  context: BatchPipelineContext,
  worker: (file: ScanFileInfo) => Promise<void>,
  onProgress?: (event: 'complete' | 'fail') => void,
): Promise<{ failed: number; succeeded: number }> {
  if (files.length === 0) {
    console.log(`[atlas-init] ${label}: no files to process`);
    return { failed: 0, succeeded: 0 };
  }

  const progress = createPhaseProgressReporter([
    {
      key: phaseKey,
      label,
      total: files.length,
    },
  ], {
    singlePhase: true,
  });

  const failed = new Set<string>();
  let succeeded = 0;
  let phaseFailed = 0;
  const phaseStart = Date.now();

  progress.begin(phaseKey);

  await runBatch(files, context.concurrency, async (file) => {
    if (context.cancelled) {
      return;
    }

    try {
      await worker(file);
      succeeded += 1;
      context.failedFiles.delete(file.filePath);
      progress.complete(phaseKey, file.filePath);
      onProgress?.('complete');
    } catch (error) {
      phaseFailed += 1;
      failed.add(file.filePath);
      context.failedFiles.add(file.filePath);
      progress.fail(phaseKey, file.filePath, error instanceof Error ? error.message : String(error));
      onProgress?.('fail');
    }
  });

  const elapsed = formatDuration(Date.now() - phaseStart);
  progress.finish(`${label} complete: ${succeeded} succeeded, ${phaseFailed} failed in ${elapsed}`);
  return { failed: failed.size, succeeded };
}

function buildDefaultCrossRefs(file: ScanFileInfo): AtlasCrossRefs {
  return {
    symbols: {},
    total_exports_analyzed: file.exports.length,
    total_cross_references: 0,
    crossref_model: 'scaffold',
    crossref_timestamp: new Date().toISOString(),
  };
}

/**
 * Phase ordering for resume comparison.
 * 'none' < 'structure' < 'crossref'
 * Legacy phases (summarize, extract, embed) removed — semantic fields now populated
 * organically via atlas_commit as agents work with the codebase.
 */
const PHASE_ORDER = ['none', 'structure', 'crossref'] as const;
type PhaseLevel = (typeof PHASE_ORDER)[number];
interface CrossrefOnlySelection {
  requestedCount: number;
  missingRequested: number;
  skippedPrereq: number;
  eligible: ScanFileInfo[];
}
interface CrossrefOnlyBatchResult {
  failed: number;
  succeeded: number;
  skippedPrereq: number;
  missingRequested: number;
  requestedCount: number;
}

function phaseAtLeast(current: PhaseLevel, target: PhaseLevel): boolean {
  return PHASE_ORDER.indexOf(current) >= PHASE_ORDER.indexOf(target);
}

function selectCrossrefTargets(
  files: ScanFileInfo[],
  filePhases: Map<string, PhaseLevel>,
  requestedFiles?: string[],
): CrossrefOnlySelection {
  const requestedSet = requestedFiles && requestedFiles.length > 0
    ? new Set(requestedFiles.map((file) => file.trim()).filter(Boolean))
    : null;
  const selected = requestedSet
    ? files.filter((file) => requestedSet.has(file.filePath))
    : files;
  const eligible = selected.filter((file) => phaseAtLeast(filePhases.get(file.filePath) ?? 'none', 'structure'));

  return {
    requestedCount: requestedSet?.size ?? files.length,
    missingRequested: requestedSet ? Math.max(requestedSet.size - selected.length, 0) : 0,
    skippedPrereq: selected.length - eligible.length,
    eligible,
  };
}

async function runCrossrefOnlyBatch(
  batchName: string,
  files: ScanFileInfo[],
  context: BatchPipelineContext,
  requestedFiles?: string[],
): Promise<CrossrefOnlyBatchResult> {
  const statusPath = path.join(context.rootDir, '.atlas', 'status.json');
  const startedAt = new Date().toISOString();
  const filePhases = new Map<string, PhaseLevel>();

  for (const file of files) {
    const phase = getFilePhase(context.db, context.workspace, file.filePath, file.fileHash);
    filePhases.set(file.filePath, phase);
  }

  const selection = selectCrossrefTargets(files, filePhases, requestedFiles);
  const counter = {
    total: selection.eligible.length,
    completed: 0,
    failed: 0,
    done: false,
  };
  const writeStatus = (): void => {
    try {
      writeFileSync(statusPath, JSON.stringify({
        currentPhase: 'crossref',
        startedAt,
        mode: 'crossref',
        phases: {
          'crossref': counter,
        },
      }), 'utf8');
    } catch {
      // ignore write failures
    }
  };
  const onProgress = (event: 'complete' | 'fail'): void => {
    if (event === 'complete') counter.completed += 1;
    else counter.failed += 1;
    writeStatus();
  };

  if (selection.eligible.length === 0) {
    try { unlinkSync(statusPath); } catch { /* ignore */ }
    return {
      failed: 0,
      succeeded: 0,
      skippedPrereq: selection.skippedPrereq,
      missingRequested: selection.missingRequested,
      requestedCount: selection.requestedCount,
    };
  }

  console.log(
    `[atlas-init] ${batchName}: crossref-only rerun for ${selection.eligible.length} file(s)`
    + ` (${selection.skippedPrereq} skipped prerequisites, ${selection.missingRequested} missing requested)`,
  );
  writeStatus();

  await runPhaseBatch('crossref', 'Cross-refs', selection.eligible, context, async (file) => {
    const xrefs = await runCrossref([file], {
      sourceRoot: context.rootDir,
      db: context.db,
      workspace: context.workspace,
    });
    const crossRefs = xrefs[file.filePath] ?? buildDefaultCrossRefs(file);
    persistCrossRefs(context.db, context.workspace, file.filePath, crossRefs);
    refreshAtlasRecord(context, file.filePath);
  }, onProgress);
  counter.done = true;
  writeStatus();

  try { unlinkSync(statusPath); } catch { /* ignore */ }

  const batchFailed = selection.eligible.filter((file) => context.failedFiles.has(file.filePath)).length;
  return {
    failed: batchFailed,
    succeeded: selection.eligible.length - batchFailed,
    skippedPrereq: selection.skippedPrereq,
    missingRequested: selection.missingRequested,
    requestedCount: selection.requestedCount,
  };
}

async function runSequentialPipelineBatch(
  batchName: string,
  files: ScanFileInfo[],
  context: BatchPipelineContext,
): Promise<{ failed: number; succeeded: number }> {
  if (files.length === 0) {
    console.log(`[atlas-init] ${batchName}: no files to process`);
    return { failed: 0, succeeded: 0 };
  }

  // Status file — written to .atlas/status.json during pipeline execution
  const statusPath = path.join(context.rootDir, '.atlas', 'status.json');
  const startedAt = new Date().toISOString();

  interface PhaseCounter { total: number; completed: number; failed: number; done: boolean }
  const cStruct: PhaseCounter = { total: 0, completed: 0, failed: 0, done: false };
  const cFlow: PhaseCounter = { total: 0, completed: 0, failed: 0, done: false };
  // Legacy LLM phase counters (c05/summarize, c1/extract, cem/embed) removed —
  // semantic fields now populated organically via atlas_commit
  const c2: PhaseCounter  = { total: 0, completed: 0, failed: 0, done: false };
  const c3: PhaseCounter  = { total: 0, completed: 0, failed: 0, done: false };

  function writeStatus(currentPhase: string): void {
    try {
      writeFileSync(statusPath, JSON.stringify({
        currentPhase, startedAt,
        phases: { 'structure': cStruct, 'flow': cFlow, 'crossref': c2, 'cluster': c3 },
      }), 'utf8');
    } catch { /* ignore write failures */ }
  }

  function makeOnProgress(counter: PhaseCounter, phaseKey: string): (event: 'complete' | 'fail') => void {
    return (event) => {
      if (event === 'complete') counter.completed++;
      else counter.failed++;
      writeStatus(phaseKey);
    };
  }

  // Build resume map: check which phase each file has reached
  const filePhases = new Map<string, PhaseLevel>();
  let skippedTotal = 0;
  if (context.force) {
    console.log(`[atlas-init] ${batchName}: --force supplied, re-processing all ${files.length} files from scratch`);
    for (const file of files) {
      filePhases.set(file.filePath, 'none');
    }
  } else {
    for (const file of files) {
      const phase = getFilePhase(context.db, context.workspace, file.filePath, file.fileHash);
      filePhases.set(file.filePath, phase);
      if (phase === 'crossref') skippedTotal++;
    }
    if (skippedTotal > 0) {
      console.log(`[atlas-init] ${batchName}: resuming — ${skippedTotal}/${files.length} files already complete, skipping`);
    }
  }

  // ---- Pass 0 Structural (deterministic AST analysis) ----
  // Always runs for all non-failed files — it's deterministic, fast (no LLM),
  // and idempotent (deletes + reinserts AST rows per file).
  const structFiles = files.filter((file) => !context.failedFiles.has(file.filePath));
  cStruct.total = structFiles.length;
  writeStatus('structure');
  if (structFiles.length > 0) {
    try {
      const structResult = await runStructure(
        structFiles,
        context.db,
        context.workspace,
        context.rootDir,
      );
      cStruct.completed = structResult.filesProcessed;
      cStruct.failed = structResult.filesSkipped;
      console.log(
        `[atlas-init] ${batchName}/structure: ${structResult.symbolsExtracted} symbols, `
        + `${structResult.edgesExtracted} edges from ${structResult.filesProcessed} files`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[atlas-init] ${batchName}/structure: failed — ${msg}`);
    }
  }
  cStruct.done = true;

  // ---- Pass 0 Flow (deterministic TS/JS flow heuristics) ----
  // Runs immediately after structure so it can reuse the symbol table written there.
  const flowFiles = files.filter((file) => !context.failedFiles.has(file.filePath));
  cFlow.total = flowFiles.length;
  writeStatus('flow');
  if (flowFiles.length > 0) {
    try {
      const flowResult = await runFlow(
        flowFiles,
        context.db,
        context.workspace,
        context.rootDir,
      );
      cFlow.completed = flowResult.filesProcessed;
      cFlow.failed = flowResult.filesSkipped;
      console.log(
        `[atlas-init] ${batchName}/flow: ${flowResult.edgesExtracted} edges from ${flowResult.filesProcessed} files`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[atlas-init] ${batchName}/flow: failed — ${msg}`);
    }
  }
  cFlow.done = true;

  // ---- Legacy LLM phases (summarize, extract, embed) removed ----
  // Semantic fields (purpose, blurb, patterns, hazards, conventions, public_api, key_types)
  // start empty and are populated organically by agents via atlas_commit as they
  // work with the codebase. The agent that just edited or reviewed a file has the
  // freshest understanding — its contribution is higher-quality than a cold extraction.

  const crossrefFiles = files.filter((file) => {
    if (context.failedFiles.has(file.filePath)) return false;
    return !phaseAtLeast(filePhases.get(file.filePath) ?? 'none', 'crossref');
  });
  if (crossrefFiles.length < files.length - context.failedFiles.size) {
    const skipped = files.length - context.failedFiles.size - crossrefFiles.length;
    console.log(`[atlas-init] ${batchName}/cross-refs: skipping ${skipped} already-complete files`);
  }
  c2.total = crossrefFiles.length;
  writeStatus('crossref');
  await runPhaseBatch('crossref', 'Cross-refs', crossrefFiles, context, async (file) => {
    const atlasFile = getAtlasRecord(context, file.filePath);
    if (!atlasFile) {
      throw new Error(`Missing atlas row for ${file.filePath}`);
    }

    const xrefs = await runCrossref([file], {
      sourceRoot: context.rootDir,
      db: context.db,
      workspace: context.workspace,
    });
    const crossRefs = xrefs[file.filePath] ?? buildDefaultCrossRefs(file);

    upsertFileRecord(context.db, toFileUpsertInput(atlasFile, {
      cross_refs: crossRefs,
      extraction_model: 'heuristic',
      last_extracted: new Date().toISOString(),
    }));
    refreshAtlasRecord(context, file.filePath);
  }, makeOnProgress(c2, 'crossref'));
  c2.done = true;

  const clusterFiles = files.length > 0 ? [files[0]!] : [];
  c3.total = clusterFiles.length;
  writeStatus('cluster');
  await runPhaseBatch('cluster', 'Communities', clusterFiles, context, async () => {
    const result = runCommunityDetection(context.db, context.workspace);
    console.log(
      `[atlas-init] ${batchName}/communities: ${result.clustersFound} clusters, `
      + `${result.filesAssigned} files assigned, Q=${result.modularity.toFixed(4)}, `
      + `${result.iterations} iterations`,
    );
  }, makeOnProgress(c3, 'cluster'));
  c3.done = true;

  // Remove status file — pipeline complete
  try { unlinkSync(statusPath); } catch { /* ignore */ }

  const batchFailed = files.filter((file) => context.failedFiles.has(file.filePath)).length;
  return {
    failed: batchFailed,
    succeeded: files.length - batchFailed,
  };
}

export interface RuntimeReindexOptions {
  db: ReturnType<typeof openAtlasDatabase>;
  workspace: string;
  rootDir: string;
  concurrency: number;
  phase?: 'full' | 'crossref';
  files?: string[];
}

export async function runRuntimeReindex(options: RuntimeReindexOptions): Promise<FullPipelineResult> {
  const { db, workspace, rootDir, concurrency } = options;
  const phase = options.phase ?? 'full';

  const scan = await runScan(rootDir, workspace, db);

  const atlasRecords = new Map(
    listAtlasFiles(db, workspace).map((record) => [record.file_path, record] as const),
  );

  const context: BatchPipelineContext = {
    db,
    workspace,
    rootDir,
    concurrency,
    atlasRecords,
    failedFiles: new Set<string>(),
    cancelled: false,
    force: false,
  };

  if (phase === 'crossref') {
    const result = await runCrossrefOnlyBatch('reindex/crossref', scan.files, context, options.files);
    rebuildFts(db);
    return {
      workspace,
      rootDir,
      filesProcessed: result.succeeded + result.failed,
      filesFailed: result.failed,
      filesSkipped: result.skippedPrereq,
      filesMissing: result.missingRequested,
      phase,
    };
  }

  const result = await runSequentialPipelineBatch('reindex', scan.files, context);
  rebuildFts(db);

  return {
    workspace,
    rootDir,
    filesProcessed: scan.files.length,
    filesFailed: result.failed,
    phase,
  };
}

export async function runFullPipeline(projectDir: string, config: AtlasPipelineConfig): Promise<FullPipelineResult> {
  let db = openAtlasDatabase({
    dbPath: config.dbPath,
    migrationDir: config.migrationDir,
    sqliteVecExtension: config.sqliteVecExtension,
  });

  if (config.force) {
    console.log('[atlas-init] --force supplied; deleting existing database and rebuilding from scratch');
    db = resetAtlasDatabase({
      dbPath: config.dbPath,
      migrationDir: config.migrationDir,
      sqliteVecExtension: config.sqliteVecExtension,
    }, db);
  }

  const workspace = config.workspace || path.basename(projectDir).toLowerCase();
  const rootDir = path.resolve(projectDir);
  let cancelled = false;
  let activeContext: BatchPipelineContext | undefined;

  const sigintHandler = (): void => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    if (activeContext) {
      activeContext.cancelled = true;
    }
    console.log('\n[atlas-init] Cancelled. Closing database and exiting with code 130.');
    try {
      db.close();
    } catch {
      // Ignore close errors during shutdown.
    }
    process.exit(130);
  };

  process.once('SIGINT', sigintHandler);

  try {
    console.log(`[atlas-init] workspace=${workspace}`);
    console.log(`[atlas-init] scanning ${rootDir}`);
    upsertAtlasMeta(db, {
      workspace,
      source_root: rootDir,
    });

    console.log('[atlas-init] semantic fields will be populated by agents via atlas_commit');

    const scan = await runScan(rootDir, workspace, db, { force: config.force });
    console.log(`[atlas-init] scan: ${scan.files.length} files, ${scan.importEdges.length} edges`);

    if (config.phase === 'crossref') {
      console.log('[atlas-init] mode: crossref-only rerun');
      const atlasRecords = new Map(
        listAtlasFiles(db, workspace).map((record) => [record.file_path, record] as const),
      );
      const crossrefContext: BatchPipelineContext = {
        db,
        workspace,
        rootDir,
        concurrency: config.concurrency,
        atlasRecords,
        failedFiles: new Set<string>(),
        cancelled,
        force: false,
      };
      activeContext = crossrefContext;

      const crossrefResult = await runCrossrefOnlyBatch('crossref-only', scan.files, crossrefContext, config.files);
      console.log(
        `[atlas-init] crossref-only complete: ${crossrefResult.succeeded} succeeded, ${crossrefResult.failed} failed, `
        + `${crossrefResult.skippedPrereq} skipped prerequisites, ${crossrefResult.missingRequested} missing requested`,
      );
      rebuildFts(db);
      return {
        workspace,
        rootDir,
        filesProcessed: crossrefResult.succeeded + crossrefResult.failed,
        filesFailed: crossrefResult.failed,
        filesSkipped: crossrefResult.skippedPrereq,
        filesMissing: crossrefResult.missingRequested,
        phase: 'crossref',
      };
    }

    // Heuristic-only mode — no API costs, no confirmation needed
    console.log('');
    console.log(`🧠 Atlas — Indexing ${workspace} (heuristic-only)`);
    console.log('');
    console.log(`Found ${scan.files.length} files (Scan complete)`);
    console.log('Heuristic-only indexing — no API costs');
    console.log('Semantic fields (purpose, patterns, hazards) will be populated by agents via atlas_commit');

    const failedFiles = new Set<string>();
    const atlasRecords = new Map(
      listAtlasFiles(db, workspace).map((record) => [record.file_path, record] as const),
    );

    const mainContext: BatchPipelineContext = {
      db,
      workspace,
      rootDir,
      concurrency: config.concurrency,
      atlasRecords,
      failedFiles: new Set<string>(),
      cancelled,
      force: config.force ?? false,
    };
    activeContext = mainContext;

    const mainResult = await runSequentialPipelineBatch('main', scan.files, mainContext);
    console.log(`[atlas-init] main pass complete: ${mainResult.succeeded} succeeded, ${mainResult.failed} failed`);
    failedFiles.clear();
    for (const filePath of mainContext.failedFiles) {
      failedFiles.add(filePath);
    }

    // Empty semantic fields (blurb, purpose, patterns, etc.) are expected after
    // pipeline run. They get populated organically via atlas_commit as agents
    // work with the codebase.

    const finalFailedCount = failedFiles.size;
    console.log(`[atlas-init] final summary: ${scan.files.length - finalFailedCount} succeeded, ${finalFailedCount} failed`);
    return {
      workspace,
      rootDir,
      filesProcessed: scan.files.length,
      filesFailed: finalFailedCount,
    };
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    try {
      db.close();
    } catch {
      // Ignore close errors during shutdown.
    }
  }
}
