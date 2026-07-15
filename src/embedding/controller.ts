import { createHash } from 'node:crypto';

import type { AtlasOperationOptions } from '../core/types.js';
import type {
  AtlasDenseCandidate,
  AtlasDenseSearch,
  AtlasEmbeddingRankResult,
  EmbeddingBatchItem,
  EmbeddingBatchOutput,
  EmbeddingModelIdentity,
  EmbeddingProvider,
  EmbeddingProviderLimits,
} from './types.js';

const UNIT_TOLERANCE = 1e-4;
const MAX_ID_LENGTH = 4_096;

export class AtlasEmbeddingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AtlasEmbeddingValidationError';
  }
}

function canonicalIdentity(identity: EmbeddingModelIdentity): EmbeddingModelIdentity {
  const textFields = [
    ['providerId', identity.providerId],
    ['modelId', identity.modelId],
    ['modelRevision', identity.modelRevision],
    ['inputFormatVersion', identity.inputFormatVersion],
  ] as const;
  for (const [name, value] of textFields) {
    if (typeof value !== 'string' || !value.trim() || value.length > 512) {
      throw new AtlasEmbeddingValidationError(`${name} must be a bounded non-empty string.`);
    }
  }
  if (!Number.isInteger(identity.dimensions) || identity.dimensions < 1 || identity.dimensions > 65_536) {
    throw new AtlasEmbeddingValidationError('dimensions must be an integer from 1 to 65,536.');
  }
  if (!['cosine', 'dot', 'l2'].includes(identity.distanceMetric)) {
    throw new AtlasEmbeddingValidationError('distanceMetric is invalid.');
  }
  if (!['none', 'unit'].includes(identity.normalization)) {
    throw new AtlasEmbeddingValidationError('normalization is invalid.');
  }
  return { ...identity };
}

function validateLimits(limits: EmbeddingProviderLimits): EmbeddingProviderLimits {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1 || value > 1_000_000_000) {
      throw new AtlasEmbeddingValidationError(`${name} must be a bounded positive integer.`);
    }
  }
  if (limits.maxItemBytes > limits.maxBatchBytes) {
    throw new AtlasEmbeddingValidationError('maxItemBytes cannot exceed maxBatchBytes.');
  }
  return { ...limits };
}

function canonicalIdentityJson(identity: EmbeddingModelIdentity): string {
  return JSON.stringify({
    dimensions: identity.dimensions,
    distanceMetric: identity.distanceMetric,
    inputFormatVersion: identity.inputFormatVersion,
    modelId: identity.modelId,
    modelRevision: identity.modelRevision,
    normalization: identity.normalization,
    providerId: identity.providerId,
  });
}

export function embeddingSpaceKey(identity: EmbeddingModelIdentity): string {
  return `sha256:${createHash('sha256').update(canonicalIdentityJson(canonicalIdentity(identity)), 'utf8').digest('hex')}`;
}

export function embeddingInputHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function identityEquals(left: EmbeddingModelIdentity, right: EmbeddingModelIdentity): boolean {
  return canonicalIdentityJson(left) === canonicalIdentityJson(right);
}

function validateVector(vector: readonly number[], identity: EmbeddingModelIdentity, id: string): number[] {
  if (!Array.isArray(vector) || vector.length !== identity.dimensions) {
    throw new AtlasEmbeddingValidationError(`Embedding ${id} has the wrong dimensions.`);
  }
  const output = vector.map((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new AtlasEmbeddingValidationError(`Embedding ${id} contains a non-finite value.`);
    }
    return value;
  });
  if (identity.normalization === 'unit') {
    const norm = Math.sqrt(output.reduce((sum, value) => sum + value * value, 0));
    if (Math.abs(norm - 1) > UNIT_TOLERANCE) {
      throw new AtlasEmbeddingValidationError(`Embedding ${id} is not unit-normalized.`);
    }
  }
  return output;
}

function validateInput(item: EmbeddingBatchItem, limits: EmbeddingProviderLimits): EmbeddingBatchItem {
  if (typeof item.id !== 'string' || !item.id || item.id.length > MAX_ID_LENGTH) {
    throw new AtlasEmbeddingValidationError('Embedding item id is invalid.');
  }
  if (typeof item.text !== 'string') throw new AtlasEmbeddingValidationError(`Embedding ${item.id} text must be a string.`);
  const bytes = Buffer.byteLength(item.text, 'utf8');
  if (bytes > limits.maxItemBytes) throw new AtlasEmbeddingValidationError(`Embedding ${item.id} exceeds maxItemBytes.`);
  if (item.inputHash !== embeddingInputHash(item.text)) {
    throw new AtlasEmbeddingValidationError(`Embedding ${item.id} inputHash does not match its text.`);
  }
  return { ...item };
}

function splitBatches(items: readonly EmbeddingBatchItem[], limits: EmbeddingProviderLimits): EmbeddingBatchItem[][] {
  const batches: EmbeddingBatchItem[][] = [];
  let current: EmbeddingBatchItem[] = [];
  let bytes = 0;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(item.text, 'utf8');
    if (current.length > 0
      && (current.length >= limits.maxBatchItems || bytes + itemBytes > limits.maxBatchBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += itemBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export class AtlasEmbeddingController {
  readonly identity: EmbeddingModelIdentity;
  readonly limits: EmbeddingProviderLimits;
  readonly spaceKey: string;
  private closed = false;

  constructor(private readonly provider: EmbeddingProvider) {
    this.identity = canonicalIdentity(provider.identity);
    this.limits = validateLimits(provider.limits);
    this.spaceKey = embeddingSpaceKey(this.identity);
  }

  async embed(
    items: readonly EmbeddingBatchItem[],
    options?: AtlasOperationOptions,
  ): Promise<readonly EmbeddingBatchOutput[]> {
    if (this.closed) throw new AtlasEmbeddingValidationError('Embedding controller is closed.');
    if (options?.signal?.aborted) throw new AtlasEmbeddingValidationError('Embedding request was cancelled.');
    if (!identityEquals(this.identity, canonicalIdentity(this.provider.identity))) {
      throw new AtlasEmbeddingValidationError('Embedding provider identity changed after controller creation.');
    }
    const ids = new Set<string>();
    const validated = items.map((item) => {
      const result = validateInput(item, this.limits);
      if (ids.has(result.id)) throw new AtlasEmbeddingValidationError(`Embedding item id ${result.id} is duplicated.`);
      ids.add(result.id);
      return result;
    });
    const batches = splitBatches(validated, this.limits);
    const outputs = new Map<string, EmbeddingBatchOutput>();
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < batches.length) {
        const batchIndex = cursor++;
        const batch = batches[batchIndex];
        if (!batch) return;
        if (options?.signal?.aborted) throw new AtlasEmbeddingValidationError('Embedding request was cancelled.');
        const result = await this.provider.embed({ items: batch }, options);
        if (!identityEquals(this.identity, canonicalIdentity(result.identity))) {
          throw new AtlasEmbeddingValidationError('Embedding result identity does not match the active space.');
        }
        const expected = new Set(batch.map((item) => item.id));
        for (const output of result.items) {
          if (!expected.has(output.id) || outputs.has(output.id)) {
            throw new AtlasEmbeddingValidationError(`Embedding result ${output.id} is unexpected or duplicated.`);
          }
          outputs.set(output.id, output.ok
            ? { id: output.id, ok: true, vector: validateVector(output.vector, this.identity, output.id) }
            : { id: output.id, ok: false, error: { ...output.error } });
        }
        for (const id of expected) {
          if (!outputs.has(id)) throw new AtlasEmbeddingValidationError(`Embedding result ${id} is missing.`);
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(this.limits.maxConcurrentBatches, batches.length) },
      () => worker(),
    ));
    return validated.map((item) => outputs.get(item.id) as EmbeddingBatchOutput);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.provider.close?.();
  }
}

export async function rerankWithEmbeddings<T extends { id: string }>(
  lexical: readonly T[],
  query: string,
  controller: AtlasEmbeddingController | null,
  denseSearch: AtlasDenseSearch | null,
  options?: AtlasOperationOptions,
): Promise<AtlasEmbeddingRankResult<T>> {
  if (!controller || !denseSearch) {
    return { items: lexical, meta: { status: 'disabled', lexicalFallback: true } };
  }
  let output: EmbeddingBatchOutput | undefined;
  try {
    [output] = await controller.embed([{ id: 'query', text: query, inputHash: embeddingInputHash(query) }], options);
  } catch (error) {
    return {
      items: lexical,
      meta: { status: error instanceof AtlasEmbeddingValidationError ? 'invalid-output' : 'provider-failed', lexicalFallback: true, reason: error instanceof Error ? error.message : String(error) },
    };
  }
  if (!output || !output.ok) {
    return { items: lexical, meta: { status: 'provider-failed', lexicalFallback: true, reason: output?.ok === false ? output.error.message : 'Query embedding is missing.' } };
  }
  let dense: readonly AtlasDenseCandidate[];
  try {
    dense = await denseSearch(output.vector, controller.spaceKey, lexical.length, options);
  } catch (error) {
    return { items: lexical, meta: { status: 'search-failed', lexicalFallback: true, reason: error instanceof Error ? error.message : String(error) } };
  }
  const lexicalRank = new Map(lexical.map((item, index) => [item.id, index] as const));
  const denseRank = new Map(dense.map((item, index) => [item.id, index] as const));
  const fused = [...lexical].sort((left, right) => {
    const leftScore = 1 / (60 + (lexicalRank.get(left.id) ?? lexical.length) + 1)
      + (denseRank.has(left.id) ? 1 / (60 + (denseRank.get(left.id) as number) + 1) : 0);
    const rightScore = 1 / (60 + (lexicalRank.get(right.id) ?? lexical.length) + 1)
      + (denseRank.has(right.id) ? 1 / (60 + (denseRank.get(right.id) as number) + 1) : 0);
    return rightScore - leftScore
      || (lexicalRank.get(left.id) ?? lexical.length) - (lexicalRank.get(right.id) ?? lexical.length)
      || left.id.localeCompare(right.id, 'en');
  });
  return { items: fused, meta: { status: 'current', spaceKey: controller.spaceKey, lexicalFallback: false } };
}
