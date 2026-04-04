import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { writeFileSync, unlinkSync } from 'node:fs';
import { getAtlasFile, getFilePhase, listAtlasFiles, openAtlasDatabase, rebuildFts, resetAtlasDatabase, upsertAtlasMeta, upsertEmbedding, upsertFileRecord } from '../db.js';
import type { AtlasCrossRefs, AtlasFileRecord, AtlasProvider, AtlasServerConfig } from '../types.js';
import { createOpenAIProvider } from '../providers/openai.js';
import { createAnthropicProvider } from '../providers/anthropic.js';
import { createOllamaProvider } from '../providers/ollama.js';
import { createGeminiProvider } from '../providers/gemini.js';
import { buildEmbeddingInput, toFileUpsertInput } from './shared.js';
import { runPass0, type Pass0FileInfo } from './pass0.js';
import { runPass05 } from './pass05.js';
import { runPass1 } from './pass1.js';
import { persistPass2CrossRefs, runPass2 } from './pass2.js';
import { createPhaseProgressReporter } from './progress.js';

function createPipelineProvider(config: AtlasServerConfig): AtlasProvider | undefined {
  if (config.provider === 'anthropic' && config.anthropicApiKey) return createAnthropicProvider(config);
  if (config.provider === 'ollama') return createOllamaProvider(config);
  if (config.provider === 'gemini') return createGeminiProvider(config);
  if (config.openAiApiKey) return createOpenAIProvider(config);
  return undefined;
}

export interface AtlasPipelineConfig extends AtlasServerConfig {
  migrationDir: string;
  skipCostConfirmation?: boolean;
  phase?: 'full' | 'pass2';
  files?: string[];
}

export interface FullPipelineResult {
  workspace: string;
  rootDir: string;
  filesProcessed: number;
  filesFailed: number;
  filesSkipped?: number;
  filesMissing?: number;
  phase?: 'full' | 'pass2';
}

const CHAT_INPUT_TOKENS_PER_CALL = 2000;
const CHAT_OUTPUT_TOKENS_PER_CALL = 500;
const EMBED_INPUT_TOKENS_PER_CALL = 2000;

interface CostProfile {
  providerLabel: string;
  modelLabel: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  embedInputUsdPerMillion: number;
}

interface CostEstimate {
  chatCalls: number;
  embeddingCalls: number;
  totalCalls: number;
  estimatedUsd: number;
}

interface BatchPipelineContext {
  db: ReturnType<typeof openAtlasDatabase>;
  workspace: string;
  rootDir: string;
  concurrency: number;
  provider?: AtlasProvider;
  atlasRecords: Map<string, AtlasFileRecord>;
  failedFiles: Set<string>;
  cancelled: boolean;
  /** When true, skip resume logic and re-process all files from scratch */
  force: boolean;
}

type BatchPhaseKey = 'pass 0.5' | 'pass 1' | 'embed' | 'pass 2';

const RESCUE_TRUNCATION_LIMITS = [6000, 3000] as const;

function pseudoEmbedding(text: string): number[] {
  const size = 1536;
  const vector = new Array<number>(size);
  let seed = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }

  let value = seed >>> 0;
  for (let i = 0; i < size; i += 1) {
    value = Math.imul(value ^ (value >>> 13), 16777619) >>> 0;
    vector[i] = ((value % 2000) / 1000) - 1;
  }
  return vector;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function resolveCostProfile(config: AtlasServerConfig): CostProfile {
  if (config.provider === 'anthropic' && config.anthropicApiKey) {
    return {
      providerLabel: 'anthropic',
      modelLabel: 'claude-haiku-4-5-20251001',
      inputUsdPerMillion: 1.00,
      outputUsdPerMillion: 5.00,
      embedInputUsdPerMillion: 1.00,
    };
  }

  if (config.provider === 'ollama') {
    return {
      providerLabel: 'ollama',
      modelLabel: process.env.ATLAS_OLLAMA_MODEL || process.env.OLLAMA_MODEL || 'llama3.2',
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      embedInputUsdPerMillion: 0,
    };
  }

  if (config.provider === 'gemini' && config.geminiApiKey) {
    return {
      providerLabel: 'gemini',
      modelLabel: 'gemini-3.1-flash',
      inputUsdPerMillion: 0.10,
      outputUsdPerMillion: 0.40,
      embedInputUsdPerMillion: 0.10,
    };
  }

  if (config.openAiApiKey) {
    return {
      providerLabel: 'openai',
      modelLabel: 'gpt-5.4-mini',
      inputUsdPerMillion: 0.75,
      outputUsdPerMillion: 4.50,
      embedInputUsdPerMillion: 0.02,
    };
  }

  return {
    providerLabel: 'scaffold',
    modelLabel: 'scaffold',
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    embedInputUsdPerMillion: 0,
  };
}

export function estimateInitCost(fileCount: number, profile: CostProfile): CostEstimate {
  const chatCalls = fileCount * 3;
  const embeddingCalls = fileCount;
  const chatInputTokens = chatCalls * CHAT_INPUT_TOKENS_PER_CALL;
  const chatOutputTokens = chatCalls * CHAT_OUTPUT_TOKENS_PER_CALL;
  const embedInputTokens = embeddingCalls * EMBED_INPUT_TOKENS_PER_CALL;
  const estimatedUsd =
    (chatInputTokens / 1_000_000) * profile.inputUsdPerMillion +
    (chatOutputTokens / 1_000_000) * profile.outputUsdPerMillion +
    (embedInputTokens / 1_000_000) * profile.embedInputUsdPerMillion;

  return {
    chatCalls,
    embeddingCalls,
    totalCalls: chatCalls + embeddingCalls,
    estimatedUsd,
  };
}

async function promptInitConfirmation(lines: string[], skipConfirmation: boolean): Promise<void> {
  for (const line of lines) {
    console.log(line);
  }

  if (skipConfirmation) {
    console.log('[atlas-init] --yes supplied; continuing without confirmation');
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('[atlas-init] non-interactive stdin detected; continuing with default yes');
    return;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = (await rl.question('Proceed? [Y/n] ')).trim().toLowerCase();
    if (answer === 'n' || answer === 'no') {
      throw new Error('Atlas init cancelled by user');
    }
  } finally {
    rl.close();
  }
}

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

/** Errors where truncating the source text and retrying may help. */
function isRetryableWithTruncation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    // Malformed / truncated JSON from the model
    message.includes('Unexpected end of JSON input') ||
    message.includes('Unexpected token') ||
    message.includes('JSON') ||
    // Context window / token limit overflow
    message.includes('context_length_exceeded') ||
    message.includes('max_tokens') ||
    message.includes('maximum context length') ||
    message.includes('too many tokens') ||
    message.includes('string_above_max_length')
  );
}

/** Transient errors worth retrying at the same size (rate limits, network). */
function isTransientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = message.match(/\b(429|500|502|503|504)\b/);
  return (
    statusMatch !== null ||
    message.includes('rate_limit') ||
    message.includes('Rate limit') ||
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT') ||
    message.includes('fetch failed') ||
    message.includes('network')
  );
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
  files: Pass0FileInfo[],
  context: BatchPipelineContext,
  worker: (file: Pass0FileInfo) => Promise<void>,
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

const TRANSIENT_MAX_RETRIES = 2;
const TRANSIENT_BASE_DELAY_MS = 3000;

async function runRetriableProviderTask(
  filePath: string,
  task: (sourceTextLimit?: number) => Promise<void>,
): Promise<void> {
  let lastError: unknown;
  const sourceTextLimits = [undefined, ...RESCUE_TRUNCATION_LIMITS] as const;

  for (let index = 0; index < sourceTextLimits.length; index += 1) {
    const sourceTextLimit = sourceTextLimits[index];

    // Each truncation level gets its own transient-retry budget
    for (let transientAttempt = 0; transientAttempt <= TRANSIENT_MAX_RETRIES; transientAttempt += 1) {
      try {
        await task(sourceTextLimit);
        return;
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);

        // Transient error (rate limit, network) — retry same size after backoff
        if (transientAttempt < TRANSIENT_MAX_RETRIES && isTransientError(error)) {
          const delay = TRANSIENT_BASE_DELAY_MS * (transientAttempt + 1);
          console.log(`[atlas-init] ${filePath}: transient error (${msg.slice(0, 80)}), retrying in ${delay}ms`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // Truncation-retryable error — try with smaller source text
        const nextSourceTextLimit = sourceTextLimits[index + 1];
        if (isRetryableWithTruncation(error) && nextSourceTextLimit !== undefined) {
          console.log(`[atlas-init] ${filePath}: ${msg.slice(0, 80)} — retrying with source text limit ${nextSourceTextLimit}`);
          break; // break inner loop, continue outer with next truncation level
        }

        // Non-retryable — give up
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function buildDefaultCrossRefs(file: Pass0FileInfo): AtlasCrossRefs {
  return {
    symbols: {},
    total_exports_analyzed: file.exports.length,
    total_cross_references: 0,
    pass2_model: 'scaffold',
    pass2_timestamp: new Date().toISOString(),
  };
}

/**
 * Phase ordering for resume comparison.
 * 'none' < 'pass05' < 'pass1' < 'embed' < 'pass2'
 */
const PHASE_ORDER = ['none', 'pass05', 'pass1', 'embed', 'pass2'] as const;
type PhaseLevel = (typeof PHASE_ORDER)[number];
interface Pass2OnlySelection {
  requestedCount: number;
  missingRequested: number;
  skippedPrereq: number;
  eligible: Pass0FileInfo[];
}
interface Pass2OnlyBatchResult {
  failed: number;
  succeeded: number;
  skippedPrereq: number;
  missingRequested: number;
  requestedCount: number;
}

function phaseAtLeast(current: PhaseLevel, target: PhaseLevel): boolean {
  return PHASE_ORDER.indexOf(current) >= PHASE_ORDER.indexOf(target);
}

function selectPass2Targets(
  files: Pass0FileInfo[],
  filePhases: Map<string, PhaseLevel>,
  requestedFiles?: string[],
): Pass2OnlySelection {
  const requestedSet = requestedFiles && requestedFiles.length > 0
    ? new Set(requestedFiles.map((file) => file.trim()).filter(Boolean))
    : null;
  const selected = requestedSet
    ? files.filter((file) => requestedSet.has(file.filePath))
    : files;
  const eligible = selected.filter((file) => phaseAtLeast(filePhases.get(file.filePath) ?? 'none', 'pass1'));

  return {
    requestedCount: requestedSet?.size ?? files.length,
    missingRequested: requestedSet ? Math.max(requestedSet.size - selected.length, 0) : 0,
    skippedPrereq: selected.length - eligible.length,
    eligible,
  };
}

async function runPass2OnlyBatch(
  batchName: string,
  files: Pass0FileInfo[],
  context: BatchPipelineContext,
  requestedFiles?: string[],
): Promise<Pass2OnlyBatchResult> {
  const statusPath = path.join(context.rootDir, '.atlas', 'status.json');
  const startedAt = new Date().toISOString();
  const filePhases = new Map<string, PhaseLevel>();

  for (const file of files) {
    const phase = getFilePhase(context.db, context.workspace, file.filePath, file.fileHash);
    filePhases.set(file.filePath, phase);
  }

  const selection = selectPass2Targets(files, filePhases, requestedFiles);
  const counter = {
    total: selection.eligible.length,
    completed: 0,
    failed: 0,
    done: false,
  };
  const writeStatus = (): void => {
    try {
      writeFileSync(statusPath, JSON.stringify({
        currentPhase: 'pass 2',
        startedAt,
        mode: 'pass2',
        phases: {
          'pass 0.5': { total: 0, completed: 0, failed: 0, done: true },
          'pass 1': { total: 0, completed: 0, failed: 0, done: true },
          embed: { total: 0, completed: 0, failed: 0, done: true },
          'pass 2': counter,
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
    `[atlas-init] ${batchName}: pass2-only rerun for ${selection.eligible.length} file(s)`
    + ` (${selection.skippedPrereq} skipped prerequisites, ${selection.missingRequested} missing requested)`,
  );
  writeStatus();

  await runPhaseBatch('pass 2', 'Cross-refs', selection.eligible, context, async (file) => {
    const pass2 = await runPass2([file], {
      sourceRoot: context.rootDir,
      provider: context.provider,
      db: context.db,
      workspace: context.workspace,
    });
    const crossRefs = pass2[file.filePath] ?? buildDefaultCrossRefs(file);
    persistPass2CrossRefs(context.db, context.workspace, file.filePath, crossRefs);
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
  files: Pass0FileInfo[],
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
  const c05: PhaseCounter = { total: 0, completed: 0, failed: 0, done: false };
  const c1: PhaseCounter  = { total: 0, completed: 0, failed: 0, done: false };
  const cem: PhaseCounter = { total: 0, completed: 0, failed: 0, done: false };
  const c2: PhaseCounter  = { total: 0, completed: 0, failed: 0, done: false };

  function writeStatus(currentPhase: string): void {
    try {
      writeFileSync(statusPath, JSON.stringify({
        currentPhase, startedAt,
        phases: { 'pass 0.5': c05, 'pass 1': c1, 'embed': cem, 'pass 2': c2 },
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
      if (phase === 'pass2') skippedTotal++;
    }
    if (skippedTotal > 0) {
      console.log(`[atlas-init] ${batchName}: resuming — ${skippedTotal}/${files.length} files already complete, skipping`);
    }
  }

  const pass05Files = files.filter((file) => {
    if (context.failedFiles.has(file.filePath)) return false;
    // Skip if this file already completed pass05 or later
    return !phaseAtLeast(filePhases.get(file.filePath) ?? 'none', 'pass05');
  });
  if (pass05Files.length < files.length - context.failedFiles.size) {
    const skipped = files.length - context.failedFiles.size - pass05Files.length;
    console.log(`[atlas-init] ${batchName}/blurbs: skipping ${skipped} already-complete files`);
  }
  c05.total = pass05Files.length;
  writeStatus('pass 0.5');
  await runPhaseBatch('pass 0.5', 'Blurbs', pass05Files, context, async (file) => {
    const atlasFile = getAtlasRecord(context, file.filePath);
    if (!atlasFile) {
      throw new Error(`Missing atlas row for ${file.filePath}`);
    }

    await runRetriableProviderTask(file.filePath, async (sourceTextLimit) => {
      await runPass05({
        db: context.db,
        sourceRoot: context.rootDir,
        workspace: context.workspace,
        provider: context.provider,
        files: [atlasFile],
        sourceTextLimit,
      });
    });

    refreshAtlasRecord(context, file.filePath);
  }, makeOnProgress(c05, 'pass 0.5'));
  c05.done = true;

  const pass1Files = files.filter((file) => {
    if (context.failedFiles.has(file.filePath)) return false;
    return !phaseAtLeast(filePhases.get(file.filePath) ?? 'none', 'pass1');
  });
  if (pass1Files.length < files.length - context.failedFiles.size) {
    const skipped = files.length - context.failedFiles.size - pass1Files.length;
    console.log(`[atlas-init] ${batchName}/extraction: skipping ${skipped} already-complete files`);
  }
  c1.total = pass1Files.length;
  writeStatus('pass 1');
  await runPhaseBatch('pass 1', 'Extraction', pass1Files, context, async (file) => {
    const atlasFile = getAtlasRecord(context, file.filePath);
    if (!atlasFile) {
      throw new Error(`Missing atlas row for ${file.filePath}`);
    }

    await runRetriableProviderTask(file.filePath, async (sourceTextLimit) => {
      await runPass1({
        db: context.db,
        sourceRoot: context.rootDir,
        workspace: context.workspace,
        provider: context.provider,
        files: [atlasFile],
        sourceTextLimit,
      });
    });

    refreshAtlasRecord(context, file.filePath);
  }, makeOnProgress(c1, 'pass 1'));
  c1.done = true;

  const embedFiles = files.filter((file) => {
    if (context.failedFiles.has(file.filePath)) return false;
    // Note: embed doesn't have a clean "done" check in the DB, so we only skip
    // files that reached pass2 (which implies embed was done)
    return !phaseAtLeast(filePhases.get(file.filePath) ?? 'none', 'pass2');
  });
  if (embedFiles.length < files.length - context.failedFiles.size) {
    const skipped = files.length - context.failedFiles.size - embedFiles.length;
    console.log(`[atlas-init] ${batchName}/embed: skipping ${skipped} already-complete files`);
  }
  cem.total = embedFiles.length;
  writeStatus('embed');
  await runPhaseBatch('embed', 'Vectorize', embedFiles, context, async (file) => {
    const atlasFile = getAtlasRecord(context, file.filePath);
    if (!atlasFile) {
      throw new Error(`Missing atlas row for ${file.filePath}`);
    }

    const embeddingInput = buildEmbeddingInput(atlasFile);
    const embedding = context.provider
      ? await context.provider.embedText(embeddingInput)
      : pseudoEmbedding(embeddingInput);

    upsertEmbedding(context.db, context.workspace, file.filePath, embedding);
    refreshAtlasRecord(context, file.filePath);
  }, makeOnProgress(cem, 'embed'));
  cem.done = true;

  const pass2Files = files.filter((file) => {
    if (context.failedFiles.has(file.filePath)) return false;
    return !phaseAtLeast(filePhases.get(file.filePath) ?? 'none', 'pass2');
  });
  if (pass2Files.length < files.length - context.failedFiles.size) {
    const skipped = files.length - context.failedFiles.size - pass2Files.length;
    console.log(`[atlas-init] ${batchName}/cross-refs: skipping ${skipped} already-complete files`);
  }
  c2.total = pass2Files.length;
  writeStatus('pass 2');
  await runPhaseBatch('pass 2', 'Cross-refs', pass2Files, context, async (file) => {
    const atlasFile = getAtlasRecord(context, file.filePath);
    if (!atlasFile) {
      throw new Error(`Missing atlas row for ${file.filePath}`);
    }

    const pass2 = await runPass2([file], {
      sourceRoot: context.rootDir,
      provider: context.provider,
      db: context.db,
      workspace: context.workspace,
    });
    const crossRefs = pass2[file.filePath] ?? buildDefaultCrossRefs(file);

    upsertFileRecord(context.db, toFileUpsertInput(atlasFile, {
      cross_refs: crossRefs,
      extraction_model: context.provider?.kind ?? atlasFile.extraction_model ?? 'scaffold',
      last_extracted: new Date().toISOString(),
    }));
    refreshAtlasRecord(context, file.filePath);
  }, makeOnProgress(c2, 'pass 2'));
  c2.done = true;

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
  provider?: AtlasProvider;
  concurrency: number;
  phase?: 'full' | 'pass2';
  files?: string[];
}

export async function runRuntimeReindex(options: RuntimeReindexOptions): Promise<FullPipelineResult> {
  const { db, workspace, rootDir, provider, concurrency } = options;
  const phase = options.phase ?? 'full';

  const pass0 = await runPass0(rootDir, workspace, db);

  const atlasRecords = new Map(
    listAtlasFiles(db, workspace).map((record) => [record.file_path, record] as const),
  );

  const context: BatchPipelineContext = {
    db,
    workspace,
    rootDir,
    concurrency,
    provider,
    atlasRecords,
    failedFiles: new Set<string>(),
    cancelled: false,
    force: false,
  };

  if (phase === 'pass2') {
    const result = await runPass2OnlyBatch('reindex/pass2', pass0.files, context, options.files);
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

  const result = await runSequentialPipelineBatch('reindex', pass0.files, context);
  rebuildFts(db);

  return {
    workspace,
    rootDir,
    filesProcessed: pass0.files.length,
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
      provider: config.provider,
      provider_config: {
        openAiApiKey: Boolean(config.openAiApiKey),
        anthropicApiKey: Boolean(config.anthropicApiKey),
        geminiApiKey: Boolean(config.geminiApiKey),
        voyageApiKey: Boolean(config.voyageApiKey),
        ollamaBaseUrl: config.ollamaBaseUrl,
      },
    });

    const provider = createPipelineProvider(config);
    if (provider) {
      console.log(`[atlas-init] provider: ${provider.kind}`);
    } else {
      console.log('[atlas-init] WARNING: no AI provider configured — using scaffold placeholders');
    }

    const pass0 = await runPass0(rootDir, workspace, db, { force: config.force });
    console.log(`[atlas-init] pass0: ${pass0.files.length} files, ${pass0.importEdges.length} edges`);

    if (config.phase === 'pass2') {
      console.log('[atlas-init] mode: pass2-only rerun');
      const atlasRecords = new Map(
        listAtlasFiles(db, workspace).map((record) => [record.file_path, record] as const),
      );
      const pass2Context: BatchPipelineContext = {
        db,
        workspace,
        rootDir,
        concurrency: config.concurrency,
        provider,
        atlasRecords,
        failedFiles: new Set<string>(),
        cancelled,
        force: false,
      };
      activeContext = pass2Context;

      const pass2Result = await runPass2OnlyBatch('pass2-only', pass0.files, pass2Context, config.files);
      console.log(
        `[atlas-init] pass2-only complete: ${pass2Result.succeeded} succeeded, ${pass2Result.failed} failed, `
        + `${pass2Result.skippedPrereq} skipped prerequisites, ${pass2Result.missingRequested} missing requested`,
      );
      rebuildFts(db);
      return {
        workspace,
        rootDir,
        filesProcessed: pass2Result.succeeded + pass2Result.failed,
        filesFailed: pass2Result.failed,
        filesSkipped: pass2Result.skippedPrereq,
        filesMissing: pass2Result.missingRequested,
        phase: 'pass2',
      };
    }

    const costProfile = resolveCostProfile(config);
    const costEstimate = estimateInitCost(pass0.files.length, costProfile);
    await promptInitConfirmation([
      '',
      `🧠 Atlas — Indexing ${workspace}`,
      '',
      `Found ${pass0.files.length} TypeScript files (Pass 0 complete)`,
      `Provider: ${costProfile.providerLabel} (${costProfile.modelLabel})`,
      `Estimated API calls: ${costEstimate.chatCalls} chat + ${costEstimate.embeddingCalls} embeddings`,
      `Estimated cost: ~${formatUsd(costEstimate.estimatedUsd)}`,
    ], config.skipCostConfirmation ?? false);

    const failedFiles = new Set<string>();
    const atlasRecords = new Map(
      listAtlasFiles(db, workspace).map((record) => [record.file_path, record] as const),
    );

    const mainContext: BatchPipelineContext = {
      db,
      workspace,
      rootDir,
      concurrency: config.concurrency,
      provider,
      atlasRecords,
      failedFiles: new Set<string>(),
      cancelled,
      force: config.force ?? false,
    };
    activeContext = mainContext;

    const mainResult = await runSequentialPipelineBatch('main', pass0.files, mainContext);
    console.log(`[atlas-init] main pass complete: ${mainResult.succeeded} succeeded, ${mainResult.failed} failed`);
    failedFiles.clear();
    for (const filePath of mainContext.failedFiles) {
      failedFiles.add(filePath);
    }

    if (config.force) {
      console.log('[atlas-init] validation/rescue: skipped because --force was supplied');
    } else {
      console.log('[atlas-init] validation: checking for incomplete atlas rows');
      const incompleteRows = db.prepare(
        `SELECT *
         FROM atlas_files
         WHERE workspace = ?
           AND (
             coalesce(blurb, '') = ''
             OR coalesce(purpose, '') = ''
             OR extraction_model = 'scaffold'
           )
         ORDER BY file_path ASC`,
      ).all(workspace) as Record<string, unknown>[];

      const incompleteFiles = incompleteRows
        .map((row) => getAtlasFile(db, workspace, String(row.file_path ?? '')))
        .filter((record): record is AtlasFileRecord => record !== null)
        .map((record) => ({
          filePath: record.file_path,
          absolutePath: path.join(rootDir, record.file_path),
          directory: path.dirname(record.file_path).replaceAll(path.sep, '/'),
          cluster: record.cluster ?? 'unknown',
          loc: record.loc,
          fileHash: record.file_hash ?? '',
          imports: [] as string[],
          exports: record.exports as Pass0FileInfo['exports'],
        } satisfies Pass0FileInfo));

      if (incompleteFiles.length > 0) {
        console.log(`[atlas-init] rescue pass: ${incompleteFiles.length} incomplete files, re-processing...`);
        const rescueContext: BatchPipelineContext = {
          db,
          workspace,
          rootDir,
          concurrency: config.concurrency,
          provider,
          atlasRecords,
          failedFiles: new Set<string>(),
          cancelled,
          force: false, // rescue pass never forces — it's already targeting incomplete files
        };
        activeContext = rescueContext;
        const rescueResult = await runSequentialPipelineBatch('rescue', incompleteFiles, rescueContext);
        console.log(`[atlas-init] rescue pass complete: ${rescueResult.succeeded} succeeded, ${rescueResult.failed} failed`);
        for (const file of incompleteFiles) {
          if (rescueContext.failedFiles.has(file.filePath)) {
            failedFiles.add(file.filePath);
          } else {
            failedFiles.delete(file.filePath);
          }
        }
      } else {
        console.log('[atlas-init] rescue pass: no incomplete files found');
      }
    }

    const finalFailedCount = failedFiles.size;
    console.log(`[atlas-init] final summary: ${pass0.files.length - finalFailedCount} succeeded, ${finalFailedCount} failed`);
    return {
      workspace,
      rootDir,
      filesProcessed: pass0.files.length,
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
