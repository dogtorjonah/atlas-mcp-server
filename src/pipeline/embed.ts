import type { AtlasDatabase } from '../db.js';
import { listAtlasFiles, upsertEmbedding } from '../db.js';
import type { AtlasFileRecord, AtlasProvider } from '../types.js';
import { buildEmbeddingInput } from './shared.js';

export interface EmbedResult {
  embeddings: Record<string, number[]>;
}

export interface EmbedOptions {
  db: AtlasDatabase;
  workspace: string;
  provider?: AtlasProvider;
  files?: AtlasFileRecord[];
}

export async function runEmbeddings(options: EmbedOptions): Promise<EmbedResult> {
  const files = options.files ?? listAtlasFiles(options.db, options.workspace);
  const embeddings: Record<string, number[]> = {};

  for (const file of files) {
    const text = buildEmbeddingInput(file);
    if (!text.trim()) {
      continue;
    }

    const embedding = options.provider
      ? await options.provider.embedText(text)
      : Array.from({ length: 1536 }, (_, index) => (((text.charCodeAt(index % text.length || 0) + index) % 2000) / 1000) - 1);
    embeddings[file.file_path] = embedding;
    upsertEmbedding(options.db, options.workspace, file.file_path, embedding);
  }

  return { embeddings };
}
