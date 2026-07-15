export type AtlasIndexMode = 'full' | 'incremental' | 'repair';

export interface AtlasIndexRepositoryRequest {
  workspace: string;
  sourceRoot: string;
  mode?: AtlasIndexMode;
  concurrency?: number;
  /** Fixed ISO clock used by deterministic fixtures and reproducible indexing runs. */
  now?: string;
  paths?: readonly string[];
  phase?: 'full' | 'crossref';
}

export type AtlasIndexFailureStage = 'scan' | 'parse' | 'flow' | 'crossref' | 'repair';

export interface AtlasIndexFailure {
  filePath: string;
  stage: AtlasIndexFailureStage;
  message: string;
}

export interface AtlasIndexFreshnessEvidence {
  scanFingerprint: string;
  currentFiles: number;
  importEdges: number;
  changedFileCount: number;
  deletedFileCount: number;
  invalidatedFileCount: number;
  changedFiles: string[];
  deletedFiles: string[];
  invalidatedFiles: string[];
  pathsTruncated: boolean;
  staleRecords: number;
  complete: boolean;
}

export interface AtlasIndexRepositoryResult {
  workspace: string;
  rootDir: string;
  mode: AtlasIndexMode;
  filesProcessed: number;
  filesFailed: number;
  filesSkipped: number;
  failures: AtlasIndexFailure[];
  failuresTruncated: boolean;
  freshness: AtlasIndexFreshnessEvidence;
}

export type AtlasWatchChange =
  | { kind: 'upsert'; filePath: string; previousPath?: string }
  | { kind: 'delete'; filePath: string };

export interface AtlasWatchScheduler {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

export interface AtlasWatchBatcherOptions {
  debounceMs?: number;
  maxBatchSize?: number;
  scheduler?: AtlasWatchScheduler;
}

export interface AtlasRepositoryWatcherOptions extends AtlasWatchBatcherOptions {
  sourceRoot: string;
  onBatch: (changes: AtlasWatchChange[]) => void | Promise<void>;
  extensions?: string[];
}

export interface AtlasRepositoryWatcher {
  close(): Promise<void>;
}
