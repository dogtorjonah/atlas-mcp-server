import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type {
  AtlasRepositoryWatcher,
  AtlasRepositoryWatcherOptions,
  AtlasWatchBatcherOptions,
  AtlasWatchChange,
  AtlasWatchScheduler,
} from './types.js';

const DEFAULT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.sql', '.py', '.go', '.rs', '.java',
  '.kt', '.swift', '.vue', '.svelte', '.md',
]);
const IGNORED_DIRECTORIES = new Set([
  '.atlas', '.cache', '.git', '.next', '.nuxt', '.output', '.svelte-kit', '.turbo',
  '.vercel', '.voxxo-swarm', 'build', 'coverage', 'dist', 'node_modules', 'out',
]);

function defaultScheduler(): AtlasWatchScheduler {
  return {
    set: (delayMs, callback) => setTimeout(callback, delayMs),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function canonicalFilePath(filePath: string): string | null {
  const normalized = filePath.normalize('NFC').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    return null;
  }
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return parts.join('/');
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class AtlasWatchBatcher {
  private readonly debounceMs: number;
  private readonly maxBatchSize: number;
  private readonly scheduler: AtlasWatchScheduler;
  private readonly pending = new Map<string, AtlasWatchChange>();
  private timer: unknown;
  private closed = false;
  private flushing = Promise.resolve();

  constructor(
    private readonly onBatch: (changes: AtlasWatchChange[]) => void | Promise<void>,
    options: AtlasWatchBatcherOptions = {},
  ) {
    this.debounceMs = Math.max(0, options.debounceMs ?? 250);
    this.maxBatchSize = Math.max(1, options.maxBatchSize ?? 256);
    this.scheduler = options.scheduler ?? defaultScheduler();
  }

  push(change: AtlasWatchChange): void {
    if (this.closed) return;
    const filePath = canonicalFilePath(change.filePath);
    if (!filePath) return;
    if (change.kind === 'upsert') {
      const previousPath = change.previousPath == null
        ? undefined
        : canonicalFilePath(change.previousPath) ?? undefined;
      if (previousPath && previousPath !== filePath) {
        this.pending.set(previousPath, { kind: 'delete', filePath: previousPath });
      }
      this.pending.set(filePath, {
        kind: 'upsert',
        filePath,
        ...(previousPath && previousPath !== filePath ? { previousPath } : {}),
      });
    } else {
      this.pending.set(filePath, { kind: 'delete', filePath });
    }

    if (this.pending.size >= this.maxBatchSize) {
      this.schedule(0);
    } else {
      this.schedule(this.debounceMs);
    }
  }

  flush(): Promise<void> {
    if (this.timer != null) {
      this.scheduler.clear(this.timer);
      this.timer = undefined;
    }
    if (this.pending.size === 0) return this.flushing;
    const changes = [...this.pending.values()].sort((left, right) =>
      compareStableText(left.filePath, right.filePath) || compareStableText(left.kind, right.kind));
    this.pending.clear();
    this.flushing = this.flushing
      .catch(() => undefined)
      .then(async () => this.onBatch(changes));
    return this.flushing;
  }

  close(): Promise<void> {
    this.closed = true;
    return this.flush();
  }

  private schedule(delayMs: number): void {
    if (this.timer != null) this.scheduler.clear(this.timer);
    this.timer = this.scheduler.set(delayMs, () => {
      this.timer = undefined;
      void this.flush().catch(() => undefined);
    });
  }
}

export async function watchAtlasRepository(
  options: AtlasRepositoryWatcherOptions,
): Promise<AtlasRepositoryWatcher> {
  const sourceRoot = path.resolve(options.sourceRoot);
  const extensions = new Set((options.extensions ?? [...DEFAULT_EXTENSIONS])
    .map((extension) => extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`));
  const watchers = new Map<string, fs.FSWatcher>();
  const knownFiles = new Set<string>();
  const batcher = new AtlasWatchBatcher(options.onBatch, options);
  let closed = false;

  const isIgnored = (absolutePath: string): boolean =>
    path.relative(sourceRoot, absolutePath).split(path.sep)
      .some((part) => IGNORED_DIRECTORIES.has(part));

  const toWorkspacePath = (absolutePath: string): string | null => {
    const relative = path.relative(sourceRoot, absolutePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return canonicalFilePath(relative);
  };

  const observePath = async (absolutePath: string): Promise<void> => {
    if (closed || isIgnored(absolutePath)) return;
    try {
      const metadata = await stat(absolutePath);
      if (metadata.isDirectory()) {
        await registerDirectory(absolutePath, true);
        return;
      }
      if (!metadata.isFile() || !extensions.has(path.extname(absolutePath).toLowerCase())) return;
      const filePath = toWorkspacePath(absolutePath);
      if (filePath) {
        knownFiles.add(filePath);
        batcher.push({ kind: 'upsert', filePath });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
      const filePath = toWorkspacePath(absolutePath);
      if (!filePath) return;
      const deletedFiles = [...knownFiles]
        .filter((known) => known === filePath || known.startsWith(`${filePath}/`))
        .sort();
      if (deletedFiles.length === 0 && extensions.has(path.extname(filePath).toLowerCase())) {
        deletedFiles.push(filePath);
      }
      for (const deleted of deletedFiles) {
        knownFiles.delete(deleted);
        batcher.push({ kind: 'delete', filePath: deleted });
      }
      const directoryPrefix = `${path.resolve(absolutePath)}${path.sep}`;
      for (const [directory, watcher] of watchers) {
        if (directory === path.resolve(absolutePath) || directory.startsWith(directoryPrefix)) {
          watcher.close();
          watchers.delete(directory);
        }
      }
    }
  };

  const registerDirectory = async (directory: string, emitExisting = false): Promise<void> => {
    const absoluteDirectory = path.resolve(directory);
    if (closed || watchers.has(absoluteDirectory) || isIgnored(absoluteDirectory)) return;
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareStableText(left.name, right.name))) {
      const absoluteEntry = path.join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        await registerDirectory(absoluteEntry, emitExisting);
      } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        const filePath = toWorkspacePath(absoluteEntry);
        if (filePath) {
          knownFiles.add(filePath);
          if (emitExisting) batcher.push({ kind: 'upsert', filePath });
        }
      }
    }
    if (closed) return;
    const watcher = fs.watch(absoluteDirectory, (_event, filename) => {
      if (filename) void observePath(path.join(absoluteDirectory, String(filename)));
    });
    watcher.on('error', () => {
      watcher.close();
      watchers.delete(absoluteDirectory);
    });
    watchers.set(absoluteDirectory, watcher);
  };

  await registerDirectory(sourceRoot);
  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      await batcher.close();
    },
  };
}
