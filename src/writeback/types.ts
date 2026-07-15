import type {
  AtlasCommitData,
  AtlasCommitRequest,
  AtlasOperationOptions,
} from '../core/types.js';

export interface AtlasCommitCommand {
  workspace: string;
  request: AtlasCommitRequest;
}

export interface AtlasWriteExecutor {
  commit(
    command: AtlasCommitCommand,
    options?: AtlasOperationOptions & { idempotencyKey?: string },
  ): Promise<AtlasCommitData>;
  close?(): Promise<void>;
}

export type AtlasWritebackErrorCode = 'INVALID_REQUEST' | 'WRITE_CONFLICT';

export class AtlasWritebackError extends Error {
  readonly code: AtlasWritebackErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: AtlasWritebackErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'AtlasWritebackError';
    this.code = code;
    this.details = details;
  }
}
