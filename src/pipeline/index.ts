import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { getAtlasFile, listAtlasFiles, mapFileRecord, openAtlasDatabase, upsertAtlasMeta, upsertEmbedding, upsertFileRecord } from '../db.js';
import type { AtlasFileRecord, AtlasProvider, AtlasServerConfig } from '../types.js';
import { createOpenAIProvider } from '../providers/openai.js';
import { createAnthropicProvider } from '../providers/anthropic.js';
import { createOllamaProvider } from '../providers/ollama.js';
import { createGeminiProvider } from '../providers/gemini.js';
import { runPass0, type Pass0FileInfo } from './pass0.js';
import { runPass05 } from './pass05.js';
import { runPass1 } from './pass1.js';
import { runPass2 } from './pass2.js';

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
}

export interface FullPipelineResult {
  workspace: string;
  rootDir: string;
  filesProcessed: number;
  filesFailed: number;
}

const CONCURRENCY = 10;
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

function pseudoEmbedding(text: string): number[] {
  const size = 1536;
  const vector = new Array<number>(size);
  let seed = 2166136261;
  for (let i = 0; i < text.length; i++) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }

  let value = seed >>> 0;
  for (let i = 0; i < size; i++) {
    value = Math.imul(value ^ (value >>> 13), 16777619) >>> 0;
    vector[i] = ((value % 2000) / 1000) - 1;
  }
  return vector;
}

function buildEmbeddingText(file: Pass0FileInfo, blurb: string, purpose: string, patterns: string[], hazards: string[]): string {
  return [
    file.filePath,
    file.cluster,
    blurb,
    purpose,
    patterns.join(', '),
    hazards.join(', '),
    file.exports.map((entry) => `${entry.type}:${entry.name}`).join(', '),
  ].filter(Boolean).join('\n');
}

function toPass0FileInfo(record: AtlasFileRecord, rootDir: string): Pass0FileInfo {
  return {
    filePath: record.file_path,
    absolutePath: path.join(rootDir, record.file_path),
    directory: path.dirname(record.file_path).replaceAll(path.sep, '/'),
    cluster: record.cluster ?? 'unknown',
    loc: record.loc,
    fileHash: record.file_hash ?? '',
    imports: [],
    exports: record.exports as Pass0FileInfo['exports'],
  };
}

function createProgressReporter(totalFiles: number) {
  const interactive = process.stdout.isTTY;
  let completed = 0;
  let phase = 'starting';
  let currentFile = '';
  let lastLength = 0;

  const render = (status = '') => {
    const percent = totalFiles > 0 ? Math.floor((completed / totalFiles) * 100) : 100;
    const filePart = currentFile ? `: ${currentFile}` : '';
    const statusPart = status ? ` ${status}` : '';
    const line = `[atlas-init] ${completed}/${totalFiles} (${percent}%) ${phase}${filePart}${statusPart}`;
    if (interactive) {
      const padded = line.padEnd(Math.max(lastLength, line.length));
      process.stdout.write(`\r${padded}`);
      lastLength = padded.length;
    } else {
      console.log(line);
    }
  };

  return {
    setStage(nextPhase: string, filePath?: string): void {
      phase = nextPhase;
      if (filePath) currentFile = filePath;
      render();
    },
    markFile(filePath: string, status: 'ok' | 'failed' = 'ok'): void {
      completed += 1;
      phase = status;
      currentFile = filePath;
      render();
    },
    finish(summary: string): void {
      if (interactive) {
        process.stdout.write('\n');
      }
      console.log(`[atlas-init] ${summary}`);
    },
  };
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function resolveCostProfile(config: AtlasServerConfig): CostProfile {
  if (config.provider === 'anthropic' && config.anthropicApiKey) {
    return {
      providerLabel: 'anthropic',
      modelLabel: 'claude-haiku-4-5-20251001',
      inputUsdPerMillion: 0.80,
      outputUsdPerMillion: 4.00,
      embedInputUsdPerMillion: 0.80,
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

  if (config.openAiApiKey) {
    return {
      providerLabel: 'openai',
      modelLabel: 'gpt-5.4-mini',
      inputUsdPerMillion: 0.15,
      outputUsdPerMillion: 0.60,
      embedInputUsdPerMillion: 0.15,
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

function estimateInitCost(fileCount: number, profile: CostProfile): CostEstimate {
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

interface BatchPipelineContext {
  db: ReturnType<typeof openAtlasDatabase>;
  workspace: string;
  rootDir: string;
  provider?: AtlasProvider;
  atlasRecords: Map<string, AtlasFileRecord>;
  failedFiles: Set<string>;
}

async function runBatchedPasses(
  batchName: string,
  files: Pass0FileInfo[],
  context: BatchPipelineContext,
): Promise<{ failed: number; succeeded: number }> {
  if (files.length === 0) {
    console.log(`[atlas-init] ${batchName}: no files to process`);
    return { failed: 0, succeeded: 0 };
  }

  const progress = createProgressReporter(files.length);
  const batchFailed = new Set<string>();

  const markFailure = (filePath: string, error: unknown): void => {
    if (batchFailed.has(filePath)) return;
    batchFailed.add(filePath);
    context.failedFiles.add(filePath);
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[atlas-init] ${batchName} failed ${filePath}: ${message}`);
    progress.markFile(filePath, 'failed');
  };

  const markRecovered = (filePath: string): void => {
    if (context.failedFiles.delete(filePath)) {
      console.log(`[atlas-init] ${batchName} recovered ${filePath}`);
    }
  };

  console.log(`[atlas-init] ${batchName} pass 0.5: batching ${files.length} files at concurrency ${CONCURRENCY}`);
  await runBatch(files, CONCURRENCY, async (file) => {
    if (batchFailed.has(file.filePath)) return;
    try {
      progress.setStage(`${batchName} pass 0.5`, file.filePath);
      const atlasFile = context.atlasRecords.get(file.filePath) ?? getAtlasFile(context.db, context.workspace, file.filePath);
      if (!atlasFile) {
        throw new Error(`Pass 0 inserted no atlas record for ${file.filePath}`);
      }

      const pass05 = await runPass05({
        db: context.db,
        sourceRoot: context.rootDir,
        workspace: context.workspace,
        provider: context.provider,
        files: [atlasFile],
      });
      const blurb = pass05.blurbs[file.filePath] ?? '';

      const enrichedRecord = {
        ...atlasFile,
        blurb,
      };

      console.log(`[atlas-init] ${batchName} pass 1: ${file.filePath}`);
      const pass1 = await runPass1({
        db: context.db,
        sourceRoot: context.rootDir,
        workspace: context.workspace,
        provider: context.provider,
        files: [enrichedRecord],
      });
      const extraction = pass1.files[file.filePath];
      if (!extraction) {
        throw new Error(`Pass 1 returned no extraction for ${file.filePath}`);
      }

      progress.setStage(`${batchName} embed`, file.filePath);
      const embeddingText = buildEmbeddingText(
        file,
        blurb,
        extraction.purpose,
        extraction.patterns,
        extraction.hazards,
      );
      upsertEmbedding(context.db, context.workspace, file.filePath, pseudoEmbedding(embeddingText));

      progress.setStage(`${batchName} pass 2`, file.filePath);
      const pass2 = await runPass2([file], { sourceRoot: context.rootDir });
      const crossRefs = pass2[file.filePath] ?? {
        symbols: {},
        total_exports_analyzed: file.exports.length,
        total_cross_references: 0,
      };

      progress.setStage(`${batchName} finalize`, file.filePath);
      upsertFileRecord(context.db, {
        ...atlasFile,
        blurb,
        purpose: extraction.purpose,
        public_api: extraction.public_api,
        exports: file.exports,
        patterns: extraction.patterns,
        dependencies: extraction.dependencies,
        data_flows: extraction.data_flows,
        key_types: extraction.key_types,
        hazards: extraction.hazards,
        conventions: extraction.conventions,
        cross_refs: crossRefs,
        extraction_model: context.provider?.kind ?? 'scaffold',
        last_extracted: new Date().toISOString(),
      });

      markRecovered(file.filePath);
      progress.markFile(file.filePath, 'ok');
    } catch (error) {
      markFailure(file.filePath, error);
    }
  });

  progress.finish(`${files.length - batchFailed.size} succeeded, ${batchFailed.size} failed`);
  return {
    failed: batchFailed.size,
    succeeded: files.length - batchFailed.size,
  };
}

export async function runFullPipeline(projectDir: string, config: AtlasPipelineConfig): Promise<FullPipelineResult> {
  const db = openAtlasDatabase({
    dbPath: config.dbPath,
    migrationDir: config.migrationDir,
    sqliteVecExtension: config.sqliteVecExtension,
  });

  try {
    const workspace = config.workspace || path.basename(projectDir).toLowerCase();
    const rootDir = path.resolve(projectDir);

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
        ollamaBaseUrl: config.ollamaBaseUrl,
      },
    });

    const provider = createPipelineProvider(config);
    if (provider) {
      console.log(`[atlas-init] provider: ${provider.kind}`);
    } else {
      console.log('[atlas-init] WARNING: no AI provider configured — using scaffold placeholders');
    }

    const pass0 = await runPass0(rootDir, workspace, db);
    console.log(`[atlas-init] pass0: ${pass0.files.length} files, ${pass0.importEdges.length} edges`);

    const costProfile = resolveCostProfile(config);
    const costEstimate = estimateInitCost(pass0.files.length, costProfile);
    await promptInitConfirmation([
      '',
      '🧠 Atlas — Indexing ' + workspace,
      '',
      `Found ${pass0.files.length} TypeScript files (Pass 0 complete)`,
      `Provider: ${costProfile.providerLabel} (${costProfile.modelLabel})`,
      `Estimated API calls: ${costEstimate.chatCalls} chat + ${costEstimate.embeddingCalls} embeddings`,
      `Estimated cost: ~${formatUsd(costEstimate.estimatedUsd)}`,
    ], config.skipCostConfirmation ?? false);

    const failedFiles = new Set<string>();
    const atlasRecords = new Map(listAtlasFiles(db, workspace).map((record) => [record.file_path, record]));
    const mainResult = await runBatchedPasses(
      'main',
      pass0.files,
      {
        db,
        workspace,
        rootDir,
        provider,
        atlasRecords,
        failedFiles,
      },
    );
    console.log(`[atlas-init] main pass complete: ${mainResult.succeeded} succeeded, ${mainResult.failed} failed`);

    console.log(`[atlas-init] validation: checking for incomplete atlas rows`);
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
      .map(mapFileRecord)
      .map((record) => toPass0FileInfo(record, rootDir));

    if (incompleteFiles.length > 0) {
      console.log(`[atlas-init] rescue pass: ${incompleteFiles.length} incomplete files, re-processing...`);
      const rescueResult = await runBatchedPasses(
        'rescue',
        incompleteFiles,
        {
          db,
          workspace,
          rootDir,
          provider,
          atlasRecords,
          failedFiles,
        },
      );
      console.log(`[atlas-init] rescue pass complete: ${rescueResult.succeeded} succeeded, ${rescueResult.failed} failed`);
    } else {
      console.log('[atlas-init] rescue pass: no incomplete files found');
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
    db.close();
  }
}
