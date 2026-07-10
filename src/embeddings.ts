import { createHash } from 'node:crypto';
import type {
  AtlasChangelogRecord,
  AtlasDatabase,
  AtlasSourceChunkRecord,
} from './db.js';
import {
  listAllAtlasChangelog,
  listAtlasFiles,
  upsertChangelogEmbedding,
  upsertEmbedding,
  upsertSourceChunkEmbedding,
} from './db.js';
import type { AtlasFileRecord, AtlasServerConfig, AtlasSourceChunk } from './types.js';
import { buildEmbeddingInput } from './pipeline/shared.js';

export const DEFAULT_EMBED_CONFIG = {
  model: 'onnx-community/bge-small-en-v1.5-ONNX',
  dimensions: 384,
  maxInputChars: 8000,
  batchSize: 16,
};

const STANDALONE_EMBEDDINGS_UNAVAILABLE = 'Standalone Atlas does not ship a dense embedding provider yet; search remains BM25/FTS-only.';

export async function embedBatch(_texts: string[], _opts?: unknown): Promise<number[][]> {
  throw new Error(STANDALONE_EMBEDDINGS_UNAVAILABLE);
}

export async function embedQuery(_query: string, _config?: unknown): Promise<number[]> {
  throw new Error(STANDALONE_EMBEDDINGS_UNAVAILABLE);
}

type AtlasEmbeddingConfigSource = Pick<AtlasServerConfig, 'embeddingModel' | 'embeddingDimensions'>;

export type AtlasEmbeddingPhase = 'files' | 'source_chunks' | 'changelog';

export interface AtlasEmbeddingProgressEvent {
  phase: AtlasEmbeddingPhase;
  completed: number;
  total: number;
  skipped: number;
}

type AtlasEmbeddingBackfillConfig = AtlasEmbeddingConfigSource & {
  filePaths?: string[];
  phases?: Array<'files' | 'source_chunks' | 'changelog'>;
  onProgress?: (event: AtlasEmbeddingProgressEvent) => void;
};

const EMBED_HASH_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS atlas_embedding_hashes (
    kind      TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    text_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (kind, target_id)
  )
`;

type EmbedHashKind = 'file' | 'source_chunk' | 'changelog';

function ensureEmbeddingHashTable(db: AtlasDatabase): void {
  db.exec(EMBED_HASH_TABLE_SQL);
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function loadEmbeddingHashes(
  db: AtlasDatabase,
  kind: EmbedHashKind,
): Map<number, string> {
  const rows = db
    .prepare('SELECT target_id, text_hash FROM atlas_embedding_hashes WHERE kind = ?')
    .all(kind) as Array<{ target_id: number; text_hash: string }>;
  const out = new Map<number, string>();
  for (const row of rows) out.set(row.target_id, row.text_hash);
  return out;
}

function recordEmbeddingHashes(
  db: AtlasDatabase,
  kind: EmbedHashKind,
  updates: Array<{ targetId: number; textHash: string }>,
): void {
  if (updates.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO atlas_embedding_hashes (kind, target_id, text_hash, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(kind, target_id) DO UPDATE SET
       text_hash = excluded.text_hash,
       updated_at = excluded.updated_at`,
  );
  for (const item of updates) {
    stmt.run(kind, item.targetId, item.textHash);
  }
}

export function areAtlasEmbeddingsEnabled(): boolean {
  return false;
}

export function getAtlasEmbeddingConfig(config: AtlasEmbeddingConfigSource) {
  return {
    ...DEFAULT_EMBED_CONFIG,
    model: config.embeddingModel ?? DEFAULT_EMBED_CONFIG.model,
    dimensions: config.embeddingDimensions ?? DEFAULT_EMBED_CONFIG.dimensions,
  };
}

export function buildAtlasChangelogEmbeddingInput(changelog: AtlasChangelogRecord): string {
  return [
    changelog.file_path,
    changelog.summary,
    changelog.author_name ?? '',
    changelog.author_engine ?? '',
  ].filter(Boolean).join('\n');
}

export function buildAtlasSourceChunkEmbeddingInput(chunk: AtlasSourceChunk): string {
  return [
    chunk.label,
    chunk.content,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join('\n');
}

export async function embedAtlasQueryText(
  query: string,
  config: AtlasEmbeddingConfigSource,
): Promise<number[]> {
  void query;
  void config;
  const embedding = await embedQuery(query, getAtlasEmbeddingConfig(config));
  return Array.from(embedding);
}

async function embedTexts(
  texts: string[],
  config: AtlasEmbeddingConfigSource,
  onBatchComplete?: (done: number) => void,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!areAtlasEmbeddingsEnabled()) return [];
  const embedConfig = getAtlasEmbeddingConfig(config);
  const { batchSize } = embedConfig;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize);
    const vecs = await embedBatch(slice, { config: embedConfig });
    for (const v of vecs) out.push(Array.from(v));
    onBatchComplete?.(out.length);
  }
  return out;
}

export async function refreshAtlasFileEmbedding(
  db: AtlasDatabase,
  file: AtlasFileRecord,
  config: AtlasEmbeddingConfigSource,
): Promise<void> {
  if (!areAtlasEmbeddingsEnabled()) return;
  const text = buildEmbeddingInput(file);
  const [vector] = await embedTexts([text], config);
  if (vector) {
    upsertEmbedding(db, file.workspace, file.file_path, vector);
  }
}

export async function refreshAtlasSourceChunkEmbeddings(
  db: AtlasDatabase,
  file: AtlasFileRecord,
  chunks: AtlasSourceChunk[],
  config: AtlasEmbeddingConfigSource,
): Promise<void> {
  if (!areAtlasEmbeddingsEnabled()) return;
  ensureEmbeddingHashTable(db);
  const savedHashes = loadEmbeddingHashes(db, 'source_chunk');
  const recordMap = new Map<string, AtlasSourceChunkRecord>();
  const dbChunks = db.prepare(
    `SELECT id, workspace, file_id, file_path, kind, label, start_line AS startLine,
            end_line AS endLine, content, text_hash AS textHash
     FROM atlas_source_chunks
     WHERE file_id = ?`,
  ).all(file.id) as AtlasSourceChunkRecord[];
  for (const c of dbChunks) {
    recordMap.set(`${c.label}:${c.startLine}:${c.endLine}`, c);
  }

  const toEmbed: Array<{ chunk: AtlasSourceChunk; text: string; hash: string; recordId: number }> = [];
  for (const chunk of chunks) {
    const rec = recordMap.get(`${chunk.label}:${chunk.startLine}:${chunk.endLine}`);
    if (!rec) continue;
    const text = buildAtlasSourceChunkEmbeddingInput(chunk);
    const hash = hashText(text);
    if (savedHashes.get(rec.id) === hash) continue;
    toEmbed.push({ chunk, text, hash, recordId: rec.id });
  }

  if (toEmbed.length === 0) return;
  const texts = toEmbed.map((item) => item.text);
  const vectors = await embedTexts(texts, config);
  const hashUpdates: Array<{ targetId: number; textHash: string }> = [];
  for (let i = 0; i < toEmbed.length; i++) {
    const item = toEmbed[i]!;
    const vec = vectors[i];
    if (!vec) continue;
    upsertSourceChunkEmbedding(db, item.recordId, vec);
    hashUpdates.push({ targetId: item.recordId, textHash: item.hash });
  }
  recordEmbeddingHashes(db, 'source_chunk', hashUpdates);
}

export async function refreshAtlasChangelogEmbedding(
  db: AtlasDatabase,
  changelog: AtlasChangelogRecord,
  config: AtlasEmbeddingConfigSource,
): Promise<void> {
  if (!areAtlasEmbeddingsEnabled()) return;
  const text = buildAtlasChangelogEmbeddingInput(changelog);
  const [vector] = await embedTexts([text], config);
  if (vector) {
    upsertChangelogEmbedding(db, changelog.id, vector);
  }
}

export async function backfillAtlasEmbeddings(
  db: AtlasDatabase,
  workspace: string,
  config: AtlasEmbeddingBackfillConfig,
): Promise<void> {
  if (!areAtlasEmbeddingsEnabled()) return;
  ensureEmbeddingHashTable(db);
  const activePhases = new Set(config.phases ?? ['files', 'source_chunks', 'changelog']);

  if (activePhases.has('files')) {
    const files = listAtlasFiles(db, workspace);
    const filtered = config.filePaths
      ? files.filter((f) => config.filePaths!.includes(f.file_path))
      : files;
    const savedHashes = loadEmbeddingHashes(db, 'file');
    const toEmbed: Array<{ file: AtlasFileRecord; text: string; hash: string }> = [];
    for (const file of filtered) {
      const text = buildEmbeddingInput(file);
      const hash = hashText(text);
      if (savedHashes.get(file.id) === hash) continue;
      toEmbed.push({ file, text, hash });
    }

    if (toEmbed.length > 0) {
      const texts = toEmbed.map((item) => item.text);
      let completed = 0;
      const vectors = await embedTexts(texts, config, (done) => {
        completed = done;
        config.onProgress?.({
          phase: 'files',
          completed,
          total: toEmbed.length,
          skipped: files.length - toEmbed.length,
        });
      });

      const hashUpdates: Array<{ targetId: number; textHash: string }> = [];
      for (let i = 0; i < toEmbed.length; i++) {
        const item = toEmbed[i]!;
        const vec = vectors[i];
        if (!vec) continue;
        upsertEmbedding(db, item.file.workspace, item.file.file_path, vec);
        hashUpdates.push({ targetId: item.file.id, textHash: item.hash });
      }
      recordEmbeddingHashes(db, 'file', hashUpdates);
    }
  }

  if (activePhases.has('source_chunks')) {
    const files = listAtlasFiles(db, workspace);
    const filtered = config.filePaths
      ? files.filter((f) => config.filePaths!.includes(f.file_path))
      : files;
    const savedHashes = loadEmbeddingHashes(db, 'source_chunk');
    const toEmbed: Array<{ chunk: AtlasSourceChunk; text: string; hash: string; recordId: number }> = [];

    for (const file of filtered) {
      const fileChunks = db.prepare(
        `SELECT id, workspace, file_id, file_path, kind, label, start_line AS startLine,
                end_line AS endLine, content, text_hash AS textHash
         FROM atlas_source_chunks
         WHERE file_id = ?`,
      ).all(file.id) as AtlasSourceChunkRecord[];
      for (const rec of fileChunks) {
        const chunk: AtlasSourceChunk = {
          kind: rec.kind,
          label: rec.label,
          content: rec.content,
          startLine: rec.startLine,
          endLine: rec.endLine,
          textHash: rec.textHash,
        };
        const text = buildAtlasSourceChunkEmbeddingInput(chunk);
        const hash = hashText(text);
        if (savedHashes.get(rec.id) === hash) continue;
        toEmbed.push({ chunk, text, hash, recordId: rec.id });
      }
    }

    if (toEmbed.length > 0) {
      const texts = toEmbed.map((item) => item.text);
      let completed = 0;
      const vectors = await embedTexts(texts, config, (done) => {
        completed = done;
        config.onProgress?.({
          phase: 'source_chunks',
          completed,
          total: toEmbed.length,
          skipped: 0,
        });
      });

      const hashUpdates: Array<{ targetId: number; textHash: string }> = [];
      for (let i = 0; i < toEmbed.length; i++) {
        const item = toEmbed[i]!;
        const vec = vectors[i];
        if (!vec) continue;
        upsertSourceChunkEmbedding(db, item.recordId, vec);
        hashUpdates.push({ targetId: item.recordId, textHash: item.hash });
      }
      recordEmbeddingHashes(db, 'source_chunk', hashUpdates);
    }
  }

  if (activePhases.has('changelog')) {
    const changelogs = listAllAtlasChangelog(db, workspace);
    const savedHashes = loadEmbeddingHashes(db, 'changelog');
    const toEmbed: Array<{ changelog: AtlasChangelogRecord; text: string; hash: string }> = [];
    for (const c of changelogs) {
      const text = buildAtlasChangelogEmbeddingInput(c);
      const hash = hashText(text);
      if (savedHashes.get(c.id) === hash) continue;
      toEmbed.push({ changelog: c, text, hash });
    }

    if (toEmbed.length > 0) {
      const texts = toEmbed.map((item) => item.text);
      let completed = 0;
      const vectors = await embedTexts(texts, config, (done) => {
        completed = done;
        config.onProgress?.({
          phase: 'changelog',
          completed,
          total: toEmbed.length,
          skipped: changelogs.length - toEmbed.length,
        });
      });

      const hashUpdates: Array<{ targetId: number; textHash: string }> = [];
      for (let i = 0; i < toEmbed.length; i++) {
        const item = toEmbed[i]!;
        const vec = vectors[i];
        if (!vec) continue;
        upsertChangelogEmbedding(db, item.changelog.id, vec);
        hashUpdates.push({ targetId: item.changelog.id, textHash: item.hash });
      }
      recordEmbeddingHashes(db, 'changelog', hashUpdates);
    }
  }
}

export interface ReciprocalRankResult<T> {
  id: string | number;
  item: T;
  source: 'fts' | 'vector';
  score: number;
}

export function fuseReciprocalRankResults<T>(
  fts: ReciprocalRankResult<T>[],
  vector: ReciprocalRankResult<T>[],
  k = 60,
): ReciprocalRankResult<T>[] {
  const scores = new Map<string | number, ReciprocalRankResult<T>>();

  fts.forEach((result, index) => {
    const current = scores.get(result.id);
    scores.set(result.id, {
      id: result.id,
      item: current?.item ?? result.item,
      source: current?.source ?? result.source,
      score: (current?.score ?? 0) + 1 / (k + index + 1),
    });
  });

  vector.forEach((result, index) => {
    const current = scores.get(result.id);
    scores.set(result.id, {
      id: result.id,
      item: current?.item ?? result.item,
      source: current?.source ?? result.source,
      score: (current?.score ?? 0) + 1 / (k + index + 1),
    });
  });

  const ranked = [...scores.values()].sort((left, right) => right.score - left.score);
  const topScore = ranked[0]?.score ?? 0;
  if (topScore <= 0) {
    return ranked;
  }
  return ranked.map((entry) => ({
    ...entry,
    score: entry.score / topScore,
  }));
}
