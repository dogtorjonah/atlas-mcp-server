import type {
  AtlasEvidenceCompleteness,
  AtlasEvidenceConfidence,
  AtlasResult,
  AtlasResultEvidenceMeta,
} from './types.js';

export type AtlasSourceEvidenceState = 'current' | 'missing' | 'not_observed';

export type AtlasEvidenceProvenanceKind =
  | 'indexed_metadata'
  | 'current_parsed_source'
  | 'verified_snapshot'
  | 'verified_narration'
  | 'pending_narration'
  | 'historical_deleted_artifact'
  | 'inferred_relationship'
  | 'incomplete_set';

export type AtlasFactEvidenceFreshness =
  | 'current'
  | 'verified'
  | 'pending'
  | 'historical'
  | 'inferred'
  | 'stale'
  | 'missing'
  | 'unknown'
  | 'disputed'
  | 'unverified';

export interface AtlasFactAuthority {
  provenance: AtlasEvidenceProvenanceKind;
  freshness: AtlasFactEvidenceFreshness;
  confidence: AtlasEvidenceConfidence;
  completeness: AtlasEvidenceCompleteness;
  authoritative: boolean;
}

export interface AtlasEvidenceAuthorityResolution {
  resolution_rule: 'current_disk_source_overrides_indexed_metadata_on_conflict';
  current_source: {
    authority: 'authoritative' | 'unavailable' | 'not_observed';
    provenance: 'workspace_disk';
    state: AtlasSourceEvidenceState;
    sha1: string | null;
    freshness: AtlasFactEvidenceFreshness;
    confidence: AtlasEvidenceConfidence;
    completeness: AtlasEvidenceCompleteness;
  };
  indexed_metadata: {
    authority: 'advisory';
    provenance: 'atlas_store';
    freshness: 'fresh' | 'stale' | 'historical_tombstone' | 'unverified';
    recorded_sha1: string | null;
    confidence: AtlasEvidenceConfidence;
    completeness: AtlasEvidenceCompleteness;
  };
  changelog: {
    authority: 'historical_record';
    provenance: 'atlas_changelog';
    freshness: 'historical' | 'pending' | 'verified' | 'disputed' | 'unverified' | 'unknown';
    confidence: AtlasEvidenceConfidence;
    completeness: AtlasEvidenceCompleteness;
  };
  facts: {
    current_parsed_source: AtlasFactAuthority;
    verified_snapshot: AtlasFactAuthority;
    pending_narration: AtlasFactAuthority;
    historical_deleted_artifact: AtlasFactAuthority;
    inferred_relationship: AtlasFactAuthority;
    incomplete_set: AtlasFactAuthority;
  };
}

export interface BuildEvidenceAuthorityArgs {
  sourceObserved: boolean;
  sourceHash?: string | null;
  indexedHash?: string | null;
  sourceMissing?: boolean;
  verifiedSnapshot?: boolean;
  pendingNarration?: boolean;
  historicalArtifact?: boolean;
  inferredRelationship?: boolean;
  incompleteSet?: boolean;
  setCompleteness?: AtlasEvidenceCompleteness;
  changelogObserved?: boolean;
  changelogStatus?: string | null;
}

export function buildFactAuthority(
  provenance: AtlasEvidenceProvenanceKind,
  options: Omit<AtlasFactAuthority, 'provenance'>,
): AtlasFactAuthority {
  return { provenance, ...options };
}

export function buildChangelogFactAuthority(
  status: string | null | undefined,
): AtlasFactAuthority {
  if (status === 'verified') {
    return buildFactAuthority('verified_narration', {
      freshness: 'verified',
      confidence: 'high',
      completeness: 'complete',
      authoritative: true,
    });
  }
  if (status === 'disputed') {
    return buildFactAuthority('pending_narration', {
      freshness: 'disputed',
      confidence: 'high',
      completeness: 'complete',
      authoritative: false,
    });
  }
  if (status === 'pending' || status === 'needs_review') {
    return buildFactAuthority('pending_narration', {
      freshness: status === 'needs_review' ? 'unverified' : 'pending',
      confidence: 'low',
      completeness: 'partial',
      authoritative: false,
    });
  }
  return buildFactAuthority('historical_deleted_artifact', {
    freshness: 'historical',
    confidence: 'medium',
    completeness: 'complete',
    authoritative: false,
  });
}

export function buildEvidenceAuthority(
  args: BuildEvidenceAuthorityArgs,
): AtlasEvidenceAuthorityResolution {
  const sourceHash = args.sourceHash ?? null;
  const indexedHash = args.indexedHash ?? null;
  const missing = args.sourceMissing === true;
  const hashesComparable = Boolean(sourceHash && indexedHash);
  const sourceState: AtlasSourceEvidenceState = missing
    ? 'missing'
    : !args.sourceObserved
      ? 'not_observed'
      : 'current';
  const indexIsStale = Boolean(args.sourceObserved && hashesComparable && sourceHash !== indexedHash);
  const indexIsFresh = Boolean(args.sourceObserved && hashesComparable && sourceHash === indexedHash);
  const setCompleteness = args.setCompleteness
    ?? (args.incompleteSet === true ? 'partial' : args.incompleteSet === false ? 'complete' : 'unknown');
  const incomplete = setCompleteness === 'partial';
  const verifiedSnapshot = args.verifiedSnapshot === true;
  const pendingNarration = args.pendingNarration === true;
  const historicalArtifact = missing || args.historicalArtifact === true;
  const inferredRelationship = args.inferredRelationship === true;
  const changelogObserved = args.changelogObserved === true || verifiedSnapshot || pendingNarration;
  const changelogStatus = args.changelogStatus
    ?? (verifiedSnapshot ? 'verified' : pendingNarration ? 'pending' : null);
  const changelogFreshness = !changelogObserved
    ? 'unknown' as const
    : changelogStatus === 'verified'
      ? 'verified' as const
      : changelogStatus === 'disputed'
        ? 'disputed' as const
        : changelogStatus === 'pending'
          ? 'pending' as const
          : changelogStatus === 'needs_review'
            ? 'unverified' as const
            : 'historical' as const;
  const indexedFreshness = missing
    ? 'historical_tombstone' as const
    : !args.sourceObserved || !hashesComparable
      ? 'unverified' as const
      : indexIsStale
        ? 'stale' as const
        : 'fresh' as const;

  return {
    resolution_rule: 'current_disk_source_overrides_indexed_metadata_on_conflict',
    current_source: {
      authority: missing ? 'unavailable' : args.sourceObserved ? 'authoritative' : 'not_observed',
      provenance: 'workspace_disk',
      state: sourceState,
      sha1: sourceHash,
      freshness: missing ? 'missing' : args.sourceObserved ? 'current' : 'unknown',
      confidence: args.sourceObserved ? (sourceHash ? 'high' : 'medium') : missing ? 'high' : 'unknown',
      completeness: args.sourceObserved ? (sourceHash ? 'complete' : 'partial') : 'unknown',
    },
    indexed_metadata: {
      authority: 'advisory',
      provenance: 'atlas_store',
      freshness: indexedFreshness,
      recorded_sha1: indexedHash,
      confidence: indexIsFresh ? 'high' : indexIsStale ? 'low' : historicalArtifact ? 'medium' : 'unknown',
      completeness: incomplete ? 'partial' : indexIsFresh ? 'complete' : 'unknown',
    },
    changelog: {
      authority: 'historical_record',
      provenance: 'atlas_changelog',
      freshness: changelogFreshness,
      confidence: !changelogObserved
        ? 'unknown'
        : changelogFreshness === 'verified' || changelogFreshness === 'disputed'
          ? 'high'
          : changelogFreshness === 'historical'
            ? 'medium'
            : 'low',
      completeness: !changelogObserved
        ? 'unknown'
        : changelogFreshness === 'verified'
          || changelogFreshness === 'disputed'
          || changelogFreshness === 'historical'
          ? 'complete'
          : 'partial',
    },
    facts: {
      current_parsed_source: buildFactAuthority('current_parsed_source', {
        freshness: missing ? 'missing' : args.sourceObserved ? 'current' : 'unknown',
        confidence: args.sourceObserved ? (sourceHash ? 'high' : 'medium') : 'unknown',
        completeness: args.sourceObserved ? (sourceHash ? 'complete' : 'partial') : 'unknown',
        authoritative: args.sourceObserved && !missing,
      }),
      verified_snapshot: buildFactAuthority('verified_snapshot', {
        freshness: verifiedSnapshot ? 'verified' : 'unknown',
        confidence: verifiedSnapshot ? 'high' : 'unknown',
        completeness: verifiedSnapshot ? 'complete' : 'unknown',
        authoritative: verifiedSnapshot,
      }),
      pending_narration: buildFactAuthority('pending_narration', {
        freshness: pendingNarration ? 'pending' : 'unknown',
        confidence: pendingNarration ? 'low' : 'unknown',
        completeness: pendingNarration ? 'partial' : 'not_applicable',
        authoritative: false,
      }),
      historical_deleted_artifact: buildFactAuthority('historical_deleted_artifact', {
        freshness: historicalArtifact ? 'historical' : 'unknown',
        confidence: historicalArtifact ? 'medium' : 'unknown',
        completeness: historicalArtifact ? 'complete' : 'not_applicable',
        authoritative: false,
      }),
      inferred_relationship: buildFactAuthority('inferred_relationship', {
        freshness: inferredRelationship ? 'inferred' : 'unknown',
        confidence: inferredRelationship ? 'medium' : 'unknown',
        completeness: inferredRelationship ? setCompleteness : 'not_applicable',
        authoritative: false,
      }),
      incomplete_set: buildFactAuthority('incomplete_set', {
        freshness: setCompleteness === 'complete' ? 'current' : 'unknown',
        confidence: setCompleteness === 'complete'
          ? 'high'
          : setCompleteness === 'partial'
            ? 'low'
            : 'unknown',
        completeness: setCompleteness,
        authoritative: false,
      }),
    },
  };
}

export function summarizeEvidenceAuthority(
  authority: AtlasEvidenceAuthorityResolution,
): AtlasResultEvidenceMeta {
  const hasCurrentSource = authority.current_source.authority === 'authoritative';
  const hasIndexedMetadata = authority.indexed_metadata.recorded_sha1 !== null
    || authority.indexed_metadata.freshness === 'historical_tombstone';
  const hasChangelog = authority.changelog.freshness !== 'unknown';
  const hasInferredRelationship = authority.facts.inferred_relationship.freshness === 'inferred';

  const aggregateAuthority = hasCurrentSource
    ? hasIndexedMetadata || hasChangelog || hasInferredRelationship ? 'mixed' : 'workspace_disk'
    : hasIndexedMetadata || hasChangelog ? 'atlas_store' : 'unknown';

  const freshness = hasCurrentSource
    ? 'current'
    : authority.current_source.state === 'missing'
      || authority.changelog.freshness === 'historical'
      || authority.changelog.freshness === 'verified'
      || authority.changelog.freshness === 'disputed'
      ? 'historical'
      : authority.indexed_metadata.freshness === 'stale'
        ? 'stale'
        : 'unknown';

  const confidence = hasCurrentSource
    ? authority.current_source.confidence
    : authority.facts.verified_snapshot.authoritative
      ? 'high'
      : hasChangelog
        ? authority.changelog.confidence
        : authority.indexed_metadata.freshness === 'fresh'
          ? 'high'
          : hasIndexedMetadata
            ? authority.indexed_metadata.confidence
            : hasInferredRelationship
              ? authority.facts.inferred_relationship.confidence
              : authority.facts.incomplete_set.confidence;

  return {
    authority: aggregateAuthority,
    freshness,
    confidence,
    completeness: authority.facts.incomplete_set.completeness,
  };
}

export function withEvidenceAuthority<T>(
  result: AtlasResult<T>,
  authority: AtlasEvidenceAuthorityResolution,
): AtlasResult<T> {
  return {
    ...result,
    meta: {
      ...result.meta,
      evidence: summarizeEvidenceAuthority(authority),
    },
  };
}

export function renderEvidenceAuthority(
  authority: AtlasEvidenceAuthorityResolution,
): readonly string[] {
  return [
    '## Evidence Authority',
    `- Resolution: ${authority.resolution_rule}`,
    `- Current source: ${authority.current_source.authority} (${authority.current_source.provenance}; ${authority.current_source.state}; confidence=${authority.current_source.confidence}; completeness=${authority.current_source.completeness})`,
    `- Indexed metadata: ${authority.indexed_metadata.authority} (${authority.indexed_metadata.provenance}; ${authority.indexed_metadata.freshness}; confidence=${authority.indexed_metadata.confidence}; completeness=${authority.indexed_metadata.completeness})`,
    `- Changelog: ${authority.changelog.authority} (${authority.changelog.provenance}; ${authority.changelog.freshness}; confidence=${authority.changelog.confidence}; completeness=${authority.changelog.completeness})`,
    `- Inferred relationships: ${authority.facts.inferred_relationship.freshness}; confidence=${authority.facts.inferred_relationship.confidence}; completeness=${authority.facts.inferred_relationship.completeness}`,
    `- Result set: confidence=${authority.facts.incomplete_set.confidence}; completeness=${authority.facts.incomplete_set.completeness}`,
  ];
}
