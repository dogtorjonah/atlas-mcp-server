import type { AtlasOperationOptions } from '../core/types.js';

export interface EmbeddingModelIdentity {
  providerId: string;
  modelId: string;
  modelRevision: string;
  dimensions: number;
  distanceMetric: 'cosine' | 'dot' | 'l2';
  normalization: 'none' | 'unit';
  inputFormatVersion: string;
}

export interface EmbeddingProviderLimits {
  maxBatchItems: number;
  maxItemBytes: number;
  maxBatchBytes: number;
  maxConcurrentBatches: number;
}

export interface EmbeddingBatchItem {
  id: string;
  text: string;
  inputHash: string;
}

export interface EmbeddingBatchRequest {
  items: readonly EmbeddingBatchItem[];
}

export interface EmbeddingItemError {
  code: string;
  message: string;
  retryable: boolean;
}

export type EmbeddingBatchOutput =
  | { id: string; ok: true; vector: readonly number[] }
  | { id: string; ok: false; error: EmbeddingItemError };

export interface EmbeddingBatchResult {
  identity: EmbeddingModelIdentity;
  items: readonly EmbeddingBatchOutput[];
}

export interface EmbeddingProvider {
  readonly identity: EmbeddingModelIdentity;
  readonly limits: EmbeddingProviderLimits;
  embed(
    request: EmbeddingBatchRequest,
    options?: AtlasOperationOptions,
  ): Promise<EmbeddingBatchResult>;
  close?(): Promise<void>;
}

export interface AtlasDenseCandidate {
  id: string;
  score: number;
}

export interface AtlasEmbeddingFallbackMeta {
  status: 'disabled' | 'current' | 'provider-failed' | 'invalid-output' | 'search-failed';
  spaceKey?: string;
  lexicalFallback: boolean;
  reason?: string;
}

export interface AtlasEmbeddingRankResult<T> {
  items: readonly T[];
  meta: AtlasEmbeddingFallbackMeta;
}

export type AtlasDenseSearch = (
  vector: readonly number[],
  spaceKey: string,
  limit: number,
  options?: AtlasOperationOptions,
) => Promise<readonly AtlasDenseCandidate[]>;
