import { createHash } from 'node:crypto';

export const ATLAS_CONTEXT_WARP_EVIDENCE_NAMESPACE =
  'context-warp-drive/fold-prepare-receipt' as const;

/** Public Context Warp receipt shape consumed by this schema-v1 adapter. */
export interface ContextWarpPrepareReceipt {
  readonly version: 1;
  readonly kind: 'fold-prepare-receipt';
  readonly subject: {
    readonly sessionId?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly turnCount: number;
    readonly messageCount: number;
  };
  readonly input: {
    readonly rawHistoryDigest: string;
    readonly messageCount: number;
    readonly rawHistoryStoreRef?: string;
    readonly tokenizer?: string;
    readonly measuredInputTokens?: number;
  };
  readonly fold: {
    readonly strategy: string;
    readonly configDigest?: string;
    readonly foldedViewDigest: string;
    readonly preparedMessageCount: number;
    readonly frozenPrefixDigest: string | null;
    readonly sealedBoundary: number | null;
    readonly cacheHot: boolean;
    readonly epochs: number;
    readonly hotReuses: number;
  };
  readonly privacy: {
    readonly receiptEmbedsRawContent: false;
    readonly digestsOnly: true;
    readonly foldedViewDerivedFromRawHistory: true;
  };
  readonly staleIf: readonly string[];
  readonly generatedAt?: string;
}

export type AtlasEvidenceConfidence = 'high' | 'medium' | 'low' | 'unknown';
export type AtlasProvenanceAuthority = 'caller' | 'repository' | 'provider' | 'verified-external';
export type AtlasJsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: AtlasJsonValue }
  | readonly AtlasJsonValue[];

export interface AtlasPrincipal {
  id?: string;
  displayName?: string;
  kind: 'human' | 'service' | 'automation' | 'unknown';
}

/** Public Atlas protocol-v1 provenance shape emitted by the adapter. */
export interface AtlasProvenanceEvidence {
  namespace: string;
  schemaVersion: string;
  providerId: string;
  providerVersion: string;
  evidenceId: string;
  subject: {
    kind: 'file' | 'symbol' | 'snapshot' | 'changelog' | 'operation';
    workspace: string;
    key: string;
  };
  kind: 'authored' | 'observed' | 'modified' | 'committed' | 'reviewed' | 'referenced' | 'other';
  principal?: AtlasPrincipal;
  occurredAt?: string;
  observedAt: string;
  authority: AtlasProvenanceAuthority;
  confidence: AtlasEvidenceConfidence;
  sourceRef?: string;
  payload: AtlasJsonValue;
  payloadHash: string;
}

export interface FoldReceiptEvidenceOptions {
  /** Atlas workspace receiving the evidence. */
  workspace: string;
  /** Stable operation, snapshot, or changelog key inside that workspace. */
  subjectKey: string;
  /** Version of Context Warp that produced the receipt. Never inferred. */
  contextWarpVersion: string;
  /** Host-injected observation time. This adapter never reads the clock. */
  observedAt: string;
  subjectKind?: 'snapshot' | 'changelog' | 'operation';
  evidenceId?: string;
  authority?: AtlasProvenanceAuthority;
  confidence?: AtlasEvidenceConfidence;
  principal?: AtlasPrincipal;
  /** Opaque raw-history reference is omitted unless the caller explicitly opts in. */
  includeSourceRef?: boolean;
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().flatMap((key) => {
      const member = record[key];
      return member === undefined || typeof member === 'function' || typeof member === 'symbol'
        ? []
        : [`${JSON.stringify(key)}:${canonicalJson(member)}`];
    }).join(',')}}`;
  }
  return 'null';
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function requireText(value: string, label: string): string {
  if (!value.trim()) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function requireDigest(value: string | null, label: string): void {
  if (value !== null && !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be null or a sha256 digest.`);
  }
}

/**
 * Convert one digest-only Context Warp prepare receipt into Atlas provenance.
 *
 * The payload deliberately excludes messages, folded text, and the raw-history
 * store reference by default. Measured token telemetry is copied only when it
 * already exists in the receipt; the adapter never estimates it.
 */
export function foldReceiptToAtlasEvidence(
  receipt: ContextWarpPrepareReceipt,
  options: FoldReceiptEvidenceOptions,
): AtlasProvenanceEvidence {
  if (receipt.version !== 1 || receipt.kind !== 'fold-prepare-receipt') {
    throw new TypeError('Unsupported Context Warp prepare receipt.');
  }
  if (!receipt.privacy.digestsOnly || receipt.privacy.receiptEmbedsRawContent) {
    throw new TypeError('Context Warp receipt does not satisfy the digest-only boundary.');
  }
  requireDigest(receipt.input.rawHistoryDigest, 'input.rawHistoryDigest');
  requireDigest(receipt.fold.foldedViewDigest, 'fold.foldedViewDigest');
  requireDigest(receipt.fold.frozenPrefixDigest, 'fold.frozenPrefixDigest');
  if (receipt.fold.configDigest !== undefined) {
    requireDigest(receipt.fold.configDigest, 'fold.configDigest');
  }

  const payload = {
    receipt_kind: receipt.kind,
    receipt_version: receipt.version,
    raw_history_digest: receipt.input.rawHistoryDigest,
    message_count: receipt.input.messageCount,
    fold_strategy: receipt.fold.strategy,
    folded_view_digest: receipt.fold.foldedViewDigest,
    prepared_message_count: receipt.fold.preparedMessageCount,
    frozen_prefix_digest: receipt.fold.frozenPrefixDigest,
    sealed_boundary: receipt.fold.sealedBoundary,
    cache_hot: receipt.fold.cacheHot,
    epochs: receipt.fold.epochs,
    hot_reuses: receipt.fold.hotReuses,
    ...(receipt.fold.configDigest === undefined ? {} : { config_digest: receipt.fold.configDigest }),
    ...(receipt.input.tokenizer === undefined ? {} : { tokenizer: receipt.input.tokenizer }),
    ...(receipt.input.measuredInputTokens === undefined
      ? {}
      : { measured_input_tokens: receipt.input.measuredInputTokens }),
    privacy: {
      receipt_embeds_raw_content: false,
      digests_only: true,
      folded_view_derived_from_raw_history: receipt.privacy.foldedViewDerivedFromRawHistory,
    },
    stale_if: [...receipt.staleIf],
  };

  return {
    namespace: ATLAS_CONTEXT_WARP_EVIDENCE_NAMESPACE,
    schemaVersion: String(receipt.version),
    providerId: 'context-warp-drive',
    providerVersion: requireText(options.contextWarpVersion, 'contextWarpVersion'),
    evidenceId: options.evidenceId ?? receipt.fold.foldedViewDigest,
    subject: {
      kind: options.subjectKind ?? 'operation',
      workspace: requireText(options.workspace, 'workspace'),
      key: requireText(options.subjectKey, 'subjectKey'),
    },
    kind: 'observed',
    ...(options.principal === undefined ? {} : { principal: options.principal }),
    ...(receipt.generatedAt === undefined ? {} : { occurredAt: receipt.generatedAt }),
    observedAt: requireText(options.observedAt, 'observedAt'),
    authority: options.authority ?? 'caller',
    confidence: options.confidence ?? 'medium',
    ...(options.includeSourceRef && receipt.input.rawHistoryStoreRef
      ? { sourceRef: receipt.input.rawHistoryStoreRef }
      : {}),
    payload,
    payloadHash: digest(payload),
  };
}
