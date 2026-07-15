import type {
  AtlasAdminData,
  AtlasAdminRequest,
  AtlasOperationOptions,
} from '../core/types.js';
import type {
  AtlasIndexRepositoryRequest,
  AtlasIndexRepositoryResult,
} from '../indexing/types.js';
import type {
  AtlasBackupRecord,
  AtlasHealthResult,
} from '../persistence/types.js';

export interface AtlasAdminExecutor {
  health(options?: AtlasOperationOptions): Promise<AtlasHealthResult>;
  backup(
    payload?: { label?: string; protected?: boolean },
    options?: AtlasOperationOptions,
  ): Promise<AtlasBackupRecord>;
  listWorkspaces(options?: AtlasOperationOptions): Promise<readonly string[]>;
  indexRepository(
    request: AtlasIndexRepositoryRequest,
    options?: AtlasOperationOptions,
  ): Promise<AtlasIndexRepositoryResult>;
}

export interface AtlasAdminCommand {
  request: AtlasAdminRequest;
  sourceRoot?: string;
  concurrency?: number;
}

export type AtlasAdminCommandResult = AtlasAdminData;
