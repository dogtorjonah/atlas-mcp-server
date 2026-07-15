# Atlas 1.x public contract

This document is the normative compatibility boundary for `@voxxo/atlas` 1.x.
Implementation details may change without notice unless they are listed here.

## Compatibility rules

- Package entrypoints, exported TypeScript names, CLI commands and flags, MCP
  tool/action names, canonical request fields, result fields, and error codes
  follow semantic versioning.
- The serialized protocol version is the string `"1"`.
- Programmatic TypeScript requests use camelCase. MCP and CLI JSON use the
  documented snake_case wire spelling.
- MCP `structuredContent` and CLI `--format json` are stable. Human text may
  improve in minor releases and must not be parsed.
- Repository source paths are normalized repository-relative POSIX paths.
  Source lines are one-indexed.
- Deterministic operations use stable tie-breaking. Optional capabilities may
  add labeled results but may not reorder the lexical fallback.
- Token values are present only when copied from measured host/provider
  telemetry. Atlas does not estimate tokens from characters or bytes.

## Package entrypoints

| Import | Purpose |
|---|---|
| `@voxxo/atlas` | Aggregate public API |
| `@voxxo/atlas/service` | Async application service |
| `@voxxo/atlas/persistence` | Worker-backed SQLite store and supervisor |
| `@voxxo/atlas/indexing` | Index requests, results, watcher, and batcher |
| `@voxxo/atlas/writeback` | Atomic commit executor |
| `@voxxo/atlas/admin` | Administration executor contracts |
| `@voxxo/atlas/embedding` | Explicit optional embedding controller |
| `@voxxo/atlas/mcp` | MCP adapter |
| `@voxxo/atlas/node` | Node layout and composition root |
| `@voxxo/atlas/db` | Synchronous database compatibility API |
| `@voxxo/atlas/paths` | Migration and path compatibility helpers |
| `@voxxo/atlas/types` | Legacy record types |
| `@voxxo/atlas/pipeline` | Low-level indexing pipeline compatibility API |

Every entrypoint is ESM and inert on import. The `db` and `pipeline` subpaths
are low-level 1.x compatibility exports and may perform synchronous work when
their functions are called. New request-driven hosts should use `node`,
`service`, and `persistence`.

The package exposes `atlas` and the 1.x compatibility alias `atlas-mcp`.

## Node composition root

```ts
const host = await openAtlasNodeHost({
  sourceRoot: '/absolute/repository',
  dataMode: 'project', // or 'user'
  workspace: 'optional-name',
  dbPath: '/optional/explicit.sqlite',
});

host.service;
host.store;
host.layout;
await host.close();
```

Opening the host validates and migrates the store in its worker. Closing is
asynchronous and idempotent. Project mode defaults to `.atlas/atlas.sqlite`
beneath the source root. User mode derives a canonical workspace identity under
the platform user-data directory.

## Application service

```ts
interface AtlasService {
  query(request: AtlasQueryRequest, options?: AtlasOperationOptions):
    Promise<AtlasResult<AtlasQueryData>>;
  graph(request: AtlasGraphRequest, options?: AtlasOperationOptions):
    Promise<AtlasResult<AtlasGraphData>>;
  audit(request: AtlasAuditRequest, options?: AtlasOperationOptions):
    Promise<AtlasResult<AtlasAuditData>>;
  commit(request: AtlasCommitRequest, options?: AtlasOperationOptions):
    Promise<AtlasResult<AtlasCommitData>>;
  admin(request: AtlasAdminRequest, options?: AtlasOperationOptions):
    Promise<AtlasResult<AtlasAdminData>>;
  close(): Promise<void>;
}

interface AtlasOperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  requestId?: string;
}
```

Indexing is `admin({ action: 'index', ... })` in 1.0.0. The service normalizes
expected operational failures into results. Construction/configuration errors
may throw before a service exists.

## Result envelope

```ts
type AtlasResult<T> = {
  protocol_version: '1';
  ok: true;
  request_id: string;
  data: T;
  meta: AtlasResultMeta;
} | {
  protocol_version: '1';
  ok: false;
  request_id: string;
  error: AtlasError;
  meta: AtlasResultMeta;
};
```

`meta` includes capability statuses, warnings, optional pagination, evidence
authority/freshness/confidence/completeness, and typed extension evidence.
List pagination lives in `meta.page`; cursors are opaque and request-bound.

## Query actions

`AtlasQueryRequest` supports:

- `search`, `lookup`, `brief`, `snippet`, `similar`, `plan_context`;
- `cluster`, `patterns`, `history`, `catalog`, `ask`;
- `snapshot` and `diff`.

Source-bearing operations accept explicit line/character bounds. `ask` assembles
cited evidence and does not call an LLM. Snapshot and diff can identify state by
file plus timestamp/changelog endpoint or by changelog ID.

## Graph actions

`AtlasGraphRequest` supports `impact`, `neighbors`, `trace`, `cycles`,
`reachability`, `graph`, and `cluster`. Request bounds include depth, hops,
nodes, edges, directions, edge types, and test/reference inclusion.

## Audit actions

`AtlasAuditRequest` supports `gaps`, `smells`, and `hotspots` with bounded
filters. Audit findings are deterministic signals, not authoritative proof that
source is unused or defective.

## Commit

`AtlasCommitRequest` requires `filePath` and `changelogEntry`. It can add purpose,
blurb, tags, conventions, types, data flows, public API entries, source
highlights, patterns, hazards, attribution, and provenance evidence.

- `idempotencyKey` makes identical retry payloads return the durable result.
- Reusing a key for different content is `ATLAS_WRITE_CONFLICT`.
- `expectedVersion` provides optimistic concurrency.
- Source highlights are repository-current, one-indexed ranges.
- Evidence uses explicit namespace, schema/provider identities, subject,
  authority, confidence, payload, and payload hash.

## Administration

`AtlasAdminRequest` supports:

- `index`: full, incremental, or repair indexing with optional paths/phases;
- `migrate`: dry-run, verified backup, and target-generation checks;
- `backup`: optional label/protection;
- `doctor`: selected integrity/schema/lexical/optional checks;
- `workspace_list`: registered workspace availability.

## Persistence behavior

The public SQLite store owns a dedicated worker, bounded queues, deadlines,
cancellation, result/payload size checks, read fairness, and graceful shutdown.
Worker failure after write dispatch can produce `ATLAS_INDETERMINATE_WRITE`;
callers must reconcile durable state before retrying. Atlas never presents a
failed inline synchronous fallback as equivalent.

Migrations are ordered SQL files with recorded checksums. Newer, divergent,
wrong-domain, corrupt, or checksum-mismatched stores fail closed. Backups use
SQLite's backup path and receive integrity verification.

## Embeddings

Embeddings are optional. A provider supplies a stable identity consisting of
provider, model, dimensions, normalization, and metric. Vector input/output
bounds are enforced. Missing providers, provider failures, dimension drift, or
incomplete coverage produce labeled lexical fallback rather than an
authoritative empty result.

## MCP

The canonical 1.x tools are:

| Tool | Actions |
|---|---|
| `atlas_query` | query actions listed above |
| `atlas_graph` | graph actions listed above |
| `atlas_audit` | audit actions listed above |
| `atlas_commit` | one commit request |
| `atlas_admin` | administration actions listed above |

The strict adapter rejects unknown request fields. It places the protocol
envelope in `structuredContent`, renders equivalent human text in `content`,
and sets MCP `isError` for failed Atlas results. Cancellation is forwarded.

The following focused aliases remain through 1.x: `atlas_snapshot`,
`atlas_diff`, `atlas_changelog_diff`, `atlas_worktree_status`, and
`atlas_worktree_diff`.

## CLI

Stable command grammar:

```text
atlas init [repository]
atlas config show
atlas index [path ...]
atlas migrate
atlas backup
atlas doctor
atlas workspace list
atlas watch [path-prefix ...]
atlas query <action>
atlas graph <action>
atlas audit <action>
atlas commit --request <json|@file|->
atlas snapshot
atlas diff
atlas mcp
```

`--format json` emits one envelope on stdout; diagnostics use stderr. Exit codes
are 0 success, 2 invalid command/request, 3 not found, 4 temporary/capability
failure, and 5 internal/I/O failure.

## Error codes

Stable protocol-v1 codes include:

- `ATLAS_INVALID_REQUEST`, `ATLAS_UNSUPPORTED_ACTION`, `ATLAS_NOT_FOUND`,
  `ATLAS_WORKSPACE_NOT_FOUND`, `ATLAS_PATH_OUTSIDE_REPOSITORY`,
  `ATLAS_PERMISSION_DENIED`, `ATLAS_CAPABILITY_UNAVAILABLE`;
- `ATLAS_BUSY`, `ATLAS_DEADLINE_EXCEEDED`, `ATLAS_CANCELLED`,
  `ATLAS_STORE_LOCKED`, `ATLAS_WRITE_CONFLICT`,
  `ATLAS_INDETERMINATE_WRITE`;
- `ATLAS_SCHEMA_NEWER`, `ATLAS_SCHEMA_HISTORY_DIVERGED`,
  `ATLAS_SCHEMA_CHECKSUM_MISMATCH`, `ATLAS_SCHEMA_WRONG_DOMAIN`,
  `ATLAS_STORE_IDENTITY_MISMATCH`, `ATLAS_STORE_CORRUPT`;
- `ATLAS_IO_ERROR` and `ATLAS_INTERNAL`.

Consumers branch on `error.code`, not message text or adapter `cause_code`.

## Deprecation policy

Deprecated 1.x aliases remain functional through the major line and are removed
only in 2.0 or later. The alias and replacement are documented before removal.
Low-level compatibility entrypoints stay available in 1.x but do not gain new
application-service guarantees.
