import { getAtlasCoreMigrationsDir } from '../paths.js';
import { openSqliteAtlasStore, type SqliteAtlasStore } from '../persistence/index.js';
import { AtlasService } from '../service/index.js';
import {
  initializeAtlasNodeLayout,
  type AtlasNodeLayout,
  type AtlasNodeLayoutOptions,
} from './layout.js';

export interface OpenAtlasNodeHostOptions extends AtlasNodeLayoutOptions {
  migrationDir?: string;
  concurrency?: number;
  startupTimeoutMs?: number;
  sqliteVecExtension?: string;
  embeddingDimensions?: number;
}

export interface AtlasNodeHost {
  layout: AtlasNodeLayout;
  store: SqliteAtlasStore;
  service: AtlasService;
  close(): Promise<void>;
}

export async function openAtlasNodeHost(options: OpenAtlasNodeHostOptions): Promise<AtlasNodeHost> {
  const layout = await initializeAtlasNodeLayout(options);
  const store = await openSqliteAtlasStore({
    dbPath: layout.dbPath,
    migrationDir: options.migrationDir ?? getAtlasCoreMigrationsDir(),
    backupDir: layout.backupDir,
    lockPath: layout.lockPath,
    startupTimeoutMs: options.startupTimeoutMs,
    ...(options.sqliteVecExtension ? { sqliteVecExtension: options.sqliteVecExtension } : {}),
    ...(options.embeddingDimensions == null ? {} : { embeddingDimensions: options.embeddingDimensions }),
  });
  const service = new AtlasService(store, {
    workspace: layout.workspace,
    sourceRoot: layout.sourceRoot,
    indexConcurrency: options.concurrency,
    closeExecutor: true,
  });
  return {
    layout,
    store,
    service,
    close: () => service.close(),
  };
}
