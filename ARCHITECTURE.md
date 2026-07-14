# Standalone Atlas Architecture

This document defines the target public architecture for Atlas `1.0.0`. It is a
contract for the promotion work, not a claim that every boundary is already
implemented. Compatibility shims may remain during the transition, but new code
must follow the dependency rules below.

## Architectural invariants

1. The deterministic core has no filesystem, database, network, MCP, process,
   environment, clock, or model dependency.
2. Every public operation that may perform I/O is asynchronous and accepts
   cancellation. A function returning a promise must not hide synchronous SQLite
   or filesystem work on the caller's thread.
3. The default SQLite adapter owns its connection in a worker thread or separate
   process. MCP, CLI, HTTP, watcher, and timer callbacks never execute blocking
   database calls inline.
4. MCP is a transport adapter, not the application. The same service object powers
   MCP, CLI commands, tests, and programmatic consumers.
5. Optional capabilities are injected through explicit interfaces. Missing
   embeddings, provenance, repository lifecycle, or integration hooks degrade to
   documented behavior; Atlas never fabricates results.
6. Host attribution is optional. No instance, squad, transcript, relay, process
   manager, or private domain is required to use the core.
7. Identical logical inputs, stored state, configuration, and injected clock yield
   identical logical outputs and ordering.
8. Context Warp Drive remains a separate package. Its adapter may consume public
   Atlas metadata, but neither core depends on the other.

## Dependency direction

```text
CLI host       MCP transport       Programmatic consumer
    \               |                       /
     +--------- application services ------+
                         |
          deterministic domain/query core
                         |
        ports (store, source, clock, optional providers)
          /              |                 \
 SQLite worker     Node repository     optional adapters
                                      embeddings/provenance/
                                      Context Warp/host events
```

Dependencies point downward only. Adapters may import contracts and service
factories. Core and services never import a concrete adapter, CLI, MCP SDK, or host
integration.

## Layer contracts

| Layer | Responsibility | May depend on | Must not depend on |
| --- | --- | --- | --- |
| Contracts | Stable request/result records, errors, budgets, attribution, events, and port interfaces | TypeScript only | SQLite, Node filesystem, MCP SDK, model SDKs |
| Core | Normalization, ranking, deduplication, graph algorithms, diffing, completeness, hazard logic, and deterministic indexing transforms | Contracts | I/O, environment, wall clock, transports |
| Application services | Query, lookup, history, graph, audit, commit, indexing, admin, and lifecycle use cases | Core and ports | Concrete SQLite, MCP, CLI, private host state |
| Persistence port | Async repository for Atlas records, graph edges, history, snapshots, migrations, and transactions | Contracts | Tool rendering and transport schemas |
| Indexing | Orchestrates source discovery, parsing, hashing, structure, flow, cross-reference, and community passes | Services, repository source, parser ports | Ambient host directories or implicit network access |
| MCP transport | Zod validation, MCP resource/tool registration, cancellation mapping, and content rendering | Application service interface, MCP SDK | SQLite driver, file walking, domain-specific business logic |
| Node host | Configuration, CLI parsing, worker startup, watcher lifecycle, signals, and adapter assembly | Public factories and concrete Node adapters | Private process-manager names or relay lifecycle assumptions |
| Optional integrations | Embeddings, provenance, repository lifecycle, telemetry, and Context Warp metadata adapters | Public ports only | Core internals or database handles |

## Domain and contracts layer

Public records describe codebase intelligence, not a particular host. Stable
contracts include:

- files, symbols, references, source chunks, imports, snapshots, and hashes;
- changelog entries, verification state, explicit author attribution, and recovery
  keys;
- patterns, conventions, hazards, ranged hazards, highlights, and completeness;
- search, lookup, graph, history, diff, audit, indexing, and commit requests and
  results;
- typed errors for invalid input, cancellation, budget exhaustion, unsupported
  capability, conflict, migration failure, and corrupt state.

The contracts layer does not expose `better-sqlite3` handles, MCP server objects,
worker task names, environment variables, or filesystem paths that only make sense
inside one host. Path values in public records are workspace-relative and use `/`
separators.

## Deterministic core

The core contains synchronous pure functions where synchronous execution is safe:

- search-text normalization and stable ranking tie-breaks;
- ranged-hazard union and deduplication;
- completeness and hygiene scoring;
- line and semantic diff construction;
- graph traversal over caller-supplied bounded records;
- deterministic commit-candidate derivation;
- parser-output normalization and cross-reference resolution;
- result shaping independent of a display transport.

Large CPU work receives an explicit budget and may be delegated by the host. Pure
does not mean unbounded. Core functions must define stable ordering and must not
call the wall clock; timestamps come from an injected clock at the service edge.

## Application service

The public programmatic boundary is an owned, closeable service rather than a
collection of database functions:

```ts
export interface AtlasApplication {
  query(request: AtlasQueryRequest, options?: AtlasOperationOptions): Promise<AtlasQueryResult>;
  graph(request: AtlasGraphRequest, options?: AtlasOperationOptions): Promise<AtlasGraphResult>;
  audit(request: AtlasAuditRequest, options?: AtlasOperationOptions): Promise<AtlasAuditResult>;
  commit(request: AtlasCommitRequest, options?: AtlasOperationOptions): Promise<AtlasCommitResult>;
  index(request: AtlasIndexRequest, options?: AtlasOperationOptions): Promise<AtlasIndexResult>;
  admin(request: AtlasAdminRequest, options?: AtlasOperationOptions): Promise<AtlasAdminResult>;
  close(): Promise<void>;
}

export interface AtlasOperationOptions {
  signal?: AbortSignal;
  budget?: AtlasOperationBudget;
  attribution?: AtlasAttribution;
}
```

Names above define the target shape; exact request unions are frozen only after
contract tests. Services return structured data. Human Markdown and MCP content
blocks are renderers layered above those results.

`close()` is idempotent. It stops accepted work, waits for or cancels bounded
in-flight operations according to policy, flushes durable state, terminates owned
workers, and releases watchers. Creating multiple applications in one process is
supported when each has explicit paths and ownership.

## Required ports

### Atlas store

`AtlasStore` is the async persistence boundary. It groups operations by use case
instead of mirroring every SQLite statement. It must support:

- transactional file/changelog/metadata commits;
- bounded file, symbol, reference, snapshot, source-chunk, and history reads;
- FTS and optional vector candidate retrieval;
- migration status, integrity checks, backup, and recovery;
- explicit transaction or command boundaries for multi-write invariants;
- cancellation before dispatch and between bounded batches.

The interface never exposes driver statements or connection handles. The default
`SqliteAtlasStore` is a client proxy to a worker-owned database. A worker failure
rejects the operation with a typed error; it never falls back to synchronous
caller-thread I/O.

### Persistence contract families

Application services depend on the narrowest contract they use. The public
aggregate is composed from reader, writer, and maintenance capabilities rather
than exposing one database-shaped object:

```ts
interface AtlasReadRepository {
  getFile(request: GetFileRequest, options?: AtlasOperationOptions): Promise<AtlasFile | null>;
  listFiles(request: ListFilesRequest, options?: AtlasOperationOptions): Promise<AtlasPage<AtlasFile>>;
  searchLexical(request: LexicalSearchRequest, options?: AtlasOperationOptions): Promise<AtlasSearchPage>;
  searchVector?(request: VectorSearchRequest, options?: AtlasOperationOptions): Promise<AtlasSearchPage>;
  readGraph(request: GraphReadRequest, options?: AtlasOperationOptions): Promise<AtlasGraphSlice>;
  readHistory(request: HistoryReadRequest, options?: AtlasOperationOptions): Promise<AtlasHistoryPage>;
  readSnapshots(request: SnapshotReadRequest, options?: AtlasOperationOptions): Promise<AtlasSnapshotPage>;
  readBatch(request: AtlasReadBatchRequest, options?: AtlasOperationOptions): Promise<AtlasReadBatchResult>;
}

interface AtlasWriteRepository {
  commitFile(request: CommitFileRequest, options?: AtlasOperationOptions): Promise<CommitFileResult>;
  replaceIndexBatch(request: ReplaceIndexBatchRequest, options?: AtlasOperationOptions): Promise<ReplaceIndexBatchResult>;
  markVerification(request: MarkVerificationRequest, options?: AtlasOperationOptions): Promise<MarkVerificationResult>;
  deleteFile(request: DeleteFileRequest, options?: AtlasOperationOptions): Promise<DeleteFileResult>;
}

interface AtlasMaintenanceRepository {
  status(options?: AtlasOperationOptions): Promise<AtlasStoreStatus>;
  migrate(request: MigrateStoreRequest, options?: AtlasOperationOptions): Promise<MigrateStoreResult>;
  checkIntegrity(options?: AtlasOperationOptions): Promise<AtlasIntegrityResult>;
  backup(request: BackupStoreRequest, options?: AtlasOperationOptions): Promise<BackupStoreResult>;
  recover(request: RecoverStoreRequest, options?: AtlasOperationOptions): Promise<RecoverStoreResult>;
}

interface AtlasStore {
  readonly capabilities: AtlasStoreCapabilities;
  readonly read: AtlasReadRepository;
  readonly write: AtlasWriteRepository;
  readonly maintenance: AtlasMaintenanceRepository;
  close(): Promise<void>;
}
```

Names above define capability shape, not a promise to freeze every method before
contract tests exist. Requests and results are database-independent records with
workspace, stable ordering, limits, cursors, evidence authority, and completeness
encoded explicitly. They contain no SQL, SQLite row IDs used only internally,
driver errors, worker operation names, or host path discovery.

`readBatch` is a bounded discriminated-union read plan executed against one
consistent store snapshot. It exists for services that need several related reads
without exposing a transaction callback or connection. Arbitrary caller code never
runs inside an adapter transaction, which keeps the contract serializable across
worker and process boundaries.

Capabilities are truthful and immutable for an open store. Lexical search and the
core records required by a declared schema version are mandatory. Vector search,
online backup, snapshot history, and other optional features are reported through
`AtlasStoreCapabilities` with matching optional methods. Unsupported methods are
absent. A capability that becomes unavailable after open fails with
`AtlasUnsupportedCapabilityError` rather than changing algorithms silently.

### Atomic commands

Write methods are semantic commands whose transaction boundaries are part of the
public contract:

| Command | Atomic consistency requirement |
| --- | --- |
| `commitFile` | File metadata, tags, highlights, ranged/legacy hazard reconciliation, changelog row, optional snapshot, symbol identities, and lexical index update commit or roll back together |
| `replaceIndexBatch` | File records, symbols, imports, references, source chunks, lexical rows, and the durable batch checkpoint become visible together |
| `markVerification` | Workspace-scoped target rows and verification evidence update together; missing or foreign IDs fail the command |
| `deleteFile` | The file plus dependent graph, symbol, chunk, vector, snapshot-policy, and lexical rows are removed together |
| `migrate` | One ordered migration and its checksum record commit together after the adapter owns the migration lock |

The adapter may split a larger indexing run into many transactions, but the
service chooses and records those batch boundaries before dispatch. A transaction
never spans a network provider call, filesystem read, parser task, another store,
or a response to the caller.

Every retryable write carries a caller-supplied durable idempotency or recovery
key. Repeating the same key and canonical payload returns the stored outcome;
reusing it with a different payload is a conflict. Commands that cannot provide
this invariant are not replayed after a lost worker acknowledgement.

Optional preconditions such as expected file hash, record revision, or schema
version provide optimistic concurrency. A mismatch fails with `AtlasConflictError`
without partial writes. Database constraint failures are mapped to stable Atlas
errors while preserving a redacted adapter cause for diagnostics.

### Read and consistency semantics

Successful write resolution provides read-your-writes consistency for later
operations submitted to the same store. Single reads observe a committed state;
`readBatch` observes one snapshot. Pages have stable deterministic ordering and an
opaque cursor bound to workspace, query shape, and snapshot/revision so a cursor
cannot be reused against a different request unnoticed.

FTS, vector identity metadata, graph edges, and source chunks are derived indexes,
but their recorded freshness is never implied. If an optional post-commit vector
stage is pending or failed, lexical state remains valid and the result reports the
vector capability and freshness precisely. Required lexical rows are updated in
the same transaction as their source records or the command fails.

Cross-workspace aggregation reads explicitly registered stores independently and
annotates each result with its workspace and freshness. Atlas does not claim an
atomic snapshot across databases. Cross-store writes are separate commands with
separate outcomes; there is no distributed transaction hidden in the repository
interface.

### Default SQLite adapter

`createSqliteAtlasStore` remains the default supported persistence factory. It
requires an explicit database path and migration directory, then starts a database
worker that exclusively owns the `better-sqlite3` connection. The caller receives
only the async `AtlasStore` proxy.

The adapter enables WAL where supported, serializes writes and migrations, uses
bounded read commands, records ordered migration checksums, and verifies schema
and integrity state before reporting `ready`. SQLite or native-extension errors are
serialized into stable Atlas errors. The optional vector extension changes the
capability report only after load and dimension validation succeed; lexical search
does not depend on it.

Read replicas or a separate read-only connection may be added later behind the
same contracts, but they must preserve read-your-writes and snapshot claims. They
are an adapter optimization, not visible handles. A failed worker, extension, or
replica never causes the proxy to open SQLite on the request thread.

### Persistence conformance suite

Every adapter runs the same contract suite. A temporary real SQLite database is
the normative default-adapter fixture; future adapters must pass identical logical
tests for:

- fresh creation, historical migration, checksum mismatch, interruption, and
  integrity failure;
- atomic success and rollback of every semantic write command;
- idempotent replay, payload conflict, optimistic precondition failure, and lost
  acknowledgement classification;
- read-your-writes, snapshot-consistent batches, stable pagination, and bounded
  results;
- lexical/index/graph/snapshot consistency after replace and delete operations;
- capability negotiation and unavailable vector behavior;
- concurrent reads, serialized writes, cancellation, deadline, backpressure,
  worker crash, recovery, and close behavior inherited from the worker protocol;
- resource cleanup proving no connection, lock, worker, or temporary database
  remains owned after `close()`.

The suite asserts public records and errors, never SQLite-specific row order or
private worker messages. Adapter-specific tests add WAL, lock, extension, backup,
and query-plan coverage without weakening the shared contract.

### Repository source

`RepositorySource` provides normalized file enumeration, bounded reads, metadata,
hashing, and optional repository status. The default Node adapter receives an
explicit root. It does not discover private host roots, create worktrees, or scan a
home directory unless the caller requests a documented discovery operation.

Repository mutation is a separate optional `RepositoryLifecycle` capability.
Read-only indexing never gains worktree creation authority by receiving a source
adapter.

### Clock and identifiers

`AtlasClock` supplies timestamps and `AtlasIdFactory` supplies identifiers where
the caller has not provided a durable key. Tests inject both. Ordering cannot rely
on random identifiers or locale-dependent string comparison.

## Asynchronous I/O and worker protocol

Promise-shaped wrappers are not an asynchronous boundary by themselves. The
current `dbAsync.ts` helpers still call synchronous database functions before their
promises settle, and the current MCP composition root gives handlers a live SQLite
handle. Both are compatibility surfaces to replace, not patterns to extend.

Every operation reachable from an MCP handler, resource callback, CLI service
request, watcher callback, or timer follows this path:

```text
transport callback
  -> validate and normalize a bounded request
  -> application service
  -> queue admission in AtlasWorkerSupervisor
  -> asynchronous message transport
  -> worker-owned adapter and resource
  -> structured response
  -> transport renderer
```

The caller thread may perform bounded validation, enqueue a message, observe an
`AbortSignal`, and render a bounded result. It must not open a database, execute a
statement, read or walk the filesystem, load a native parser, hash a large file,
compute an embedding, or fall back to any synchronous implementation when a worker
is unavailable. Unavailability is a typed result.

### Work classes and ownership

| Class | Owner | Concurrency rule |
| --- | --- | --- |
| SQLite reads | Database worker | Bounded in flight; one worker owns each connection |
| SQLite writes and migrations | Database worker | Serialized per database; transactions never cross messages |
| Repository enumeration, reads, and hashing | Source worker pool | Explicit root plus file, byte, and batch limits |
| Parsing and graph/index transforms | CPU worker pool | Bounded tasks with explicit input and output size budgets |
| Embedding preprocessing | CPU worker pool | Bounded batches; no provider or model selection in the worker |
| Embedding provider calls | Async provider adapter | Per-provider limiter, deadline, and cancellation policy |

Worker threads receive serializable records, never database handles, MCP objects,
open file descriptors, provider clients, or ambient host state. The database
worker opens, migrates, owns, and closes its connection. Source and CPU pools are
separate so a long parse or filesystem crawl cannot hold the database command
queue. A separate process may implement the same protocol when native-addon
isolation is required.

### Message contract

The internal protocol is versioned and independently testable:

```ts
interface AtlasWorkerRequest<Payload = unknown> {
  protocolVersion: 1;
  requestId: string;
  workClass: 'db-read' | 'db-write' | 'source' | 'cpu';
  operation: string;
  payload: Payload;
  remainingTimeMs: number | null;
}

type AtlasWorkerResponse<Result = unknown> =
  | { requestId: string; ok: true; result: Result }
  | { requestId: string; ok: false; error: SerializedAtlasError };
```

The supervisor owns the absolute deadline against an injected monotonic clock and
derives `remainingTimeMs` when it dispatches work. The worker treats that value as
an upper bound; the supervisor remains the settlement authority, so a separate
process never has to share the caller's clock origin. An `AbortSignal` is not
transferred. The supervisor listens to it and sends a separate cancel message
keyed by `requestId`. Payload schemas are validated on both sides of the boundary,
and unknown protocol versions or operations fail closed.

Each request moves through `created`, `queued`, `dispatched`, and exactly one
terminal state. Responses for unknown or already-settled request IDs are discarded
and reported as protocol events. A request is never resolved twice, including
during cancellation and worker-exit races.

### Admission, fairness, and backpressure

The supervisor has explicit `maxQueued`, per-class `maxInFlight`, maximum payload
bytes, maximum result bytes, and maximum batch-size settings. Admission that would
exceed a limit fails immediately with `AtlasBackpressureError`; it does not create
an unbounded promise backlog. The error identifies the saturated class and may
include a configured retry hint, but services do not spin or retry automatically.

Interactive reads and short writes use bounded lanes. Bulk indexing is divided
into batches and scheduled with weighted fairness so it cannot starve interactive
queries, and queries cannot prevent indexing from making progress forever. SQLite
writes remain serialized even when read and source work have wider concurrency.
Every list, graph, history, source, and embedding operation has a result limit;
workers do not return an unbounded repository or table snapshot.

### Cancellation and deadlines

Cancellation has stable behavior at every state:

- before admission: reject with `AtlasCancelledError` and enqueue nothing;
- while queued: remove the request and settle it as cancelled;
- after dispatch: send cancellation to the worker, interrupt the active database
  statement when the driver safely supports it, and check between bounded batches;
- after an irreversible transaction commit: return the committed result when it is
  known, or a typed indeterminate-write error when acknowledgement was lost;
- after settlement: ignore cancellation.

When a deadline expires, the supervisor performs the same cancellation sequence
and settles with `AtlasTimeoutError`, retaining timeout versus caller cancellation
as distinct error codes. A timeout never causes caller-thread fallback. Worker
code checks cancellation before expensive work and between batches; non-
interruptible native work may finish in the worker, but its late result is ignored.

### Worker failure and recovery

A worker exit atomically marks its endpoint unavailable and rejects every affected
in-flight request with `AtlasWorkerUnavailableError` or
`AtlasIndeterminateWriteError`. Queued requests are either retained behind a
bounded restart gate or rejected according to configured policy. The supervisor
may restart a worker with capped backoff, but:

- writes, migrations, backups, and repository mutations are never blindly
  replayed;
- a read may be retried at most once only when policy permits, its deadline remains
  valid, and it was not cancelled;
- replay-safe writes require an explicit durable idempotency key and store-level
  recovery contract;
- a database worker must reopen, verify schema/integrity state, and announce
  `ready` before admission resumes;
- repeated startup failure leaves the application unhealthy instead of switching
  to inline I/O.

Worker diagnostics are structured events with request payloads and secrets
redacted. Event-sink failure cannot delay request settlement or recovery.

### Filesystem, indexing, and embeddings

`RepositorySource` implementations dispatch enumeration, metadata, reads, and
hashing through the source pool with an explicit root. Reads are size-limited and
chunkable. Directory traversal checks cancellation between batches and never
follows links outside the configured root unless an explicit policy allows it.

Indexing coordinates source and CPU workers, then sends bounded commit batches to
the database worker. No worker shares a transaction or native handle with another.
Progress checkpoints refer only to durable completed batches, so cancellation or a
crash can resume without claiming unfinished work succeeded.

An async embedding provider may use the host event loop for nonblocking network
I/O, but it still sits behind a concurrency limiter, deadline, cancellation hook,
batch limit, and response-size check. CPU-heavy preprocessing remains in the CPU
pool. Provider absence or failure never triggers an undeclared provider or a
pseudo-vector fallback.

### Shutdown

`AtlasApplication.close()` is idempotent. It stops admission, cancels queued work,
requests a bounded drain of in-flight operations, closes provider adapters, asks
workers to release owned resources, and terminates workers that exceed the grace
period. New requests fail with `AtlasClosedError`. Shutdown does not resolve until
every accepted request has reached one terminal state and every owned endpoint is
closed or forcibly terminated.

### Concurrency test seam

The supervisor depends on an `AtlasWorkerEndpoint` interface rather than directly
on `node:worker_threads`. Tests inject a scripted endpoint, fake monotonic clock,
and deterministic scheduler. The conformance suite must cover:

- many concurrent reads while serialized writes preserve order;
- queue saturation and fair progress between interactive and indexing lanes;
- cancellation before admission, while queued, and after dispatch;
- deadline expiry racing a successful or failed response;
- worker exit during reads, committed writes, migrations, and shutdown;
- bounded restart, readiness gating, idempotent replay rules, and crash loops;
- oversized payload, result, and batch rejection;
- application close with queued and in-flight operations;
- an event-loop sentinel proving request callbacks remain responsive while real
  SQLite, source, parser, and embedding test doubles are busy.

The same suite runs against the scripted endpoint and the real worker transport.
It asserts outcomes and state transitions, not wall-clock sleeps, so concurrency
behavior is deterministic and reproducible.

## Optional ports

### Embeddings

Embeddings are an optional acceleration and ranking capability, never a condition
for indexing, search, lookup, graph, history, audit, diff, commit, or migration.
The default application is lexical-only. It does not construct a provider from
ambient API keys, download a model, call a network endpoint, or throw merely
because dense retrieval is absent.

The provider contract is host-neutral and contains no SDK-specific client or
configuration type:

```ts
interface EmbeddingModelIdentity {
  providerId: string;
  modelId: string;
  modelRevision: string;
  dimensions: number;
  distanceMetric: 'cosine' | 'dot' | 'l2';
  normalization: 'none' | 'unit';
  inputFormatVersion: string;
}

interface EmbeddingProvider {
  readonly identity: EmbeddingModelIdentity;
  readonly limits: {
    maxBatchItems: number;
    maxItemBytes: number;
    maxBatchBytes: number;
    maxConcurrentBatches: number;
  };
  embed(
    request: EmbeddingBatchRequest,
    options?: AtlasOperationOptions,
  ): Promise<EmbeddingBatchResult>;
  close?(): Promise<void>;
}
```

`modelRevision` identifies the actual weights or provider generation, not merely a
marketing alias. An adapter whose upstream model is not immutably versioned must
require an operator-supplied generation value and change it when compatibility is
uncertain. Provider endpoint, credentials, billing fields, and SDK objects are
adapter configuration and are never persisted as model identity.

`EmbeddingBatchRequest` is an ordered list of stable item IDs and canonical text.
The result preserves those IDs and reports either one vector or one structured
item error for every input. The adapter may reject the entire batch, but it may not
drop items, reorder them without IDs, or return a short positional array.

### Embedding input and validation

Pure versioned builders produce text for files, source chunks, changelog entries,
and queries. Canonical input bytes and `inputFormatVersion` are part of freshness;
changing labels, field order, normalization, truncation, or chunk construction
requires a new format version.

Before storage or search, Atlas validates that every vector:

- has exactly the declared dimensions;
- contains only finite numbers;
- satisfies the declared normalization within a documented tolerance;
- belongs to the model identity returned when the provider was opened;
- corresponds to the requested item ID.

Invalid output fails the affected item with `AtlasEmbeddingValidationError`. Atlas
never pads, truncates, renormalizes contrary to the descriptor, substitutes a zero
vector, or accepts a provider identity change mid-application.

### Compatibility identity and storage

Atlas derives a canonical embedding-space key from provider ID, model ID, model
revision, dimensions, distance metric, normalization, and input-format version.
Every stored vector is accompanied by:

```ts
interface AtlasEmbeddingRecord {
  targetKind: 'file' | 'source-chunk' | 'changelog';
  targetKey: string;
  workspace: string;
  inputHash: string;
  spaceKey: string;
  dimensions: number;
  createdAt: string;
}
```

The input hash alone is insufficient. A vector is reusable only when target,
canonical input hash, full space key, dimensions, and active store generation all
match. Query vectors must use that same active space. Mismatch yields
`AtlasEmbeddingIncompatibleError` and excludes the vector from ranking; it never
triggers a silent table rewrite or cross-model comparison.

Vector bytes and their metadata become current atomically for one target. If the
vector index is unavailable or rejects the write, metadata is not marked current.
When source text changes, the prior vector becomes stale immediately even if
regeneration later fails. Stale, invalid, incompatible, orphaned, or partially
written vectors are never retrieval candidates.

SQLite vector tables have fixed dimensions. A model or dimension change is an
explicit embedding-generation migration/backfill. The adapter builds and validates
the new space separately, records progress, and changes the active generation only
through a maintenance command after its completion policy is satisfied. A stopped
backfill leaves the previous compatible generation active; old space cleanup is a
separate reversible maintenance action.

### Freshness and lifecycle

Embedding status is explicit per store and target:

```ts
type AtlasEmbeddingFreshness =
  | 'disabled'
  | 'missing'
  | 'current'
  | 'stale-input'
  | 'incompatible-space'
  | 'generation-pending'
  | 'provider-failed';
```

Backfill reads bounded canonical inputs, batches within provider limits, validates
outputs, and submits bounded vector writes through `AtlasStore`. Progress counts
attempted, current, skipped-current, failed, and pending items separately. Only
durably stored current items advance the resumable checkpoint. Cancellation,
timeout, or provider failure never reports the remaining items complete.

The provider is opened explicitly during application assembly and closed by
`AtlasApplication.close()`. Its batches inherit supervisor cancellation,
deadlines, response-size limits, and per-provider backpressure. CPU-heavy local
inference or preprocessing runs in the CPU pool; a nonblocking remote adapter may
use the host event loop behind the same limiter.

### Retrieval degradation

Retrieval always computes the bounded lexical candidate set independently. Hybrid
fusion runs only when the provider is ready, a valid query vector exists, and a
compatible active vector space is available. Fusion uses a documented stable
algorithm and stable target-key tie-breaks.

When embeddings are disabled, unavailable, timed out, rate-limited, invalid,
incompatible, or fail for the query, Atlas returns the exact lexical result that
the same request would have produced with embeddings disabled. It does not blend a
partial vector list, reuse a stale query vector, generate pseudo-vectors, select a
different provider, or retry beyond explicit policy. Structured result metadata
reports dense status, reason, active space key when safe to expose, coverage, and
whether lexical fallback occurred.

Index-time provider failure follows configured policy. The public default records
the failure, keeps durable lexical state valid, marks affected vectors non-current,
and completes in lexical mode. A caller may opt into `fail-index`, but no provider
failure rolls back an already committed lexical index batch or changes its
deterministic content.

### Embedding conformance suite

The provider and store integration suites cover:

- no-provider construction and every non-vector service in lexical-only mode;
- stable identity derivation and rejection of model, revision, dimension, metric,
  normalization, and input-format mismatches;
- output reordering, missing items, per-item errors, NaN/infinity, wrong
  dimensions, and normalization violations;
- current, stale, incompatible, pending, failed, and orphaned freshness states;
- atomic vector-plus-metadata writes and interrupted generation switches;
- bounded batches, cancellation, timeout, rate limiting, provider crash, and
  application shutdown;
- query-provider failure producing the same lexical items, scores, ordering, and
  lexical evidence as embeddings-disabled retrieval, with only explicit dense-
  status metadata differing;
- deterministic hybrid fusion, ties, coverage reporting, and exclusion of every
  non-current vector.

Tests use scripted providers and a temporary real SQLite vector adapter when the
extension is available. Absence of the optional extension is itself a passing
lexical-only case, not a skipped assertion about Atlas functionality.

### Provenance

Provenance is optional evidence about who or what produced, observed, or reviewed
an Atlas subject. It is not an identity system and does not make collaboration
state part of the core. With no provider, callers may still supply neutral
attribution and every Atlas operation remains available.

### Neutral attribution

Write operations accept a small stable record:

```ts
interface AtlasAttribution {
  principal?: {
    id?: string;
    displayName?: string;
    kind: 'human' | 'service' | 'automation' | 'unknown';
  };
  runtime?: {
    name?: string;
    version?: string;
  };
  toolId?: string;
  source?: string;
}
```

Attribution is an explicit claim from the caller unless evidence verifies it.
Missing fields stay missing; Atlas does not infer a person from an operating-system
user, infer automation from a process name, inspect credentials, or synthesize an
identity from repository metadata.

Historical author name, instance ID, engine, and model columns remain readable for
upgrade compatibility. The public service maps them into neutral principal and
runtime fields where possible and reports their historical field authority. New
code does not require or preferentially interpret agent, instance, or model terms.

### Evidence envelope

Rich evidence uses one stable namespaced envelope instead of provider-defined
columns or result fields:

```ts
interface AtlasProvenanceEvidence {
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
  principal?: AtlasAttribution['principal'];
  occurredAt?: string;
  observedAt: string;
  authority: 'caller' | 'repository' | 'provider' | 'verified-external';
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  sourceRef?: string;
  payload: unknown;
  payloadHash: string;
}
```

Namespace and schema version determine payload interpretation. The envelope has
canonical serialization, a strict byte limit, stable ordering, and a content hash
for deduplication. `sourceRef` is an opaque audit reference, not permission to
include a transcript, credential, local database path, or secret URL.

Unknown namespaces and future versions are preserved when stored, ignored by core
algorithms, and returned only when a caller explicitly requests an allowlisted
namespace. Public result shapes remain stable because extensions are always an
array of envelopes, never dynamic top-level properties.

If Atlas persists extension evidence, it uses a single versioned extension table
owned by the core migration history. Providers cannot add columns, tables,
migrations, triggers, FTS fields, or ranking behavior. A provider needing custom
indexes retains them in its own store behind its interface.

### Provider contract

```ts
interface ProvenanceProvider {
  readonly descriptor: {
    providerId: string;
    providerVersion: string;
    namespaces: ReadonlyArray<{ namespace: string; schemaVersion: string }>;
    capabilities: ReadonlyArray<'verify-attribution' | 'evidence' | 'activity'>;
  };
  verifyAttribution?(
    request: VerifyAttributionRequest,
    options?: AtlasOperationOptions,
  ): Promise<VerifyAttributionResult>;
  listEvidence?(
    request: ListProvenanceEvidenceRequest,
    options?: AtlasOperationOptions,
  ): Promise<AtlasPage<AtlasProvenanceEvidence>>;
  listActivity?(
    request: ListActivityRequest,
    options?: AtlasOperationOptions,
  ): Promise<AtlasPage<AtlasProvenanceEvidence>>;
  close?(): Promise<void>;
}
```

Providers receive bounded neutral subjects and caller attribution, never a
database handle, MCP object, repository mutation capability, or another provider's
credentials. Responses are validated against the advertised namespace/version and
evidence limits before use. Activity is a time-bounded evidence query, not a live
subscription to a private event bus.

Application configuration chooses `disabled`, `best-effort`, or `required`
provenance policy per operation class. The public default is `disabled` when no
provider is injected and `best-effort` for optional enrichment. Under best effort,
provider timeout, cancellation, invalid output, or failure leaves explicit caller
attribution intact, adds a structured provenance-status warning, and does not fail
the core operation. Under required policy, verification completes before the
semantic write command begins; validated required evidence is included in that
command and commits atomically with the core record. Failure produces no partial
write.

Evidence never changes search rank, authorship, verification state, or repository
authority merely by existing. A service that wants such behavior must define a
public deterministic policy over specific namespaces and evidence kinds. Numeric
confidence from a private system is not copied into a public ranking weight.

### Witnesses and activity

A file witness is a derived view over bounded evidence, not proof that an actor
understood or authored the file. Aggregation groups by neutral principal, evidence
kind, workspace, and time range; it retains source references and distinguishes
caller claims from verified observations.

The historical `atlas_file_witnesses` table and interaction vocabulary are
compatibility inputs only. The default service neither populates nor requires
them. A separately installed compatibility provider may map supported rows into a
declared evidence namespace; provider-specific interactions that have no neutral
meaning remain in the namespaced payload rather than becoming core enum values.

Recent activity has explicit maximum age, item count, workspace, and subject
filters. Provider absence returns `capability: unavailable`, not an empty list that
could be mistaken for proof that no activity occurred. Evidence authority,
freshness, truncation, and completeness accompany every aggregate.

### Repository and worktree freshness

Repository freshness is not collaboration provenance. `RepositorySource` supplies
current file hash, metadata, and optional repository revision; Atlas compares
those facts with the durable indexed hash and snapshot revision. The result says
`current`, `modified`, `missing`, `untracked`, or `unknown` with observation time
and authority.

Status and diff are read-only repository capabilities. Merge, branch, or worktree
mutation remains behind the separate opt-in `RepositoryLifecycle` interface and
never follows from provenance access. An activity provider may attach evidence to
a freshness result, but it cannot override file bytes, hashes, repository state,
or mutation authorization.

### Privacy and public defaults

Provider assembly uses explicit namespace, field, workspace, age, and result-size
allowlists. Atlas stores or renders no raw transcript/message body, prompt,
credential, billing record, token/cost telemetry, private event payload, or host
filesystem location through the provenance interface. Providers redact before
returning evidence; Atlas independently enforces envelope limits and rejects
disallowed fields where a namespace schema defines them.

The public default has no claims, squads, rooms, task rails, signals, fixer state,
relay lifecycle, process-manager metadata, transcript lookup, or implicit event
source. A Voxxo integration may map selected facts to neutral evidence through a
separate adapter, but its source types, storage, and lifecycle remain outside this
package and outside the public core schema.

### Provenance conformance suite

Provider and service tests cover:

- no-provider operation with absent attribution and with caller attribution;
- best-effort and required timeout, cancellation, malformed output, and provider
  failure without partial core writes;
- namespace collision, unknown schema version, oversized payload, unstable order,
  duplicate content hash, and disallowed-field rejection;
- unknown extension preservation plus explicit namespace-gated retrieval;
- witness aggregation retaining authority, confidence, freshness, truncation, and
  source references without overstating authorship;
- provider absence remaining distinguishable from an observed empty activity set;
- repository freshness computed without a collaboration provider and immune to
  contradictory activity evidence;
- scans proving the default package and core contracts contain no required Voxxo
  runtime, transcript, squad, claim, or relay event dependency.

### Repository lifecycle

Worktree status, diff, or merge support lives behind `RepositoryLifecycle` and is
opt-in. The default public service never creates a worktree implicitly. Destructive
repository operations require a distinct API and caller authorization.

### Events and telemetry

`AtlasEventSink` receives structured lifecycle, query, indexing, migration, and
health events. It is observational: failure or slowness cannot change results.
Core token, billing, or model-cost fields remain absent unless a provider supplies
measured values.

### Context Warp adapter

An optional adapter implements Context Warp's metadata-provider contract using
public Atlas queries for purpose, blurb, tags, highlights, and ranged hazards. It
uses the same async service as any programmatic consumer. The adapter is a separate
subpath or package and introduces no Context Warp import into Atlas core.

## Indexing pipeline

Indexing is a resumable application workflow:

1. `RepositorySource` enumerates bounded candidates and supplies metadata/hashes.
2. Parser adapters produce language-neutral symbols, imports, and flow facts.
3. Pure transforms normalize symbols, resolve cross-file references, and derive
   graph/community inputs with stable ordering.
4. The service commits one bounded transactional batch through `AtlasStore`.
5. Optional embeddings run only after durable lexical/index state exists.
6. Progress and cancellation are emitted between batches; a stopped run remains
   resumable from verified durable state.

No indexing pass reads environment variables or chooses a network provider. Host
assembly resolves configuration before creating the application.

## Retrieval, graph, and history

All read services follow the same execution pattern:

1. Validate and normalize a structured request.
2. Resolve workspace and capability policy from application configuration.
3. Fetch bounded candidates through `AtlasStore`.
4. Run deterministic ranking, graph, diff, or completeness logic in core.
5. Return structured results with evidence authority, truncation, capability, and
   freshness metadata.
6. Render to MCP text, CLI text/JSON, or a host-specific view outside the service.

Cross-workspace reads use explicitly registered workspace stores. Home-directory
scanning is a Node-host convenience and is never implicit in core or programmatic
construction.

## Persistence and migrations

The default deployment uses SQLite in WAL mode behind a worker-owned connection.
Migration files remain ordered, append-only compatibility inputs. The store owns:

- online backup before a risky upgrade;
- an inter-process migration lock;
- per-migration transaction and checksum records;
- schema and integrity verification before marking completion;
- actionable recovery state after interruption;
- fresh-install and upgrade compatibility with the public migration history.

The historical personal-name migration remains only as an input for old databases.
Current schema and API use operator-neutral names after the compatibility migration.
Private domain migrations never enter the public migration head.

## Portable data and configuration layout

Path resolution is a Node-host responsibility. Core records receive a normalized
workspace and repository-relative paths; they never inspect the current directory,
home directory, environment, VCS metadata, or platform data folders.

### Resolved layout

Host assembly produces one immutable redacted layout before opening any adapter:

```ts
interface AtlasResolvedLayout {
  displayRepositoryRoot: string;
  canonicalRepositoryRoot: string;
  repositoryId: string;
  workspace: string;
  dataMode: 'project' | 'user';
  dataRoot: string;
  databasePath: string;
  lockRoot: string;
  cacheRoot: string;
  backupRoot: string;
  configurationSources: ReadonlyArray<AtlasConfigurationSource>;
}
```

`canonicalRepositoryRoot` is an absolute real path with platform case and separator
rules applied. `displayRepositoryRoot` preserves the caller-facing spelling for
messages. The repository ID is an opaque value generated once under the
initialization lock, not a basename or user-supplied workspace label. Project mode
persists it in both the database and local identity file. User mode persists it in
the per-user registry keyed by a versioned digest of canonical root plus resolved
worktree metadata. Separate clones and worktrees receive separate registry entries;
symlink aliases canonicalize to the same entry.

The database stores its repository ID, last-known canonical root, VCS identity when
available, workspace, and layout version. Opening an external database with a
different repository ID fails with `AtlasStoreIdentityError`. When an entire
project-local root moves with its guarded `.atlas` directory, matching database and
identity-file IDs plus matching VCS identity permit an atomic last-known-root
update. A non-VCS relocation or user-global registry move requires an explicit
relocation command so copying one project's `.atlas` directory cannot silently
retarget it. An explicit shared database may contain multiple roots only when each
root has a distinct configured workspace and registered identity; sharing is never
inferred from matching directory names.

### Repository-root detection

The Node preset resolves a root in this order:

1. explicit programmatic `sourceRoot` or CLI `--source-root`;
2. the directory containing the nearest ancestor `atlas.config.json`;
3. the nearest ancestor containing a `.git` directory or worktree `.git` file;
4. fail with `AtlasRepositoryRootNotFoundError`.

Environment-provided root is explicit configuration and follows the same
validation as a CLI root. Indexing the current directory with no marker requires
the deliberate `rootMode: 'cwd'` option. Filesystem root, a user's home directory,
or an ancestor outside the starting directory is never selected implicitly.

Root discovery has a bounded ancestor count, does not scan sibling directories,
does not resolve a worktree to its main checkout, and does not follow a repository
config path outside the discovered root. The resolver verifies that the root is a
directory, canonicalizes it once, and returns both the canonical and display paths.

### Project-local layout

Project mode is the default for the CLI/server because state stays beside the
repository it describes while remaining untracked:

```text
<repository>/.atlas/
  .gitignore
  atlas.sqlite
  atlas.sqlite-wal
  atlas.sqlite-shm
  identity.json
  config.local.json
  locks/
    store.lock
    migrate.lock
  cache/
    <cache-format-version>/
  backups/
    atlas.<schema>.<utc-timestamp>.<nonce>.sqlite
```

SQLite owns its WAL and SHM sidecars. Callers never construct or copy them. The
directory and sensitive children use user-only permissions where the platform
supports them. `identity.json` is non-authoritative diagnostic metadata; the
database identity record is authoritative.

On first creation Atlas writes `.atlas/.gitignore` with an ignore-all rule and the
single exception needed to keep that guard file visible. It checks VCS ignore
status when a repository adapter is available. It does not edit the repository's
root ignore file unless the caller explicitly requests that change. A database or
local-config path inside the source tree but outside the guarded `.atlas` directory
is rejected by default as an unsafe data path.

### User-global layout

User mode is explicit and useful for read-only source trees or consumers that do
not want any repository-local files. The Node adapter follows platform-standard
configuration, state, cache, and runtime directories. On XDG systems the shape is:

```text
$XDG_CONFIG_HOME/atlas/config.json
$XDG_STATE_HOME/atlas/repositories/<repositoryId>/atlas.sqlite
$XDG_STATE_HOME/atlas/repositories/<repositoryId>/backups/
$XDG_CACHE_HOME/atlas/repositories/<repositoryId>/<cache-format-version>/
$XDG_RUNTIME_DIR/atlas/<repositoryId>/locks/
```

Documented home-directory fallbacks apply only when the corresponding platform
variable is absent. A missing runtime directory moves locks under the repository's
state directory, not into `/tmp` under a predictable shared name. Windows and
macOS adapters use their native per-user application directories with the same
logical separation.

Repository IDs namespace every global state/cache/runtime path. The user registry
maps canonical lookup identities to IDs under an initialization lock keyed by that
lookup digest; it publishes the mapping atomically before creating repository
state, so concurrent first opens resolve the same ID. Display roots are advisory
discovery metadata, and the registry is never searched to guess a root for
programmatic construction. Deleting a cache or registry entry cannot delete the
database or source repository.

### Configuration files and precedence

Configuration uses a versioned schema and is merged once in this order, highest
precedence first:

1. programmatic factory options;
2. CLI flags;
3. documented `ATLAS_*` environment variables;
4. ignored `.atlas/config.local.json`;
5. repository `atlas.config.json`;
6. user-global `config.json`;
7. built-in defaults.

Paths declared in a file resolve relative to that file. CLI and environment paths
resolve by their documented absolute/caller-current-directory rules, then become
absolute during validation. Unknown keys, invalid enum values, conflicting roots,
non-positive limits, and incomplete provider identities fail closed with a source-
annotated configuration error rather than falling back silently.

`atlas.config.json` is safe to commit and therefore accepts only non-secret
settings such as workspace, include/exclude rules, data mode, concurrency, limits,
provider IDs/model identity, and extension namespace policy. It rejects credential,
token, secret, private-key, and raw authorization fields. Local and user config may
refer to a credential provider or environment variable but do not receive secrets
in the resolved diagnostic output.

The historical `.atlas/.env` parser is a deprecated compatibility input below
`config.local.json` and above repository config. New initialization does not write
it, does not search parent or home `.env` files, and never copies its values into a
committable file. Environment values are process inputs only.

Resolved configuration retains per-field source provenance and exposes a redacted
inspection result. Secrets stay inside the adapter that consumes them and are
replaced with presence/source metadata in logs, errors, MCP content, telemetry,
backups, and support bundles.

### Locks and concurrent servers

A write-capable SQLite store acquires an operating-system-backed exclusive lock on
the canonical database path before migration or open. Lock metadata includes a
random nonce, process identity, process-start marker when available, mode, and
acquisition time, but never credentials or command-line secrets.

A second writer for the same database fails with `AtlasStoreLockedError`; it does
not choose another database, truncate a lock, open inline, or silently become a
different workspace. Explicit read-only clients may use shared access when the
adapter and platform can preserve the advertised WAL snapshot guarantees. Watcher,
migration, backup, recovery, and write methods remain disabled in that mode.

Crash recovery treats a lock as stale only after the OS lock is acquirable and its
recorded owner/nonce can no longer represent a live holder. PID age alone is not
sufficient because of reuse. Migration has a distinct lock nested under the live
store owner. Lock release occurs after workers, providers, WAL state, and owned
files are closed; `close()` remains idempotent.

Cache jobs use repository- and operation-scoped locks. Temporary and partial files
include an unguessable nonce and are atomically renamed only after validation. No
global basename, workspace label, or fixed `/tmp/atlas-*` path is used as shared
state.

### Caches and backups

Caches are disposable, versioned by their serialized format plus the parser,
embedding space, or algorithm identity that consumes them. They may contain source
text and are treated as private runtime data despite being rebuildable. Cache
corruption or version mismatch deletes/quarantines only that cache entry and never
changes durable Atlas records.

Backups live with the database state, not source files or caches. The SQLite
adapter uses its online backup mechanism, writes a partial file, verifies integrity
and identity, then atomically publishes the timestamped result. It never copies a
live database plus WAL/SHM sidecars as unrelated files. Retention is scoped per
repository and cannot prune a protected backup.

Backup, restore, and delete paths must remain descendants of their resolved roots
after real-path validation. Restore requires an exclusive store/migration lock,
verifies schema and repository identity, preserves the replaced database as a
recovery artifact, and never follows symlinks outside the data root.

### Layout and configuration conformance

Tests cover:

- explicit, config-marker, VCS-root, worktree-file, symlink, missing-marker, home,
  and filesystem-root resolution;
- distinct repository IDs and paths for same-basename repositories and sibling
  worktrees, plus identical identity for symlink aliases;
- verified project-local relocation, explicit non-VCS/global relocation, copied-
  identity rejection, and atomic registry/root updates;
- project and platform-global layouts with no basename or fixed-temporary-path
  collisions;
- configuration precedence, relative-path ownership, unknown/invalid keys,
  deprecated environment compatibility, and redacted resolution output;
- rejection of secrets in repository config and unsafe runtime paths outside the
  guarded data directory;
- ignore-guard creation and package/runtime denylist coverage for databases,
  sidecars, locks, caches, backups, credentials, and partial files;
- two writers racing for one database, shared read-only policy, stale-lock/PID-
  reuse handling, crash cleanup, and idempotent close;
- cache version invalidation and online backup/restore integrity, identity,
  containment, retention, and protected-backup behavior.

## MCP, CLI, and programmatic modes

### Programmatic

The target default export is a factory that accepts ports or a documented Node
preset:

```ts
const atlas = await createAtlas({
  workspace: 'example',
  store: createSqliteAtlasStore({ databasePath: '.atlas/atlas.sqlite' }),
  repository: createNodeRepositorySource({ root: process.cwd() }),
});

try {
  const result = await atlas.query({ action: 'lookup', filePath: 'src/index.ts' });
  // consume structured result
} finally {
  await atlas.close();
}
```

### MCP server

`createAtlasMcpServer({ application })` registers schemas, maps `AbortSignal`, and
renders results. It does not open a database or scan a repository. The CLI entrypoint
assembles the default Node adapters, connects the selected MCP transport, and owns
shutdown.

### CLI

CLI commands call the same application methods and support machine-readable JSON.
Configuration precedence and resolved paths are explicit. Commands that mutate a
database or repository are distinct from read-only inspection commands.

## Public package entrypoints

The intended `1.0.0` entrypoints are:

| Subpath | Public role |
| --- | --- |
| `.` | Contracts, application factory, structured service results |
| `./core` | Dependency-free deterministic records and algorithms |
| `./service` | Host-neutral async application service and port contracts |
| `./mcp` | MCP adapter factory and renderers |
| `./sqlite` | Default worker-backed SQLite store factory |
| `./node` | Node repository/configuration adapters |
| `./types` | Type-only convenience export for every documented public contract |

Current low-level `./db` and `./paths` exports become time-bounded compatibility
facades during 1.x. The current `./pipeline` subpath is removed at 1.0; indexing is
owned by `AtlasService.index()` instead of exposing pipeline implementation. An
optional Context Warp adapter is a separately installed integration over public
ports, not a core package subpath or required dependency. `PUBLIC_API.md` is
normative for exact exports, aliases, and removal releases. API-extractor and
clean-install tests cover the resulting boundary.

## Current-to-target map

| Current surface | Target treatment |
| --- | --- |
| `src/types.ts` | Split stable domain contracts from host assembly and driver-facing types |
| `src/db.ts` | Move driver implementation into the SQLite worker adapter; retain pure mapping helpers where appropriate |
| `src/dbAsync.ts` | Replace promise-shaped synchronous wrappers with real worker-backed `AtlasStore` calls |
| `src/tools/*.ts` | Separate structured service logic from MCP registration and Markdown rendering |
| `src/pipeline/*` | Inject repository, store, parser, clock, budget, and optional embedding ports |
| `src/server.ts` | Thin Node composition root and MCP transport lifecycle |
| `src/config.ts` | Node adapter producing validated application options; no core environment reads |
| `src/embeddings.ts` | Provider-neutral contracts, lexical fallback, and optional adapter orchestration |
| `src/watcher.ts` | Optional Node host controller calling application indexing APIs |
| `src/index.ts` | Export the application factory and stable contracts rather than raw driver ownership |

## Explicit exclusions

The public core has no claims, squads, chatrooms, task rails, Ambient Atlas prompt
injection, Therapy Atlas, private transcripts, process-manager deployment, relay
worker task names, or implicit worktree creation. Production integrations may use
the public ports without moving those domains into this repository.

## Validation gates

Architecture work is accepted only when automated checks prove:

- import-boundary rules prevent core/services from importing concrete adapters or
  MCP/host modules;
- request-path scans find no synchronous database or filesystem operations;
- contract tests run the same use case through programmatic and MCP adapters;
- cancellation, worker crash, timeout, and backpressure tests have bounded results;
- lexical-only operation remains complete when embeddings are absent;
- fresh-install and historical-upgrade migration suites pass;
- the exact npm tarball imports every supported subpath and contains only reviewed
  public artifacts;
- optional Context Warp integration passes without creating a required dependency.

## Implementation order

1. Freeze public request/result contracts and typed error semantics.
2. Define the async store protocol and worker lifecycle.
3. Move SQLite ownership behind the worker adapter with compatibility tests.
4. Extract structured application services from MCP handlers.
5. Introduce the application factory and programmatic lifecycle.
6. Rebuild MCP, CLI, watcher, and indexing hosts on the shared service.
7. Add optional embeddings, provenance, repository lifecycle, telemetry, and
   Context Warp adapters independently.
8. Narrow compatibility exports only after API and clean-install tests cover the
   documented `1.0.0` surface.

This order preserves a working lexical Atlas while replacing boundaries from the
inside out. No phase may trade correctness or event-loop safety for a temporary
transport shortcut.
