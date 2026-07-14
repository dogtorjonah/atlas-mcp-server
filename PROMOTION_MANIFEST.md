# Atlas Production Promotion Manifest

This document controls the next deliberate promotion of Atlas from the Voxxo
Swarm production laboratory into the standalone public package. Production may
continue evolving after the snapshot below; later changes enter this promotion
only when they are explicitly added to the manifest.

## Frozen baselines

| Surface | Frozen revision | State at freeze |
| --- | --- | --- |
| Voxxo Swarm production | `3f134e2090230be104a7409df4126384263a63bb` | `main`, equal to `origin/main`; no tracked changes; untracked `scratch/` excluded |
| Standalone Atlas | `815a07fd610fd9b63b620f00597fefac4e8a5619` | `main`, equal to `origin/main`; clean working tree |

The production package facade is `@voxxo/atlas` version `0.0.1` and is private.
The standalone package is `@voxxo/atlas` version `0.1.0` and currently declares
`AGPL-3.0-only`. The target public release is MIT, subject to completion of the
copyright-ownership and third-party-license audits.

### Schema heads

| Surface | Physical migration head | Portable interpretation |
| --- | --- | --- |
| Production | `0018_therapy_atlas_security.sql` | Portable Atlas currently ends at `0016_changelog_idempotency.sql`; `0017` and `0018` are Voxxo Therapy Atlas extensions |
| Standalone | `0017_operator_memory.sql` | Preserves historical `0012` upgrade identity, then exposes only neutral operator-memory schema and current API names |

The standalone duplicate nested `migrations/migrations/0001_init.sql` was confirmed
as packaging debris and removed after exact clean-package migration coverage.

### Standalone validation baseline

- TypeScript project check: clean, zero diagnostics, on Node `v22.22.3`.
- Test sources: four files using `node:test`, containing six tests total.
- Direct Node test run: six passed, zero failed.
- Vitest compatibility: all four files are reported as “no test suite found”
  even though their TAP tests execute. The package has no `test` script and does
  not declare Vitest. A public test command and one canonical runner are required.
- Package version: `0.1.0`.
- TypeScript target: ES2022 with strict checking.
- Declared Node engine range: none. The supported range must be chosen, tested,
  and added before release.
- Dense embeddings: scaffolded but deliberately disabled; deterministic BM25/FTS
  retrieval is the current standalone behavior.

### Standalone public tool baseline

The README and server registration expose these composite and direct tools:

- `atlas_query`: search, lookup, brief, snippet, similar, plan context, cluster,
  patterns, history, catalog, and deterministic evidence assembly (`ask`).
- `atlas_graph`: impact, neighbors, trace, cycles, reachability, graph, and cluster.
- `atlas_audit`: gaps, smells, and hotspots.
- `atlas_admin`: initialization, reindexing, and bridge discovery.
- `atlas_commit`: validated metadata and changelog writeback.
- `atlas_diff`, `atlas_changelog_diff`, and `atlas_snapshot`.
- `atlas_worktree_status` and `atlas_worktree_diff`.

The detailed contract inventory will record action schemas, aliases, result
envelopes, errors, pagination, and compatibility requirements before handlers are
replaced.

## Disposition vocabulary

Every production file, symbol, migration, test, and behavior considered for this
release must receive one of these dispositions:

| Disposition | Meaning |
| --- | --- |
| `PORTABLE` | Promote the behavior into standalone with no Voxxo runtime dependency |
| `ADAPTER` | Preserve the behavior behind a public host, persistence, worker, embedding, or provenance interface |
| `VOXXO_ONLY` | Deliberately exclude relay, swarm, private-domain, or operator-specific behavior |
| `REPLACE` | Keep the public capability but implement it through a cleaner standalone design |
| `DEFER` | Valid public work intentionally postponed beyond this release |
| `REJECT` | Do not carry the behavior forward; rationale and replacement guidance required |

Verification status is tracked separately as `not_started`, `ported`,
`tested`, `documented`, or `verified`. A disposition is a design decision, not
evidence that the work is complete.

## Initial production-to-public map

This is the seed map. The complete file- and symbol-level inventory will expand
it without changing the disposition vocabulary.

| Production surface | Initial disposition | Public direction |
| --- | --- | --- |
| `packages/atlas` types and facade contracts | `PORTABLE` | Reconcile with standalone types and make the public contracts truthful to runtime behavior |
| Evidence-authority resolution | `PORTABLE` | Preserve current-source precedence, freshness, confidence, completeness, and provenance |
| Query control and bounded output | `PORTABLE` | Port pagination, cancellation, snippet-first behavior, and accurately labeled character limits |
| Completeness tiers, hygiene, and hazard filtering | `PORTABLE` | Promote deterministic classifiers and actionable gap output |
| Catalog, search, plan context, lookup, brief, and snippet | `PORTABLE` | Reconcile production retrieval while keeping a deterministic no-embedding default |
| History count, entries, timeline, grouping, and filters | `PORTABLE` | Promote the full analytics surface with stable pagination |
| Snapshots and diffs | `PORTABLE` | Preserve retained-snapshot resolution and portable git fallback |
| Impact, neighbors, trace, cycles, and reachability | `PORTABLE` | Promote file- and symbol-level graph behavior with bounded traversal |
| Patterns, similarity, clusters, gaps, smells, and hotspots | `PORTABLE` | Port algorithms and label heuristic confidence honestly |
| Commit validation, identity fields, idempotency, and snapshots | `PORTABLE` | Preserve transactional and retry-safe writeback semantics |
| SQLite persistence | `ADAPTER` | Keep SQLite as the default through a typed standalone persistence boundary |
| Production worker-pool handlers | `ADAPTER` | Replace with standalone workers; never import `relay/src` or add blocking request-path fallback |
| Indexing, parsing, watching, repair, and reindexing | `ADAPTER` | Retain portable algorithms behind standalone filesystem and worker services |
| Dense embeddings | `ADAPTER` | Optional provider with model/dimension identity and deterministic lexical degradation |
| Generic worktree freshness | `PORTABLE` | Keep repository snapshot comparison without swarm claim or lifecycle coupling |
| File witnesses and canonical agent events | `VOXXO_ONLY` | Exclude defaults; consider a future host-neutral provenance provider |
| Claims, task rails, chatroom, Ambient Atlas, and conflict forecasting | `VOXXO_ONLY` | Remain Voxxo integration features |
| Therapy Atlas migrations and handlers | `VOXXO_ONLY` | Never enter the public Atlas package |
| Jonah candidate-memory schema | `REPLACE` | Remove operator identity; retain only a justified host-neutral concept with an upgrade path |
| Mission Control Atlas UI | `DEFER` | Consider a separate local workbench after the server release is stable |
| Context Warp Drive metadata integration | `DEFER` | Deliver later as an optional adapter implementing `FileMetaProvider`; keep both cores independent |

## Promotion invariants

1. Production remains free to diverge after the frozen revision.
2. No production change enters implicitly because two files happen to share a
   name or lineage.
3. Portable behavior is promoted semantically, with tests, rather than assumed
   correct because the source text was copied.
4. Standalone Atlas must not import Voxxo relay code or depend on private runtime
   data, canonical events, prompts, claims, agents, task rails, or Mission Control.
5. Database, filesystem, parsing, and embedding work reachable from MCP request
   handling must use the standalone asynchronous worker boundary. Slow workers
   produce bounded delay, cancellation, or explicit degradation—not inline
   synchronous fallback.
6. Identical deterministic inputs must retain stable ordering and output wherever
   the public contract promises determinism.
7. Response-size character limits may be reported as characters. Token and cost
   claims require measured provider telemetry and are never synthesized from text
   length.
8. MIT publication is blocked until ownership and dependency-license evidence is
   complete. Existing AGPL releases remain available under their original terms.
9. No private path, secret, runtime database, operator-specific behavior, therapy
   data, or proprietary fixture may appear in source, tests, documentation, or
   packed artifacts.
10. Context Warp Drive and Atlas remain independently installable; integration is
    optional and adapter-based.

## Evidence required for each promoted surface

Each completed manifest entry must link or point to:

- The production source revision and relevant file or symbol.
- The standalone destination and public contract.
- The disposition rationale.
- Fresh-install and upgrade implications, when persistent state is affected.
- Unit or integration tests proving the portable behavior.
- Documentation and compatibility notes for public users.
- Validation evidence: typecheck, tests, protocol checks, and any relevant
  performance, concurrency, security, or cross-platform result.

## Release gates

The promotion is not complete until all of the following are true:

- Every production Atlas surface in the frozen snapshot has a disposition.
- Every `PORTABLE`, `ADAPTER`, and `REPLACE` entry is implemented or explicitly
  deferred with user-visible consequences documented.
- Fresh installation and supported schema upgrades both pass.
- The public MCP server remains responsive during concurrent query, indexing,
  writeback, watching, and optional embedding work.
- The canonical test command, TypeScript check, build, package inspection,
  migration tests, protocol tests, security checks, and clean-install smoke tests
  pass in the declared support matrix.
- MIT ownership and third-party-license audits are complete, and all package and
  repository metadata agree on the license.
- Public documentation contains a verified quickstart, complete tool reference,
  architecture and data-handling explanation, migration guide, license-transition
  notice, and calibrated benchmark claims.
- The exact packed artifact is installed and smoke-tested before publication, and
  the registry artifact is independently smoke-tested afterward.

## Later production additions

Any production change after the frozen SHA must be listed here before promotion:

| Production revision | Surface | Reason for inclusion | Disposition | Verification |
| --- | --- | --- | --- | --- |
| _None_ |  |  |  |  |

At release closure, this manifest becomes the baseline for the next intentional
Voxxo-to-public divergence cycle.
