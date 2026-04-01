import path from 'node:path';
import { getAtlasFile, listAtlasFiles, openAtlasDatabase, upsertAtlasMeta, upsertEmbedding, upsertFileRecord } from '../db.js';
import type { AtlasProvider, AtlasServerConfig } from '../types.js';
import { createOpenAIProvider } from '../providers/openai.js';
import { createAnthropicProvider } from '../providers/anthropic.js';
import { createOllamaProvider } from '../providers/ollama.js';
import { runPass0, type Pass0FileInfo } from './pass0.js';
import { runPass05 } from './pass05.js';
import { runPass1 } from './pass1.js';
import { runPass2 } from './pass2.js';

function createPipelineProvider(config: AtlasServerConfig): AtlasProvider | undefined {
  if (config.provider === 'anthropic' && config.anthropicApiKey) return createAnthropicProvider(config);
  if (config.provider === 'ollama') return createOllamaProvider(config);
  if (config.openAiApiKey) return createOpenAIProvider(config);
  return undefined;
}

export interface AtlasPipelineConfig extends AtlasServerConfig {
  migrationDir: string;
}

export interface FullPipelineResult {
  workspace: string;
  rootDir: string;
  filesProcessed: number;
  filesFailed: number;
}

const CONCURRENCY = 10;

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
    const progress = createProgressReporter(pass0.files.length);

    const atlasRecords = new Map(listAtlasFiles(db, workspace).map((record) => [record.file_path, record]));
    const blurbs: Record<string, string> = {};
    const extractions: Record<string, Awaited<ReturnType<typeof runPass1>>['files'][string]> = {};
    const crossRefsByFile: Record<string, Awaited<ReturnType<typeof runPass2>>[string]> = {};
    const failedFiles = new Set<string>();

    const markFailure = (filePath: string, error: unknown): void => {
      if (failedFiles.has(filePath)) return;
      failedFiles.add(filePath);
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[atlas-init] failed ${filePath}: ${message}`);
      progress.markFile(filePath, 'failed');
    };

    console.log(`[atlas-init] pass 0.5: batching ${pass0.files.length} files at concurrency ${CONCURRENCY}`);
    await runBatch(pass0.files, CONCURRENCY, async (file) => {
      if (failedFiles.has(file.filePath)) return;
      try {
        progress.setStage('pass 0.5', file.filePath);
        const atlasFile = atlasRecords.get(file.filePath) ?? getAtlasFile(db, workspace, file.filePath);
        if (!atlasFile) {
          throw new Error(`Pass 0 inserted no atlas record for ${file.filePath}`);
        }

        const pass05 = await runPass05({
          db,
          sourceRoot: rootDir,
          workspace,
          provider,
          files: [atlasFile],
        });
        blurbs[file.filePath] = pass05.blurbs[file.filePath] ?? '';
      } catch (error) {
        markFailure(file.filePath, error);
      }
    });

    const pass1Files = pass0.files.filter((file) => !failedFiles.has(file.filePath));
    console.log(`[atlas-init] pass 1: batching ${pass1Files.length} files at concurrency ${CONCURRENCY}`);

    await runBatch(pass1Files, CONCURRENCY, async (file) => {
      if (failedFiles.has(file.filePath)) return;
      try {
        progress.setStage('pass 1', file.filePath);
        const atlasFile = atlasRecords.get(file.filePath) ?? getAtlasFile(db, workspace, file.filePath);
        if (!atlasFile) {
          throw new Error(`Pass 0 inserted no atlas record for ${file.filePath}`);
        }

        const enrichedRecord = {
          ...atlasFile,
          blurb: blurbs[file.filePath] ?? atlasFile.blurb,
        };

        const pass1 = await runPass1({
          db,
          sourceRoot: rootDir,
          workspace,
          provider,
          files: [enrichedRecord],
        });
        const extraction = pass1.files[file.filePath];
        if (!extraction) {
          throw new Error(`Pass 1 returned no extraction for ${file.filePath}`);
        }
        extractions[file.filePath] = extraction;
      } catch (error) {
        markFailure(file.filePath, error);
      }
    });

    const embedFiles = pass1Files.filter((file) => !failedFiles.has(file.filePath) && extractions[file.filePath]);
    console.log(`[atlas-init] embed: batching ${embedFiles.length} files at concurrency ${CONCURRENCY}`);

    await runBatch(embedFiles, CONCURRENCY, async (file) => {
      if (failedFiles.has(file.filePath)) return;
      try {
        progress.setStage('embed', file.filePath);
        const extraction = extractions[file.filePath];
        if (!extraction) {
          throw new Error(`No extraction available for ${file.filePath}`);
        }
        const blurb = blurbs[file.filePath] ?? '';
        const embeddingText = buildEmbeddingText(
          file,
          blurb,
          extraction.purpose,
          extraction.patterns,
          extraction.hazards,
        );
        upsertEmbedding(db, workspace, file.filePath, pseudoEmbedding(embeddingText));
      } catch (error) {
        markFailure(file.filePath, error);
      }
    });

    const pass2Files = embedFiles.filter((file) => !failedFiles.has(file.filePath));
    console.log(`[atlas-init] pass 2: batching ${pass2Files.length} files at concurrency ${CONCURRENCY}`);

    await runBatch(pass2Files, CONCURRENCY, async (file) => {
      if (failedFiles.has(file.filePath)) return;
      try {
        progress.setStage('pass 2', file.filePath);
        const pass2 = await runPass2([file], { sourceRoot: rootDir });
        const crossRefs = pass2[file.filePath] ?? {
          symbols: {},
          total_exports_analyzed: file.exports.length,
          total_cross_references: 0,
        };
        crossRefsByFile[file.filePath] = crossRefs;
      } catch (error) {
        markFailure(file.filePath, error);
      }
    });

    const finalizeFiles = pass2Files.filter((file) => !failedFiles.has(file.filePath) && crossRefsByFile[file.filePath]);
    console.log(`[atlas-init] finalize: batching ${finalizeFiles.length} files at concurrency ${CONCURRENCY}`);

    await runBatch(finalizeFiles, CONCURRENCY, async (file) => {
      if (failedFiles.has(file.filePath)) return;
      try {
        const atlasFile = atlasRecords.get(file.filePath) ?? getAtlasFile(db, workspace, file.filePath);
        const extraction = extractions[file.filePath];
        const crossRefs = crossRefsByFile[file.filePath];
        if (!atlasFile || !extraction || !crossRefs) {
          throw new Error(`Missing final atlas data for ${file.filePath}`);
        }

        progress.setStage('finalize', file.filePath);
        upsertFileRecord(db, {
          ...atlasFile,
          blurb: blurbs[file.filePath] ?? atlasFile.blurb,
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
          extraction_model: provider?.kind ?? 'scaffold',
          last_extracted: new Date().toISOString(),
        });
        progress.markFile(file.filePath, 'ok');
      } catch (error) {
        markFailure(file.filePath, error);
      }
    });

    progress.finish(`${pass0.files.length - failedFiles.size} succeeded, ${failedFiles.size} failed`);
    return {
      workspace,
      rootDir,
      filesProcessed: pass0.files.length,
      filesFailed: failedFiles.size,
    };
  } finally {
    db.close();
  }
}
