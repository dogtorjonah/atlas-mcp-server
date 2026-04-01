import path from 'node:path';
import { getAtlasFile, openAtlasDatabase, upsertAtlasMeta, upsertEmbedding, upsertFileRecord } from '../db.js';
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

    let filesFailed = 0;
    for (const file of pass0.files) {
      let status: 'ok' | 'failed' = 'ok';
      try {
        progress.setStage('pass 0.5', file.filePath);
        const atlasFile = getAtlasFile(db, workspace, file.filePath);
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
        const blurb = pass05.blurbs[file.filePath] ?? '';

        progress.setStage('pass 1', file.filePath);
        const pass1 = await runPass1({
          db,
          sourceRoot: rootDir,
          workspace,
          provider,
          files: [atlasFile],
        });
        const extraction = pass1.files[file.filePath];

        if (!extraction) {
          throw new Error(`Pass 1 returned no extraction for ${file.filePath}`);
        }

        progress.setStage('pass 2', file.filePath);
        const pass2 = await runPass2([file], { sourceRoot: rootDir });
        const crossRefs = pass2[file.filePath] ?? {
          symbols: {},
          total_exports_analyzed: file.exports.length,
          total_cross_references: 0,
        };

        const embeddingText = buildEmbeddingText(
          file,
          blurb,
          extraction.purpose,
          extraction.patterns,
          extraction.hazards,
        );

        upsertFileRecord(db, {
          workspace,
          file_path: file.filePath,
          file_hash: file.fileHash,
          cluster: file.cluster,
          loc: file.loc,
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
          language: file.filePath.endsWith('.tsx') ? 'tsx' : 'typescript',
          extraction_model: 'scaffold',
          last_extracted: new Date().toISOString(),
        });

        upsertEmbedding(db, workspace, file.filePath, pseudoEmbedding(embeddingText));
        console.log(`[atlas-init] processed ${file.filePath}`);
      } catch (error) {
        status = 'failed';
        filesFailed += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[atlas-init] failed ${file.filePath}: ${message}`);
      } finally {
        progress.markFile(file.filePath, status);
      }
    }

    progress.finish(`${pass0.files.length - filesFailed} succeeded, ${filesFailed} failed`);
    return {
      workspace,
      rootDir,
      filesProcessed: pass0.files.length,
      filesFailed,
    };
  } finally {
    db.close();
  }
}
