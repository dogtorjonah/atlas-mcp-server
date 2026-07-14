# Atlas 1.0 public contract

This document is the normative public boundary for the first stable standalone
Atlas release, `@voxxo/atlas@1.0.0`. It describes the target release contract,
not a claim that every item is already present in the current `0.1.0`
implementation. Release conformance tests must derive their fixtures from this
document and fail until the implementation and exact npm artifact agree with it.

`ARCHITECTURE.md` governs internal dependency direction and host boundaries. When
an implementation detail conflicts with this document, this public contract wins
for callers and the architecture must be reconciled before release.

## Compatibility and versioning

- npm exports, exported TypeScript names, CLI commands and flags, MCP tool/action
  names, canonical request fields, structured result fields, error codes, and
  documented environment variables follow semantic versioning.
- The serialized protocol version is the string `"1"`. Additive optional fields,
  new error details, and new capability values may appear in a minor release.
  Removing or reinterpreting an existing field, action, error code, or enum value
  requires the next major release.
- MCP `content` and CLI text output are human renderings and may improve in minor
  releases. MCP `structuredContent` and CLI `--format json` return the stable
  envelope defined below. Consumers must not parse the text rendering.
- Unknown request fields are rejected. Unknown response fields must be ignored.
  Enum values are closed within protocol version 1 unless a field explicitly says
  it is an extension identifier.
- Dates are ISO 8601 UTC strings. Public source paths are normalized,
  repository-relative POSIX paths. Counts, offsets, line numbers, and IDs are
  integers; source lines are one-indexed.
- Deterministic operations define stable tie-breaking. A capability failure may
  change status metadata, but optional embeddings or provenance cannot silently
  change the lexical fallback items, lexical scores, or lexical ordering.
- Character limits are reported as characters. Context and billing token fields
  are present only when backed by measured provider or host telemetry; Atlas does
  not estimate tokens from text length.

The `1.0.0` release is intentionally breaking relative to `0.1.0`. The final
section lists every supported compatibility alias and its removal release.

## Package exports

Only the following package subpaths are public in 1.x. Internal `dist/*` paths and
unlisted source files are not importable contracts.

| Import | Stable purpose | Principal exports |
|---|---|---|
| `@voxxo/atlas` | Recommended composition entrypoint | `createAtlas`, `createAtlasService`, public errors, protocol/version constants, public types |
| `@voxxo/atlas/core` | Dependency-free deterministic records and algorithms | record/query/graph types, canonicalization and ranking functions |
| `@voxxo/atlas/service` | Host-neutral async application service | `AtlasService`, `createAtlasService`, port and operation-option types |
| `@voxxo/atlas/sqlite` | Default persistence adapter | `createSqliteAtlasStore`, SQLite options and capability types; no raw driver handle |
| `@voxxo/atlas/mcp` | MCP transport adapter | `createAtlasMcpServer`, `registerAtlasMcpTools`, MCP adapter options |
| `@voxxo/atlas/node` | Node host preset | layout/config resolvers, repository source, worker endpoint, parser registry factories |
| `@voxxo/atlas/types` | Type-only convenience export | all documented public request, result, error, record, and port types |

Every entrypoint is ESM, has declarations, is side-effect free on import, and
performs no filesystem, environment, database, worker, network, or MCP startup
work until a documented factory is called. `AtlasService.close()` is async and
idempotent. Public methods never return a `better-sqlite3` handle, statement,
transaction callback, worker object, MCP SDK object, or process-global singleton.

The package exposes two bins during 1.x:

- `atlas` is canonical.
- `atlas-mcp` is a compatibility alias for `atlas mcp` and is removed in 2.0.

## Programmatic service

The stable application surface is deliberately small:

```ts
interface AtlasService {
  query(request: AtlasQueryRequest, options?: AtlasOperationOptions): Promise<AtlasResult<AtlasQueryData>>;
  graph(request: AtlasGraphRequest, options?: AtlasOperationOptions): Promise<AtlasResult<AtlasGraphData>>;
  audit(request: AtlasAuditRequest, options?: AtlasOperationOptions): Promise<AtlasResult<AtlasAuditData>>;
  commit(request: AtlasCommitRequest, options?: AtlasOperationOptions): Promise<AtlasResult<AtlasCommitData>>;
  index(request: AtlasIndexRequest, options?: AtlasOperationOptions): Promise<AtlasResult<AtlasIndexData>>;
  admin(request: AtlasAdminRequest, options?: AtlasOperationOptions): Promise<AtlasResult<AtlasAdminData>>;
  close(): Promise<void>;
}

interface AtlasOperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number; // service derives the supervisor-owned monotonic deadline
  requestId?: string;
}
```

Diff, snapshot, changelog, and repository-freshness operations are typed query
variants internally. The MCP adapter retains focused tool names for discovery and
maps them to these service requests. `index` is a first-class programmatic method
because initial and incremental indexing have progress/cancellation semantics that
do not fit a generic administration command.

Programmatic TypeScript request properties use `camelCase`. Serialized MCP and CLI
JSON use the `snake_case` spellings below. The package exports explicit
`encodeAtlasRequest` and `decodeAtlasRequest` helpers; callers do not infer the
mapping by changing case mechanically.

## Structured result envelope

Every programmatic method, MCP tool, and CLI JSON command uses one discriminated
envelope. An expected operational failure is data, not an exception. Factories may
throw configuration or construction errors before a service exists; a programming
bug may reject a promise only after being converted to `ATLAS_INTERNAL` at a
transport boundary.

```ts
type AtlasResult<T> = AtlasSuccess<T> | AtlasFailure;

interface AtlasSuccess<T> {
  protocol_version: '1';
  ok: true;
  request_id: string;
  data: T;
  meta: AtlasResultMeta;
}

interface AtlasFailure {
  protocol_version: '1';
  ok: false;
  request_id: string;
  error: AtlasError;
  meta: AtlasResultMeta;
}

interface AtlasResultMeta {
  workspace?: string;
  repository_id?: string;
  capabilities: Record<string, 'available' | 'degraded' | 'unavailable' | 'disabled'>;
  warnings: AtlasWarning[];
  page?: {
    next_cursor: string | null;
    returned: number;
    total?: number;
    truncated: boolean;
  };
  evidence?: {
    authority: 'workspace_disk' | 'atlas_store' | 'repository' | 'provider' | 'mixed' | 'unknown';
    freshness: 'current' | 'stale' | 'historical' | 'unknown';
    confidence: 'high' | 'medium' | 'low' | 'unknown';
    completeness: 'complete' | 'partial' | 'not_applicable' | 'unknown';
  };
  extensions: AtlasProvenanceEvidenceWire[];
}

interface AtlasWarning {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
```

List data uses `{ items: T[] }`; pagination lives only in `meta.page`. Cursors are
opaque and bound to the normalized request, workspace, ordering, and store
generation. Reusing a cursor with different inputs is `ATLAS_INVALID_REQUEST`.
Text and source-bearing results include explicit truncation metadata; absence of a
capability is never represented as an authoritative empty result.

For MCP, `structuredContent` is the envelope and `content` contains a text rendering
of the same outcome. `isError` is `true` when `ok` is `false`. For CLI JSON, stdout
contains exactly one envelope and diagnostics go to stderr.

## Errors

```ts
interface AtlasError {
  code: AtlasErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  actions?: ReadonlyArray<{ label: string; command?: string; documentation?: string }>;
  cause_code?: string;
}
```

The following codes are stable in protocol version 1:

| Code | Meaning | Retryable by default |
|---|---|---:|
| `ATLAS_INVALID_REQUEST` | Schema, range, cursor, or mutually-exclusive-field failure | no |
| `ATLAS_UNSUPPORTED_ACTION` | Tool exists but the action is not defined | no |
| `ATLAS_NOT_FOUND` | Requested file, symbol, snapshot, changelog, or record is absent | no |
| `ATLAS_WORKSPACE_NOT_FOUND` | Explicit registered workspace is absent | no |
| `ATLAS_PATH_OUTSIDE_REPOSITORY` | A source or state path escapes its authorized root | no |
| `ATLAS_PERMISSION_DENIED` | Policy or adapter denied the operation | no |
| `ATLAS_CAPABILITY_UNAVAILABLE` | Optional adapter/capability is disabled or unavailable | no |
| `ATLAS_BUSY` | Bounded queue admission failed | yes |
| `ATLAS_DEADLINE_EXCEEDED` | Supervisor deadline expired | yes |
| `ATLAS_CANCELLED` | Caller aborted before a terminal result | caller-dependent |
| `ATLAS_STORE_LOCKED` | Another writer owns the canonical store lock | yes |
| `ATLAS_WRITE_CONFLICT` | Optimistic version or idempotency conflict | caller-dependent |
| `ATLAS_INDETERMINATE_WRITE` | Worker died after write dispatch without durable acknowledgement | no automatic retry |
| `ATLAS_SCHEMA_NEWER` | Store schema is newer than this package supports | no |
| `ATLAS_SCHEMA_HISTORY_DIVERGED` | Migration names/order differ from the supported lineage | no |
| `ATLAS_SCHEMA_CHECKSUM_MISMATCH` | A known migration's executable SQL does not match | no |
| `ATLAS_SCHEMA_WRONG_DOMAIN` | Database belongs to an unsupported product/schema domain | no |
| `ATLAS_STORE_IDENTITY_MISMATCH` | Database repository identity differs from the resolved repository | no |
| `ATLAS_STORE_CORRUPT` | SQLite integrity or required relationships failed | no |
| `ATLAS_IO_ERROR` | Worker-owned database/filesystem/repository I/O failed | usually yes |
| `ATLAS_INTERNAL` | Sanitized unexpected implementation failure | no |

`cause_code` may preserve an adapter code, but consumers branch only on `code`.
Messages are actionable human text, not a parsing contract. Schema/store failures
include detected and supported generations, database path in redacted form,
verified backup IDs when available, and safe next actions.

## MCP tools

The 1.x server registers the following tools. Canonical field names are
`snake_case`. Fields not listed for a tool are rejected. Strings are non-empty
after trimming; limits are positive integers unless a field states otherwise.

| Tool | Status in 1.x | Action names |
|---|---|---|
| `atlas_query` | canonical | `search`, `lookup`, `brief`, `snippet`, `similar`, `plan_context`, `cluster`, `patterns`, `history`, `catalog`, `ask` |
| `atlas_graph` | canonical | `impact`, `neighbors`, `trace`, `cycles`, `reachability`, `graph`, `cluster` |
| `atlas_audit` | canonical | `gaps`, `smells`, `hotspots` |
| `atlas_commit` | canonical | no action discriminator |
| `atlas_admin` | canonical | `index`, `migrate`, `backup`, `doctor`, `workspace_list` |
| `atlas_diff` | canonical | no action discriminator |
| `atlas_snapshot` | canonical | no action discriminator |
| `atlas_worktree_status` | canonical | no action discriminator |
| `atlas_worktree_diff` | canonical | no action discriminator |
| `atlas_changelog` | deprecated compatibility tool | `query`; maps to `atlas_query(history)`; removed in 2.0 |
| `atlas_changelog_diff` | deprecated compatibility tool | maps to `atlas_diff`; removed in 2.0 |

All tools accept optional `workspace`. `format: "text" | "json"` controls only the
human `content` rendering; structured content is always present and has the same
shape. `limit`, `offset`, and `cursor` are mutually constrained by the action:
cursor pagination is canonical; `offset` remains a 1.x compatibility input for
stable store-backed listings and is removed in 2.0.

Unless an action states a narrower bound: `query`, paths, symbols, labels, and
extension identifiers are at most 8,192 characters; `limit` defaults to 20 and is
between 1 and 500; `cursor` is at most 4,096 characters; `character_budget` is
between 1 and 200,000; line numbers are between 1 and 10,000,000; and request
arrays contain at most 200 items. `source_highlights` contains at most 50 entries,
each with `start_line <= end_line`. `max_lines` is at most 5,000,
`context_lines` is between 0 and 20, `max_files` is at most 100,
`max_untracked` is at most 1,000, `max_results` is at most 2,000, and
`scan_limit` is at most 100,000. `max_nodes` is at most 2,000 and `max_edges` is
at most 10,000. Numeric values must be finite; booleans are JSON booleans, not
truthy strings, in the canonical schema.

### `atlas_query`

Shared optional fields are `workspace`, `format`, `limit`, and `cursor`.

| Action | Required fields | Additional optional fields |
|---|---|---|
| `search` | `query` | `workspaces`, `path_prefix`, `cluster`, `include_test_files` |
| `lookup` | `file_path` | `include_source`, `include_neighbors`, `include_cross_refs`, `source_start`, `source_end` |
| `brief` | `file_path` | none |
| `snippet` | `file_path` and either `symbol` or a line range | `start_line`, `end_line` |
| `similar` | `file_path` | `min_score`, `include_test_files` |
| `plan_context` | `query` | `include_neighbors`, `neighbor_depth`, `character_budget`, `include_test_files` |
| `cluster` | none; omitted `cluster` lists clusters | `cluster`, `path_prefix`, `include_test_files` |
| `patterns` | none; omitted `pattern` lists patterns | `pattern`, `file_path`, `include_test_files` |
| `history` | none | `mode`, `file_path`, `cluster`, `query`, `since`, `until`, `order`, `bucket`, `group_by`, `breaking_changes`, `principal_id`, `runtime_name`, `verification_status` |
| `catalog` | none | `query`, `path_prefix`, `cluster`, `field`, `include_test_files` |
| `ask` | `query` | `workspaces`, `path_prefix`, `include_test_files`, `character_budget` |

`history.mode` is `entries | count | timeline | group` (default `entries`);
`order` is `asc | desc`; `bucket` is `day | week | month`; `group_by` is
`file_path | cluster | principal_id | runtime_name | verification_status`.
`field` is `blurb | purpose`. A snippet line range requires
`1 <= start_line <= end_line`; a symbol and line range cannot both be supplied.

### `atlas_graph`

Shared optional fields are `workspace`, `format`, `include_test_files`, `limit`,
`max_nodes`, and `max_edges`.

| Action | Required fields | Additional optional fields |
|---|---|---|
| `impact` | `file_path` | `symbol`, `depth`, `edge_types`, `include_references`, `include_symbols` |
| `neighbors` | `file_path` | `depth`, `direction`, `edge_types`, `include_references`, `include_symbols` |
| `trace` | `from` and `to`, or `from_symbol` and `to_symbol` | `max_hops`, `weighted`, `edge_types` |
| `cycles` | none | `file_path`, `min_size`, `edge_types` |
| `reachability` | `mode` | `file_path`, `from`, `to`, `symbol`, `direction`, `include_symbols` |
| `graph` | none | `file_path`, `depth`, `direction`, `edge_types`, `include_symbols` |
| `cluster` | `cluster` | none |

`direction` is `imports | importers | both`. `reachability.mode` is
`dead_exports | dead_files | path_query | entrypoints`. Edge-type strings are a
versioned public enum exported from `@voxxo/atlas/types`; unknown values fail.

### `atlas_audit`

The required field is `action`. Shared optional fields are `workspace`, `format`,
`cluster`, `file_path`, `limit`, and `include_test_files`.

- `gaps` additionally accepts `gap_types`.
- `smells` additionally accepts `min_severity` and `weights`.
- `hotspots` additionally accepts `since`, `top_n`, and `risk_weights`.

Weights are finite non-negative numbers and are normalized deterministically.
Unknown gap types or weight keys fail rather than being ignored.

### `atlas_commit`

`file_path` and `changelog_entry` are required. The canonical request is:

```ts
interface AtlasCommitWireRequest {
  file_path: string;
  changelog_entry: string;
  idempotency_key?: string;
  expected_version?: string;
  purpose?: string;
  blurb?: string;
  cluster?: string;
  tags?: string[];
  conventions?: string[];
  key_types?: string[];
  data_flows?: string[];
  public_api?: Array<{
    name: string;
    type: string;
    signature?: string;
    description?: string;
  }>;
  source_highlights?: Array<{
    id?: number;
    label: string;
    start_line: number;
    end_line: number;
    content?: string;
  }>;
  patterns?: string[];
  hazards?: string[];
  patterns_added?: string[];
  patterns_removed?: string[];
  hazards_added?: string[];
  hazards_removed?: string[];
  breaking_changes?: boolean;
  repository_revision?: string;
  attribution?: AtlasAttributionWire;
  evidence?: AtlasProvenanceEvidenceWire[];
  response_detail?: 'compact' | 'full';
}

interface AtlasAttributionWire {
  principal?: {
    id?: string;
    display_name?: string;
    kind: 'human' | 'service' | 'automation' | 'unknown';
  };
  runtime?: { name?: string; version?: string };
  tool_id?: string;
  source?: string;
}

interface AtlasProvenanceEvidenceWire {
  namespace: string;
  schema_version: string;
  provider_id: string;
  provider_version: string;
  evidence_id: string;
  subject: {
    kind: 'file' | 'symbol' | 'snapshot' | 'changelog' | 'operation';
    workspace: string;
    key: string;
  };
  kind: 'authored' | 'observed' | 'modified' | 'committed' | 'reviewed' | 'referenced' | 'other';
  principal?: AtlasAttributionWire['principal'];
  occurred_at?: string;
  observed_at: string;
  authority: 'caller' | 'repository' | 'provider' | 'verified-external';
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  source_ref?: string;
  payload: unknown;
  payload_hash: string;
}
```

The server validates repository-relative paths, line ranges, bounded arrays,
evidence namespaces/versions, and identity completeness before beginning the
semantic write command. `idempotency_key` replays the original terminal result for
the same normalized fingerprint and returns `ATLAS_WRITE_CONFLICT` for a different
fingerprint. `expected_version` provides optional optimistic concurrency. Required
evidence and the core write commit atomically.

The public attribution shape is only `principal`, `runtime`, `tool_id`, and
`source`, as defined in `ARCHITECTURE.md`. There are no top-level agent, instance,
engine, model, reviewer, witness, room, rail, or operator-personal fields.

### Administration and focused read tools

`atlas_admin` has these canonical request variants:

| Action | Required fields | Optional fields |
|---|---|---|
| `index` | none | `paths`, `full`, `phase`, `force` |
| `migrate` | none | `dry_run`, `backup`, `target_generation` |
| `backup` | none | `label`, `protected` |
| `doctor` | none | `checks`, `include_optional` |
| `workspace_list` | none | `include_unavailable` |

`phase` is `all | discovery | parse | crossref | embeddings`. Migration and index
requests return bounded progress summaries, never a live worker or database
handle. Restore, delete, repository lifecycle mutation, and destructive reset are
not exposed by the default MCP server.

Focused read schemas are:

- `atlas_diff`: required `file_path`, `from`, `to`; optional
  `mode: "unified" | "stat"`, `workspace`, `context_lines`.
- `atlas_snapshot`: optional `changelog_id`, `file_path`, and `at`, with at least
  one resolvable subject; optional `start_line`, `end_line`, `max_lines`,
  `workspace`.
- `atlas_worktree_status`: optional `file_path`, `paths`, `include_untracked`,
  `max_untracked`, `max_results`, `scan_limit`, `workspace`.
- `atlas_worktree_diff`: optional `file_path`, `paths`,
  `mode: "unified" | "stat"`, `context_lines`, `max_files`, `workspace`.
- Compatibility `atlas_changelog`: required `action: "query"`; optional `file`,
  `file_prefix`, `query`, `cluster`, `since`, `until`, `verification_status`,
  `breaking_only`, `include_diff`, `limit`, `workspace`.
- Compatibility `atlas_changelog_diff`: required positive `changelog_id`;
  optional `from`, `to`, `mode`, and `workspace`.

Diff endpoints are a positive changelog ID, ISO timestamp, `latest`, or `prev` in
the combinations documented by the exported schema. Compatibility
`atlas_changelog_diff` additionally accepts `changelog` for its selected ID.

## CLI

The canonical executable grammar is:

```text
atlas init [repository] [--data-mode project|user] [--no-index]
atlas mcp [--transport stdio]
atlas index [path ...] [--full] [--phase <phase>]
atlas watch [path ...] [--debounce-ms <milliseconds>]
atlas query <action> [request flags]
atlas graph <action> [request flags]
atlas audit <action> [request flags]
atlas commit --request <json|@file|->
atlas diff [request flags]
atlas snapshot [request flags]
atlas worktree status [request flags]
atlas worktree diff [request flags]
atlas migrate [--dry-run] [--no-backup]
atlas backup [--label <label>] [--protected]
atlas doctor [--include-optional]
atlas workspace list [--include-unavailable]
atlas config show [--show-sources]
```

All commands accept `--source-root`, `--workspace`, `--config`, and
`--format text|json` where applicable. Domain flags use the MCP wire names with
hyphens (`--file-path` maps to `file_path`). `--request` accepts an inline JSON
object, `@path`, or `-` for stdin and is mutually exclusive with domain request
flags. `config show` is redacted and never reveals credential values.

`atlas init` creates guarded state and repository identity; it does not edit a
global MCP client configuration, root `.gitignore`, shell profile, or unrelated
repository. Installation into a client is a separate client-specific integration,
not a core Atlas command. `atlas watch` is an explicit optional Node host that
debounces repository changes and calls the same bounded indexing service; it never
opens the store or runs parser/database work inline. `atlas mcp` is the canonical
MCP server command. During 1.x, invoking `atlas` with no command behaves as
`atlas mcp` and emits a deprecation warning to stderr only; this behavior is
removed in 2.0.

Stable exit codes are:

| Code | Meaning |
|---:|---|
| `0` | success |
| `2` | invalid command or request |
| `3` | requested subject/workspace not found |
| `4` | capability unavailable, permission denied, busy, locked, deadline, or cancellation |
| `5` | incompatible, corrupt, identity-mismatched, or failed store/I/O |
| `70` | sanitized internal failure |

In JSON mode the envelope error code is authoritative; the process exit code is a
coarse shell category.

## Environment variables

Only these Atlas-prefixed variables are read by the Node preset. Empty values are
treated as unset; invalid values fail with `ATLAS_INVALID_REQUEST` and name their
configuration source.

| Variable | Value |
|---|---|
| `ATLAS_SOURCE_ROOT` | Explicit repository root, resolved from the caller's current directory then canonicalized |
| `ATLAS_WORKSPACE` | Non-empty public workspace label; not repository identity |
| `ATLAS_CONFIG_PATH` | Explicit config file path |
| `ATLAS_DATA_MODE` | `project` or `user` |
| `ATLAS_DB_PATH` | Explicit database override subject to identity and safe-path validation |
| `ATLAS_CONCURRENCY` | Positive worker concurrency |
| `ATLAS_QUEUE_CAPACITY` | Positive bounded admission capacity |
| `ATLAS_OPERATION_TIMEOUT_MS` | Positive default supervisor timeout in milliseconds |
| `ATLAS_SQLITE_VEC_EXTENSION` | Explicit sqlite-vec extension path |
| `ATLAS_EMBEDDING_PROVIDER` | Registered provider ID; no implicit network provider |
| `ATLAS_EMBEDDING_MODEL` | Provider model identifier |
| `ATLAS_EMBEDDING_REVISION` | Immutable provider/model revision |
| `ATLAS_EMBEDDING_DIMENSIONS` | Positive vector dimension |
| `ATLAS_SNAPSHOT_WINDOW` | Positive retained snapshot count per file |
| `ATLAS_LOG_LEVEL` | `silent`, `error`, `warn`, `info`, or `debug` |
| `ATLAS_OUTPUT` | CLI default `text` or `json`; ignored by MCP |

`XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, and `XDG_RUNTIME_DIR` are
standard platform layout inputs, not Atlas configuration keys. The Node preset
uses documented platform fallbacks when they are absent.

Core Atlas defines no API-key, token, private-key, authorization-header, telemetry,
relay, agent, or vendor-specific environment variable. Optional providers own a
documented, provider-prefixed namespace and receive secrets directly; the core
config object retains only redacted presence/source metadata.

Precedence is programmatic options, CLI flags, the variables above,
`.atlas/config.local.json`, repository `atlas.config.json`, user config, then
built-in defaults. The historical `.atlas/.env` file is a deprecated compatibility
input below local JSON and above repository config; new initialization never
writes it. Support ends in 2.0.

## Deprecations and explicit 1.0 breaking changes

Aliases are accepted only at MCP/CLI decoding or explicit compatibility exports;
normalized service requests never contain them. Use emits
`ATLAS_DEPRECATED_ALIAS` in `meta.warnings` with `replacement` and
`removal_version`. Canonical and alias values that disagree are
`ATLAS_INVALID_REQUEST`; canonical values never silently win.

| 0.1 surface | 1.x treatment | Removal |
|---|---|---|
| package `./db` | compatibility facade over async `./sqlite`; synchronous driver/statement exports are absent | 2.0 |
| package `./paths` | compatibility facade over `./node` path helpers | 2.0 |
| package `./types` | remains canonical | none |
| package `./pipeline` | removed; indexing is `AtlasService.index` / `atlas index` | 1.0 |
| `atlas-mcp` bin | alias for `atlas mcp` | 2.0 |
| `atlas` with no command | alias for `atlas mcp` | 2.0 |
| `atlas_changelog` | alias for `atlas_query action=history` | 2.0 |
| `atlas_changelog_diff` | alias for `atlas_diff` with `changelog_id` | 2.0 |
| `atlas_admin action=reindex` | alias for `action=index` | 2.0 |
| `atlas_admin action=bridge_list` | alias for `action=workspace_list` | 2.0 |
| `atlas_admin action=init` | removed from MCP; use non-destructive CLI `atlas init` or canonical admin actions | 1.0 |
| camelCase MCP fields such as `filePath`, `pathPrefix`, `includeSource`, `includeReferences`, `maxNodes`, `gapTypes`, `topN` | accepted and normalized to listed snake_case fields | 2.0 |
| query `target` | accepted as `field` | 2.0 |
| commit `filepath` or `path` | accepted as `file_path` | 2.0 |
| commit `summary`, `change_summary`, `changeSummary`, `rationale`, or `description` | accepted as `changelog_entry` | 2.0 |
| commit camelCase metadata names and JSON-string/list shorthand | accepted after strict unambiguous normalization | 2.0 |
| `commit_sha` | accepted as `repository_revision` | 2.0 |
| `quiet` | accepted as `response_detail: "compact" | "full"` | 2.0 |
| `offset` pagination | accepted where deterministic offset pagination exists | 2.0 |
| `.atlas/.env` | read-only compatibility config input | 2.0 |

The following are breaking removals in 1.0 and are not aliases:

- top-level `author_instance_id`, `author_engine`, `review_entry_id`, model, agent,
  witness, and personal-operator fields in requests or responses;
- historical file-witness/activity enums as core public types;
- direct synchronous database functions, raw SQLite handles/statements, and
  transaction callbacks;
- implicit current-directory root selection without a repository/config marker;
- implicit global client configuration edits during initialization;
- text-only success/error results and parsing human prose as protocol data;
- provider-defined top-level response keys or provider-owned core migrations;
- destructive reset/restore/delete and repository lifecycle mutation in the
  default MCP tool set.

Historical storage columns remain readable only inside migration/compatibility
adapters and map to neutral attribution/evidence with explicit historical
authority. They do not appear in generated schemas, declarations, MCP tool
descriptions, CLI help, examples, or new writes.

## Release conformance

The exact release artifact must prove:

1. the package exports and bins above resolve from a clean install without import
   side effects;
2. generated declarations match the programmatic interfaces and contain no
   excluded production vocabulary;
3. every MCP tool/action schema accepts canonical fixtures, rejects unknown or
   invalid fields, and returns the shared structured envelope;
4. CLI JSON fixtures match MCP/programmatic results and exit-code mapping;
5. every documented environment variable has precedence, redaction, invalid-value,
   and absence coverage, while undocumented `ATLAS_*` keys are ignored by core;
6. each compatibility alias emits its exact warning and has a removal-version
   assertion; no alias bypasses validation, authorization, idempotency, worker
   ownership, or secret redaction;
7. fresh and upgraded databases expose the same public contract and no historical
   production-only field enters a current result;
8. the packed tarball includes this document and the implementation-generated
   machine-readable protocol schema used by conformance tests.
