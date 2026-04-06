/**
 * Legacy: LLM embedding phase.
 *
 * This module is retained for optional future use when an LLM provider is configured.
 * In heuristic-only mode (no API key), the pipeline skips embedding entirely —
 * search uses BM25 (FTS5) which requires no vector embeddings. Embeddings can be
 * populated later via atlas_commit or by re-running init with a provider configured.
 */
import type { AtlasDatabase } from '../db.js';
import { listAtlasFiles, upsertEmbedding } from '../db.js';
import type { AtlasFileRecord, AtlasProvider } from '../types.js';
import { buildEmbeddingInput } from './shared.js';

export interface EmbedResult {
  embeddings: Record<string, number[]>;
  strategy: 'provider' | 'pseudo';
  processed: number;
  skipped: number;
}

export interface EmbedProgressEvent {
  phase: 'embed';
  status: 'start' | 'complete';
  filePath: string;
  index: number;
  total: number;
  strategy: 'provider' | 'pseudo';
}

export interface EmbedOptions {
  db: AtlasDatabase;
  workspace: string;
  provider?: AtlasProvider;
  files?: AtlasFileRecord[];
  onProgress?: (event: EmbedProgressEvent) => void;
}

export async function runEmbeddings(options: EmbedOptions): Promise<EmbedResult> {
  const files = options.files ?? listAtlasFiles(options.db, options.workspace);
  const embeddings: Record<string, number[]> = {};
  const strategy = options.provider ? 'provider' : 'pseudo';
  let processed = 0;
  let skipped = 0;

  for (const [index, file] of files.entries()) {
    const text = buildEmbeddingInput(file);
    if (!text.trim()) {
      skipped += 1;
      continue;
    }

    options.onProgress?.({
      phase: 'embed',
      status: 'start',
      filePath: file.file_path,
      index,
      total: files.length,
      strategy,
    });

    const embedding = options.provider
      ? await options.provider.embedText(text)
      : Array.from({ length: 1536 }, (_, index) => (((text.charCodeAt(index % text.length || 0) + index) % 2000) / 1000) - 1);
    embeddings[file.file_path] = embedding;
    upsertEmbedding(options.db, options.workspace, file.file_path, embedding);
    processed += 1;

    options.onProgress?.({
      phase: 'embed',
      status: 'complete',
      filePath: file.file_path,
      index,
      total: files.length,
      strategy,
    });
  }

  return {
    embeddings,
    strategy,
    processed,
    skipped,
  };
}
