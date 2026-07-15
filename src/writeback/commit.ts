import { createHash } from 'node:crypto';

import {
  getAtlasFile,
  insertAtlasChangelog,
  upsertFileRecord,
  type AtlasDatabase,
  type AtlasFileUpsertInput,
} from '../db.js';
import {
  canonicalizeRepositoryPath,
  canonicalizeWorkspaceName,
} from '../core/paths.js';
import type {
  AtlasAttribution,
  AtlasCommitData,
  AtlasCommitRequest,
  AtlasJsonValue,
  AtlasProvenanceEvidence,
  AtlasSourceHighlight,
} from '../core/types.js';
import { autoSyncHazardsColumns } from '../tools/hazardsAutoSync.js';
import type { AtlasFileRecord } from '../types.js';
import { AtlasWritebackError, type AtlasCommitCommand } from './types.js';

const MAX_PATH_LENGTH = 4_096;
const MAX_TEXT_LENGTH = 20_000;
const MAX_LIST_ITEMS = 512;
const MAX_EVIDENCE_ITEMS = 128;
const MAX_HIGHLIGHTS = 256;

const REQUEST_FIELDS = new Set([
  'filePath', 'changelogEntry', 'idempotencyKey', 'expectedVersion', 'purpose',
  'blurb', 'cluster', 'tags', 'conventions', 'keyTypes', 'dataFlows', 'publicApi',
  'sourceHighlights', 'patterns', 'hazards', 'patternsAdded', 'patternsRemoved',
  'hazardsAdded', 'hazardsRemoved', 'breakingChanges', 'repositoryRevision',
  'attribution', 'evidence', 'responseDetail',
]);

function invalid(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new AtlasWritebackError('INVALID_REQUEST', message, details);
}

function canonicalValue(value: unknown, path = 'value'): AtlasJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${path} contains a non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${path}[${index}]`));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const output: Record<string, AtlasJsonValue> = {};
    for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right, 'en'))) {
      if (!key || key.length > 256) invalid(`${path} contains an invalid object key.`);
      output[key] = canonicalValue(record[key], `${path}.${key}`);
    }
    return output;
  }
  return invalid(`${path} must be JSON-serializable.`);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function trimText(value: unknown, name: string, required = false): string | undefined {
  if (value == null && !required) return undefined;
  if (typeof value !== 'string') invalid(`${name} must be a string.`);
  const trimmed = value.trim();
  if (required && !trimmed) invalid(`${name} must be non-empty.`);
  if (trimmed.length > MAX_TEXT_LENGTH) invalid(`${name} exceeds ${MAX_TEXT_LENGTH} characters.`);
  return trimmed || undefined;
}

function stringList(value: unknown, name: string): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    invalid(`${name} must contain at most ${MAX_LIST_ITEMS} strings.`);
  }
  const values = value.map((item, index) => trimText(item, `${name}[${index}]`, true) as string);
  return [...new Set(values)];
}

function validateAttribution(value: unknown): AtlasAttribution | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('attribution must be an object.');
  const input = value as Record<string, unknown>;
  const allowed = new Set(['principal', 'runtime', 'toolId', 'source']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) invalid('attribution contains unknown fields.', { fields: unknown });
  const attribution = value as AtlasAttribution;
  if (attribution.principal) {
    if (!['human', 'service', 'automation', 'unknown'].includes(attribution.principal.kind)) {
      invalid('attribution.principal.kind is invalid.');
    }
    trimText(attribution.principal.id, 'attribution.principal.id');
    trimText(attribution.principal.displayName, 'attribution.principal.displayName');
  }
  if (attribution.runtime) {
    trimText(attribution.runtime.name, 'attribution.runtime.name');
    trimText(attribution.runtime.version, 'attribution.runtime.version');
  }
  trimText(attribution.toolId, 'attribution.toolId');
  trimText(attribution.source, 'attribution.source');
  return attribution;
}

function validateEvidence(
  value: unknown,
  workspace: string,
  filePath: string,
): AtlasProvenanceEvidence[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_ITEMS) {
    invalid(`evidence must contain at most ${MAX_EVIDENCE_ITEMS} records.`);
  }
  const evidence = value as AtlasProvenanceEvidence[];
  const ids = new Set<string>();
  for (const [index, item] of evidence.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid(`evidence[${index}] must be an object.`);
    const prefix = `evidence[${index}]`;
    for (const [name, text] of [
      ['namespace', item.namespace], ['schemaVersion', item.schemaVersion],
      ['providerId', item.providerId], ['providerVersion', item.providerVersion],
      ['evidenceId', item.evidenceId], ['observedAt', item.observedAt],
      ['payloadHash', item.payloadHash],
    ] as const) trimText(text, `${prefix}.${name}`, true);
    if (ids.has(item.evidenceId)) invalid(`${prefix}.evidenceId is duplicated.`);
    ids.add(item.evidenceId);
    if (!item.subject || item.subject.workspace !== workspace) invalid(`${prefix}.subject.workspace must match the command workspace.`);
    if (!['file', 'symbol', 'snapshot', 'changelog', 'operation'].includes(item.subject.kind)) invalid(`${prefix}.subject.kind is invalid.`);
    trimText(item.subject.key, `${prefix}.subject.key`, true);
    if (item.subject.kind === 'file') {
      const subjectPath = canonicalizeRepositoryPath(item.subject.key, {
        workspace,
        repositoryRoot: '/',
        platform: 'posix',
      });
      if (!subjectPath.ok || subjectPath.path !== filePath) invalid(`${prefix}.subject.key must match filePath.`);
    }
    if (!['authored', 'observed', 'modified', 'committed', 'reviewed', 'referenced', 'other'].includes(item.kind)) invalid(`${prefix}.kind is invalid.`);
    if (!['caller', 'repository', 'provider', 'verified-external'].includes(item.authority)) invalid(`${prefix}.authority is invalid.`);
    if (!['high', 'medium', 'low', 'unknown'].includes(item.confidence)) invalid(`${prefix}.confidence is invalid.`);
    if (!Number.isFinite(Date.parse(item.observedAt))) invalid(`${prefix}.observedAt must be an ISO timestamp.`);
    if (item.occurredAt != null && !Number.isFinite(Date.parse(item.occurredAt))) invalid(`${prefix}.occurredAt must be an ISO timestamp.`);
    const computedHash = sha256(canonicalJson(item.payload));
    const suppliedHash = item.payloadHash.toLowerCase().replace(/^sha256:/u, '');
    if (suppliedHash !== computedHash) invalid(`${prefix}.payloadHash does not match payload.`);
    if (item.principal) validateAttribution({ principal: item.principal });
  }
  return evidence;
}

function normalizedHighlights(
  request: AtlasCommitRequest,
  existing: AtlasFileRecord | null,
): AtlasSourceHighlight[] | undefined {
  if (request.sourceHighlights == null) return undefined;
  if (!Array.isArray(request.sourceHighlights) || request.sourceHighlights.length > MAX_HIGHLIGHTS) {
    invalid(`sourceHighlights must contain at most ${MAX_HIGHLIGHTS} records.`);
  }
  return request.sourceHighlights.map((item, index) => {
    if (!item || typeof item !== 'object') invalid(`sourceHighlights[${index}] must be an object.`);
    if (!Number.isInteger(item.startLine) || !Number.isInteger(item.endLine)
      || item.startLine < 1 || item.endLine < item.startLine || item.endLine > 10_000_000) {
      invalid(`sourceHighlights[${index}] has an invalid line range.`);
    }
    const id = item.id ?? index + 1;
    if (!Number.isInteger(id) || id < 1) invalid(`sourceHighlights[${index}].id must be a positive integer.`);
    const label = trimText(item.label, `sourceHighlights[${index}].label`, true) as string;
    const prior = existing?.source_highlights.find((entry) => (
      entry.id === id
      || (entry.startLine === item.startLine && entry.endLine === item.endLine)
    ));
    const content = item.content == null
      ? prior?.content ?? ''
      : trimText(item.content, `sourceHighlights[${index}].content`) ?? '';
    return { id, label, startLine: item.startLine, endLine: item.endLine, content };
  });
}

function recordVersion(record: AtlasFileRecord | AtlasFileUpsertInput | null): string {
  if (!record) return `sha256:${sha256('null')}`;
  return `sha256:${sha256(canonicalJson({
    workspace: record.workspace,
    filePath: record.file_path,
    fileHash: record.file_hash ?? null,
    cluster: record.cluster ?? null,
    blurb: record.blurb ?? '',
    purpose: record.purpose ?? '',
    publicApi: record.public_api ?? [],
    patterns: record.patterns ?? [],
    tags: record.tags ?? [],
    dataFlows: record.data_flows ?? [],
    keyTypes: record.key_types ?? [],
    hazards: record.hazards ?? [],
    rangedHazards: record.hazards_with_ranges ?? [],
    conventions: record.conventions ?? [],
    sourceHighlights: record.source_highlights ?? [],
  }))}`;
}

function mergeFile(
  workspace: string,
  filePath: string,
  request: AtlasCommitRequest,
  existing: AtlasFileRecord | null,
): AtlasFileUpsertInput {
  const highlights = normalizedHighlights(request, existing);
  const hazards = stringList(request.hazards, 'hazards') ?? existing?.hazards ?? [];
  const rangedHazards = existing?.hazards_with_ranges ?? [];
  const synced = autoSyncHazardsColumns(hazards, rangedHazards);
  const publicApi = request.publicApi == null ? existing?.public_api ?? [] : request.publicApi.map((entry, index) => {
    if (!entry || typeof entry !== 'object') invalid(`publicApi[${index}] must be an object.`);
    const name = trimText(entry.name, `publicApi[${index}].name`, true) as string;
    const type = trimText(entry.type, `publicApi[${index}].type`, true) as string;
    const signature = trimText(entry.signature, `publicApi[${index}].signature`);
    const description = trimText(entry.description, `publicApi[${index}].description`);
    return { name, type, ...(signature ? { signature } : {}), ...(description ? { description } : {}) };
  });
  const merged: AtlasFileUpsertInput = {
    workspace,
    file_path: filePath,
    file_hash: existing?.file_hash ?? null,
    cluster: trimText(request.cluster, 'cluster') ?? existing?.cluster ?? null,
    loc: existing?.loc ?? 0,
    blurb: trimText(request.blurb, 'blurb') ?? existing?.blurb ?? '',
    purpose: trimText(request.purpose, 'purpose') ?? existing?.purpose ?? '',
    public_api: publicApi,
    exports: request.publicApi == null
      ? existing?.exports ?? []
      : request.publicApi.map((entry) => ({ name: entry.name, type: entry.type })),
    patterns: stringList(request.patterns, 'patterns') ?? existing?.patterns ?? [],
    tags: stringList(request.tags, 'tags') ?? existing?.tags ?? [],
    dependencies: existing?.dependencies ?? {},
    data_flows: stringList(request.dataFlows, 'dataFlows') ?? existing?.data_flows ?? [],
    key_types: stringList(request.keyTypes, 'keyTypes') ?? existing?.key_types ?? [],
    hazards: synced.syncedHazards,
    hazards_with_ranges: synced.syncedHazardsWithRanges,
    conventions: stringList(request.conventions, 'conventions') ?? existing?.conventions ?? [],
    cross_refs: existing?.cross_refs ?? null,
    source_highlights: highlights ?? existing?.source_highlights ?? [],
    language: existing?.language ?? 'unknown',
    extraction_model: request.attribution?.runtime?.name ?? existing?.extraction_model ?? null,
    last_extracted: existing?.last_extracted ?? null,
  };
  const missing = [
    !merged.purpose?.trim() && 'purpose',
    !merged.blurb?.trim() && 'blurb',
    (merged.tags?.length ?? 0) === 0 && 'tags',
    (merged.source_highlights?.length ?? 0) === 0 && 'sourceHighlights',
  ].filter((field): field is string => Boolean(field));
  if (missing.length > 0) invalid('Commit identity is incomplete.', { missingFields: missing });
  return merged;
}

export function executeAtlasCommit(
  db: AtlasDatabase,
  command: AtlasCommitCommand,
): AtlasCommitData {
  if (!command || typeof command !== 'object' || Array.isArray(command)) invalid('Commit command must be an object.');
  const workspaceResult = canonicalizeWorkspaceName(command.workspace);
  if (!workspaceResult.ok) invalid(workspaceResult.message);
  const workspace = workspaceResult.name;
  const request = command.request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) invalid('Commit request must be an object.');
  const unknownFields = Object.keys(request).filter((key) => !REQUEST_FIELDS.has(key));
  if (unknownFields.length > 0) invalid('Commit request contains unknown fields.', { fields: unknownFields });
  if (typeof request.filePath !== 'string' || request.filePath.length > MAX_PATH_LENGTH) invalid('filePath is invalid.');
  const canonicalPath = canonicalizeRepositoryPath(request.filePath, {
    workspace,
    repositoryRoot: '/',
    platform: 'posix',
  });
  if (!canonicalPath.ok || canonicalPath.state !== 'current' || canonicalPath.path !== request.filePath) {
    invalid('filePath must be a canonical repository-relative POSIX path.');
  }
  const changelogEntry = trimText(request.changelogEntry, 'changelogEntry', true) as string;
  const idempotencyKey = trimText(request.idempotencyKey, 'idempotencyKey');
  if (idempotencyKey && idempotencyKey.length > 512) invalid('idempotencyKey exceeds 512 characters.');
  const existing = getAtlasFile(db, workspace, canonicalPath.path);
  const currentVersion = recordVersion(existing);
  if (request.expectedVersion != null && request.expectedVersion !== currentVersion) {
    throw new AtlasWritebackError('WRITE_CONFLICT', 'expectedVersion does not match the current file record.', {
      expectedVersion: request.expectedVersion,
      currentVersion,
    });
  }
  const attribution = validateAttribution(request.attribution);
  const evidence = validateEvidence(request.evidence, workspace, canonicalPath.path);
  const merged = mergeFile(workspace, canonicalPath.path, request, existing);
  const updatedFields = [
    'changelog',
    ...(evidence.length > 0 ? ['evidence'] : []),
    ...[
      ['purpose', request.purpose], ['blurb', request.blurb], ['cluster', request.cluster],
      ['tags', request.tags], ['conventions', request.conventions], ['keyTypes', request.keyTypes],
      ['dataFlows', request.dataFlows], ['publicApi', request.publicApi],
      ['sourceHighlights', request.sourceHighlights], ['patterns', request.patterns],
      ['hazards', request.hazards],
    ].filter(([, value]) => value !== undefined).map(([name]) => name as string),
  ].sort((left, right) => left.localeCompare(right, 'en'));
  const changelog = insertAtlasChangelog(db, {
    workspace,
    file_path: canonicalPath.path,
    summary: changelogEntry,
    patterns_added: stringList(request.patternsAdded, 'patternsAdded'),
    patterns_removed: stringList(request.patternsRemoved, 'patternsRemoved'),
    hazards_added: stringList(request.hazardsAdded, 'hazardsAdded'),
    hazards_removed: stringList(request.hazardsRemoved, 'hazardsRemoved'),
    cluster: merged.cluster,
    breaking_changes: request.breakingChanges ?? false,
    commit_sha: trimText(request.repositoryRevision, 'repositoryRevision') ?? null,
    author_instance_id: attribution?.principal?.id ?? null,
    author_name: attribution?.principal?.displayName ?? null,
    author_engine: attribution?.runtime?.name ?? null,
    source: attribution?.source ?? 'atlas_service',
    verification_status: evidence.some((item) => item.authority === 'verified-external') ? 'verified' : 'pending',
    idempotency_key: idempotencyKey ?? null,
    idempotency_fingerprint: idempotencyKey ? sha256(canonicalJson(request)) : null,
  });
  db.prepare('UPDATE atlas_changelog SET attribution_json = ? WHERE id = ?').run(
    attribution ? canonicalJson(attribution) : null,
    changelog.id,
  );
  for (const item of evidence) {
    db.prepare(
      `INSERT INTO atlas_provenance_evidence
       (workspace, changelog_id, evidence_id, namespace, schema_version, evidence_json, payload_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      workspace,
      changelog.id,
      item.evidenceId,
      item.namespace,
      item.schemaVersion,
      canonicalJson(item),
      item.payloadHash,
    );
  }
  upsertFileRecord(db, merged);
  return {
    status: 'committed',
    filePath: canonicalPath.path,
    changelogId: changelog.id,
    version: recordVersion(merged),
    updatedFields,
    idempotencyStatus: idempotencyKey ? 'recorded' : 'not_requested',
    evidenceCount: evidence.length,
    verificationStatus: evidence.some((item) => item.authority === 'verified-external') ? 'verified' : 'pending',
  };
}
