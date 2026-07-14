# Atlas 1.0 implementation sequence

This document orders the remaining promotion work by dependency. The executable
task queue remains the source of status; this file defines why the order exists,
what must be true before each batch starts, and what keeps the repository usable
when a batch ends.

The sequence is intentionally inside-out: contracts and deterministic fixtures,
then durable storage and worker ownership, then indexing and query services, then
transports and hosts. Documentation, optional integrations, benchmarking, and
publication follow only after the exact package is stable.

## Rules shared by every batch

1. Start from a passing focused typecheck, affected tests, and exact-package smoke
   unless the batch exists to establish that check. Record any inherited failure
   before editing.
2. Define or update public types and fixtures before implementation. A type or
   schema change does not enter through a handler as an undocumented special case.
3. Keep one lexical-only end-to-end path working. Optional embeddings,
   provenance, repository features, or native extensions may be unavailable
   without disabling core indexing, lookup, history, graph, or writeback.
4. Database, filesystem, parser, native, embedding, and process work on request
   paths remains worker-owned. Saturation or worker failure has a bounded typed
   result and never falls back to synchronous inline work.
5. When storage changes, run separate fresh-head and frozen-`0.1.0` upgrade
   fixtures before downstream code depends on the new shape. Preserve a verified
   pre-upgrade copy and never rewrite historical migrations.
6. When a public request, result, export, command, error, or environment key
   changes, update the protocol fixture and compatibility matrix in the same
   batch. Canonical/alias conflicts fail rather than choosing a value silently.
7. End each batch with focused typecheck, focused unit/integration tests, package
   build, exact tarball install/import, migration smoke when relevant, and a
   production-only vocabulary scan over generated declarations and schemas.
8. A batch may split into smaller commits, but the next batch does not consume an
   interface until its owning batch has tests and recorded evidence.

## Batch 1 — Contract and deterministic core scaffold

Work, in order:

- Build deterministic fixture repositories.
- Port and reconcile core types.
- Port path and workspace canonicalization.
- Port evidence-authority resolution.
- Port query planning and output control.
- Port completeness, hygiene, and filtering.
- Stabilize MCP result and error contracts at the service DTO level.
- Port core unit tests.
- Add determinism and reproducibility tests.
- Add security and hostile-path tests for the new canonicalization boundary.

Entrance: `PUBLIC_API.md`, `ARCHITECTURE.md`, the promotion manifest, and frozen
source revisions are accepted.

Exit:

- host-neutral records and request/result DTOs compile without SQLite, MCP, Node
  host, relay, agent, or optional-provider types;
- fixture repositories cover POSIX/Windows paths, symlinks, renames, deletions,
  malformed input, stable ties, and explicit clocks;
- evidence authority and pagination/truncation metadata are deterministic;
- generated protocol fixtures contain only canonical public vocabulary; and
- current adapters may still use compatibility mapping, but no later batch needs
  to import current handler or driver types.

## Batch 2 — Schema lineage and async persistence

Work, in order:

- Port database schema and query-supporting indexes.
- Port and rewrite the public migration series without mutating published files.
- Implement the standalone worker protocol and lifecycle.
- Port persistence services behind the typed store boundary.
- Port locking, concurrent-writer, backup, recovery, and idempotency safety.
- Add worker, queue, crash, cancellation, and concurrency tests.

Entrance: Batch 1 DTOs, store ports, repository identity, path containment, and
frozen upgrade fixtures are available.

Exit:

- fresh and frozen-`0.1.0` databases converge on the same public head and retain
  IDs, relationships, dedupe state, history, and snapshots;
- migrations run and validate on staging, with the primary and verified backup
  protected across every injected boundary;
- all SQLite/filesystem operations are owned by workers and every request settles
  once under success, busy, cancellation, timeout, crash, and shutdown;
- a second writer fails visibly instead of selecting another database;
- lexical store conformance passes without sqlite-vec; and
- the exact installed tarball can create, close, reopen, and query the store.

## Batch 3 — Index materialization and repository freshness

Work, in order:

- Port the indexing pipeline.
- Port symbol and reference extraction.
- Port dependency and reference graph construction.
- Port freshness and watch behavior.
- Port repair, reindex, and recovery.

Entrance: Batch 2 provides atomic semantic commands, bounded read plans,
repository identity, worker scheduling, and migration-safe storage.

Exit:

- initial and incremental indexing converge byte-for-byte on equivalent durable
  records for the same fixture and injected clock;
- unchanged files avoid parser and write work; deletes and renames leave no stale
  authoritative symbol or edge;
- parser failure is bounded per file and recorded without aborting the repository;
- graph rebuild and incremental updates are equivalent;
- watcher events coalesce deterministically and call the application API instead
  of opening storage directly; and
- repair reports scope and evidence before mutation and is idempotent on rerun.

## Batch 4 — Retrieval, history, graph, and audit services

Work, in order:

- Port catalog and broad orientation.
- Port search and plan-context retrieval.
- Port lookup, snippet, and brief actions.
- Port history analytics.
- Port snapshots and diffs.
- Port neighbors and impact analysis.
- Port trace, cycle, and reachability operations.
- Port patterns, similar-file, and clustering operations.
- Port audit and quality surfaces.
- Port retrieval and tool tests.
- Port graph and symbol tests.
- Port history, snapshot, and diff tests.

Entrance: Batch 3 produces stable indexed records, symbols, edges, freshness, and
snapshots; Batch 1 provides bounded result DTOs and evidence rules.

Exit:

- every read service returns structured data independently of MCP/Markdown;
- pagination and tie order remain stable across reopen and lexical-only mode;
- current disk evidence cannot be overridden by stale metadata;
- snapshot fallback identifies exact, nearest, repository, or unavailable source
  without inventing content;
- dead-code and impact answers retain edge provenance/confidence; and
- large-fixture outputs respect character and item bounds without token
  estimation.

## Batch 5 — Writeback, administration, and optional embeddings

Work, in order:

- Port commit and metadata writeback.
- Port administration and observability.
- Port optional semantic embeddings.
- Port writeback and migration tests.

Entrance: Batch 4 read services and Batch 2 transactions, idempotency, migrations,
backups, and worker failure semantics are stable.

Exit:

- commit validates identity and evidence before an atomic semantic write and
  replays only matching idempotency fingerprints;
- administration uses explicit typed commands and never exposes a raw store,
  worker, destructive reset, or implicit repository lifecycle mutation;
- embedding identity includes provider, model, immutable revision, dimensions,
  metric, normalization, and input format;
- every dense failure returns the identical lexical items, lexical scores, order,
  and lexical evidence as disabled mode, with only capability metadata changing;
  and
- migration and writeback fixtures cover lost acknowledgements, conflicts, and
  required evidence atomicity.

## Batch 6 — MCP, transport, CLI, platform, and package host

Work, in order:

- Wire complete MCP registration from the structured application service.
- Implement transport cancellation and bounded shutdown.
- Harden cross-platform configuration and resolved data layout.
- Implement and harden `atlas init`.
- Implement and harden `atlas index`.
- Implement `atlas doctor`.
- Implement and harden the MCP serving command.
- Implement and harden `atlas watch` as an optional host controller.
- Stabilize programmatic package exports and compatibility facades.
- Add MCP and CLI protocol contract tests.
- Verify event-loop responsiveness under mixed request load.

Entrance: Batches 1–5 expose complete structured services and no host needs a raw
driver or filesystem shortcut.

Exit:

- programmatic, MCP structured content, and CLI JSON return equivalent envelopes
  for shared fixtures;
- the MCP adapter only decodes, maps cancellation, invokes the service, and
  renders; it does not open a database or scan a repository;
- every documented command, option, environment variable, error, alias warning,
  exit code, subpath, and bin has a contract fixture;
- init creates guarded state without modifying unrelated global client or
  repository configuration;
- timeout, abort, saturation, worker crash, and shutdown remain bounded during
  concurrent query, write, index, watch, and optional embedding work; and
- clean-installed imports are side-effect free and expose no synchronous driver
  ownership.

## Batch 7 — Performance, CI, and complete regression

Work, in order:

- Establish explicit performance and scale budgets.
- Build Linux, macOS, and Windows release-grade CI.
- Run the complete standalone regression suite.

Entrance: all default runtime, adapter, host, CLI, and package surfaces are
implemented.

Exit:

- budgets cover warm/cold query latency, mixed-load event-loop delay, indexing
  throughput, database size, memory, queue saturation, shutdown, and package size;
- CI exercises supported Node/platform/native-extension combinations, lexical-only
  mode, fresh and upgrade migration suites, protocol fixtures, exact packaging,
  and hostile paths;
- flaky timing assertions are replaced by fake clocks/schedulers or calibrated
  broad live ceilings; and
- one exact candidate artifact passes the entire regression matrix with failures
  preserved as artifacts rather than rerun away.

## Batch 8 — MIT metadata, public documentation, and examples

Work, in order:

- Finalize the parity manifest and exclusion ledger from implementation evidence.
- Apply MIT licensing consistently to the new release metadata and artifact.
- Rewrite public positioning and README.
- Write installation, CLI, MCP, and tool documentation.
- Write architecture and adapter documentation.
- Write security, privacy, and data-handling documentation.
- Write upgrade and license-transition notes.
- Write contribution and release procedures.
- Build polished public examples.

Entrance: Batch 7 has a stable candidate surface and measured behavior; ownership
and dependency-license audits remain satisfied.

Exit:

- every documented example runs against the exact packed artifact;
- docs distinguish stable guarantees, optional capabilities, compatibility
  aliases, known limits, and measured benchmark claims;
- public materials contain no private path/data, production-only contract,
  internal process token, or misleading continuous-sync claim; and
- manifest, lockfile, license, notices, badges, repository metadata, package
  metadata, declarations, and SBOM agree on the release identity and MIT grant.

## Batch 9 — Optional Context Warp integration

Work, in order:

- Design the optional Context Warp adapter over stable public ports.
- Implement and package the adapter separately from core Atlas.
- Test installation and failure isolation with both packages.
- Publish the combined flagship demo after the integration tests pass.

Entrance: Atlas core/public ports and Context Warp Drive are independently stable
and installable.

Exit:

- neither package imports the other's internals or requires the other at runtime;
- adapter absence, version mismatch, failure, and uninstall leave both cores
  functional;
- provenance/metadata enters only through the namespaced public extension seam;
  and
- the demo discloses optional dependencies and does not overstate benchmark or
  continuity claims.

## Batch 10 — Dogfood and preregistered benchmark

Work, in order:

- Dogfood the standalone package on its own repository.
- Pre-register the public benchmark before collecting comparison outcomes.
- Run baseline code-navigation trials.
- Run Atlas-assisted trials under the same tasks and controls.
- Evaluate the preregistered outcomes.
- Publish methods, raw aggregate results, exclusions, limitations, and calibrated
  claims.

Entrance: the exact documented package and optional integration, if evaluated,
have passed their release candidate gates.

Exit:

- dogfood defects are either fixed and rerun or listed as release blockers;
- treatment artifacts come from the real package and native orchestration rather
  than hand-authored substitutes;
- instance/model/tool-call/provenance/cost evidence is captured where applicable;
- baseline and assisted arms differ only by preregistered treatment; and
- the report separates observed results from inference and publishes null or
  negative findings.

## Batch 11 — Exact-artifact release and verification

Work, in order:

- Prepare the release version and changelog.
- Validate packed contents against the reviewed allowlist.
- Run clean-environment release-candidate smoke tests.
- Run final security, privacy, dependency, provenance, and supply-chain checks.
- Certify the exact candidate artifact as public-safe.
- Publish the MIT release only from the certified artifact and commit.
- Install and verify the public registry and GitHub release independently.
- Close the promotion record with every result, deferral, and known gap.
- Start the next lightweight production-divergence ledger.

Entrance: all prior batches are complete; publication authority, registry access,
tagging, and other irreversible actions remain operator-controlled.

Exit:

- the published digest equals the certified tarball digest;
- registry, repository, tag, release notes, SBOM/provenance, license detection,
  declarations, docs, and install commands agree;
- a clean public install passes smoke independently of local files;
- no unresolved manifest item is silently marked complete; and
- later production changes have an explicit portable, adapter-backed, or
  production-only capture path without forcing continuous synchronization.

## Gate-failure policy

A failed exit gate keeps the next batch closed. Repair the smallest owning batch,
rerun its focused checks, then rerun every downstream exact-artifact check whose
inputs changed. Do not work around a failed worker, migration, protocol, privacy,
or license gate in a later host or documentation batch. Deferred optional work is
allowed only when its public consequence is explicit and the default core remains
complete.
