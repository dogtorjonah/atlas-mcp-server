import type {
  AtlasAuditData,
  AtlasAuditRequest,
  AtlasError,
  AtlasGraphData,
  AtlasGraphRequest,
  AtlasQueryData,
  AtlasQueryRequest,
  AtlasResultMeta,
  AtlasOperationOptions,
} from '../core/types.js';

export type AtlasReadFamily = 'query' | 'graph' | 'audit';

export type AtlasReadRequest =
  | { family: 'query'; request: AtlasQueryRequest }
  | { family: 'graph'; request: AtlasGraphRequest }
  | { family: 'audit'; request: AtlasAuditRequest };

export type AtlasReadData = AtlasQueryData | AtlasGraphData | AtlasAuditData;

export type AtlasReadOutcome =
  | { ok: true; data: AtlasReadData; meta: AtlasResultMeta }
  | { ok: false; error: AtlasError; meta: AtlasResultMeta };

export interface AtlasReadExecutor {
  retrieve(request: AtlasReadRequest, options?: AtlasOperationOptions): Promise<AtlasReadOutcome>;
  close?(): Promise<void>;
}
