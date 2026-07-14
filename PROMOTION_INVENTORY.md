# Atlas Promotion Inventory

This inventory expands `PROMOTION_MANIFEST.md` into a concrete map of the
production Atlas snapshot and the standalone package receiving the promotion.
It distinguishes portable product behavior from host adapters and Voxxo-only
integration so the public synchronization is semantic rather than a directory
copy.

## Evidence boundary

- Production revision: `3f134e2090230be104a7409df4126384263a63bb`.
- Standalone revision before promotion edits:
  `815a07fd610fd9b63b620f00597fefac4e8a5619`.
- Production source catalog: 123 Atlas-path matches in the live Atlas catalog,
  plus integrations outside `relay/src/atlas` identified below.
- Production test inventory: 61 Atlas-named or Atlas-scoped test files.
- Standalone implementation inventory: 74 files under `src/` and `migrations/`,
  including four tests, eight excluded legacy-provider files, three prompt files,
  and a duplicate nested bootstrap migration.

## Production source inventory

### Public contract facade — `PORTABLE`

These files define the intended composite-tool and record contracts. The facade
is currently private and type-only; its contracts must be reconciled with the
standalone runtime rather than copied without verification.

- `packages/atlas/package.json`, `package-lock.json`, and `tsconfig.json`
- `packages/atlas/src/index.ts` and `src/types.ts`
- `packages/atlas/README.md`

### Portable core helpers — `PORTABLE`

Each file below contains host-neutral semantics that should become or remain a
standalone implementation:

- `relay/src/atlas/completenessScore.ts`: tiered metadata completeness.
- `relay/src/atlas/hazardFilters.ts`: weak-hazard output suppression.
- `relay/src/atlas/hygiene.ts`: cluster, pattern, hazard-key, and dedupe helpers.
- `relay/src/atlas/types.ts`: file, graph, changelog, highlight, and runtime types.
- `relay/src/atlas/queryLog.ts`: bounded recent-query context.
- `relay/src/atlas/paths.ts` and `migrationDir.ts`: package and migration paths.
- `relay/src/atlas/resources/context.ts`: deterministic repository context summary.
- `relay/src/atlas/tools/ask.ts`, `brief.ts`, `catalog.ts`, `changelog.ts`,
  `cluster.ts`, `cycles.ts`, `diff.ts`, `evidenceAuthority.ts`, `gaps.ts`,
  `graph.ts`, `graphComposite.ts`, `history.ts`, `hotspots.ts`, `impact.ts`,
  `incompleteEntryTiers.ts`, `lookup.ts`, `neighbors.ts`, `patterns.ts`,
  `plan_context.ts`, `query.ts`, `queryControl.ts`, `reachability.ts`, `search.ts`,
  `similar.ts`, `smells.ts`, `snippet.ts`, `structuralSymbols.ts`, and `trace.ts`:
  read-side retrieval, history, graph, risk, and formatting behavior.
- `relay/src/atlas/tools/commitIdentityValidation.ts`, `commitPayload.ts`,
  `commitResult.ts`, `deriveCommitCandidates.ts`, and `hazardsAutoSync.ts`:
  writeback validation, normalization, results, candidate generation, and hazard
  convergence.
- `relay/src/atlas/tools/helpers.ts`: typed registration and response reminders;
  wording must be made product-neutral.

### Portable behavior requiring standalone adapters — `ADAPTER`

- `relay/src/atlas/config.ts`: layered CLI, process, and `.atlas/.env` config.
  The public implementation may use synchronous startup-only config I/O, but the
  same code must not be reused on request paths.
- `relay/src/atlas/db.ts`, `dbAsync.ts`, and the database behavior implemented in
  `relay/src/workerPool/handlers/atlasDbImpl.ts`: persistence semantics must move
  behind a standalone worker boundary.
- `relay/src/atlas/embeddings.ts`: optional embedding model/dimension identity,
  hash-gated refresh, batching, and lexical fallback.
- `relay/src/atlas/changelogRecovery.ts`: recovery and cleanup behind standalone
  persistence and filesystem services.
- `relay/src/atlas/mergeAtlas.ts` and `mergeAtlasAsync.ts`: generic database merge
  behavior may be retained; swarm worktree orchestration must not be required.
- `relay/src/atlas/pipeline/community.ts`, `crossref.ts`, `flow.ts`, `index.ts`,
  `progress.ts`, `scan.ts`, `shared.ts`, `structure.ts`, and `treesitter.ts`:
  deterministic indexing algorithms with public worker/filesystem adapters.
- `relay/src/atlas/pipeline/prompts/pass05.txt`, `pass1.txt`, and `pass2.txt`:
  currently shipped pipeline resources; verify whether deterministic production
  code still consumes them before retaining them.
- `relay/src/atlas/refreshCoordinator.ts`, `refreshDaemon.ts`, `reindexLock.ts`,
  `reindexWorker.ts`, `watcher.ts`, and `worktreeSeed.ts`: operational behavior
  requiring public process, watcher, lock, and repository adapters.
- `relay/src/atlas/server.ts`: tool registration must be reconciled with the
  standalone MCP transport and public schemas.
- `relay/src/atlas/tools/admin.ts`, `bridge.ts`, `commit.ts`, `reindex.ts`,
  `rootDiscoveryAsync.ts`, and `worktree.ts`: portable user capability with
  persistence, process, filesystem, bridge, or provenance boundaries.
- `relay/src/atlas/index.ts` and `vendor.d.ts`: replace with truthful package
  exports and dependency typings for the public build.

### Production-only source — `VOXXO_ONLY`

- `relay/src/atlas/fileWitnesses.ts`: canonical agent-event witness recording.
- `relay/src/atlas/changelogAuthorBackfill.ts`: model/session/cost-timeline author
  attribution tied to Voxxo telemetry. A generic explicit-author import can be a
  later public feature, but this backfill is not portable.
- `relay/src/atlas/migrations/0017_therapy_atlas.sql` and
  `0018_therapy_atlas_security.sql`: private Therapy Atlas domain and ownership.
- `relay/src/workerPool/handlers/atlasFileWitnesses.ts`, `ambientAtlas.ts`, and
  `therapyAtlas.ts`: swarm witness, ambient retrieval, and therapy boundaries.
- `relay/src/ambientAtlasContext.ts`, `ambientAtlasTaskRailSignal.ts`, and
  `fcToolContextAmbientAtlas.ts`: automatic relay prompt enrichment.
- `relay/src/atlasClock.ts`, `atlasCommitBlurbReminder.ts`, `atlasDebtTracker.ts`,
  and `atlasFirstGate.ts`: relay agent coaching and telemetry.
- `relay/src/atlasMcpClient.ts`, `atlasMcpClientRegistry.ts`,
  `atlasMcpWorkerClient.ts`, `atlasReindexWorkerClient.ts`, and
  `relayAtlasSidecar.ts`: relay-local client and sidecar lifecycle.
- `relay/src/therapyAtlasDomain.ts` and Therapy Atlas route/tool boundaries.

### Replace or generalize

- `relay/src/atlas/migrations/0012_jonah_memory.sql`: rename and redesign as
  host-neutral operator-memory candidates. No personal name belongs in the public
  schema, API, or documentation.
- `relay/src/workerPool/handlers/atlasHandlers.ts`, `atlasCommitMessageImpl.ts`,
  `adminAtlasReindex.ts`, and `worktreeAtlas.ts`: use as semantic and concurrency
  references, then implement public worker messages without relay task types.
- `relay/src/persistence/atlasLookup.ts`, `atlasLookupAsync.ts`, and
  `localAtlasCommitArtifacts.ts`: preserve useful lookup/writeback behavior behind
  public services; do not import relay persistence code.
- `relay/src/routes/atlasCommitMessage.ts` and `atlasCommitPayload.ts`: preserve
  validation semantics in MCP/package APIs, not HTTP route coupling.
- `relay/src/managedWorktreeAtlas.ts` and `worktreeAtlasWorkerClient.ts`: retain
  only generic repository/worktree operations justified for standalone users.

### Reject from the release

The excluded `_legacy` tree is outside the TypeScript build and conflicts with
the deterministic, no-key product claim. Remove it after reachability and license
checks rather than republishing dormant provider code:

- `relay/src/atlas/_legacy/pipeline/embed.ts`, `extract.ts`, and `summarize.ts`
- `relay/src/atlas/_legacy/providers/anthropic.ts`, `gemini.ts`,
  `localEmbedding.ts`, `ollama.ts`, and `openai.ts`

Promotion result: the corresponding standalone `_legacy` files were deleted after
exact import/export scans found no incoming references. The rebuilt package has no
provider endpoint or API-key surface; production retains its private copy outside
this standalone release.

### Migration classification

| Migration | Disposition | Reason |
| --- | --- | --- |
| `0001_init` through `0007_changelog_recovery_key` | `PORTABLE` | Core files, graph, FTS, symbols, references, metrics, highlights, chunks, authors, and recovery |
| `0008_file_witnesses` | `REPLACE` | Witness concept is agent-specific; retain only if generalized provenance is justified |
| `0009_file_tags` through `0011_hazards_with_ranges` | `PORTABLE` | Tags, snapshots, and structured ranged hazards |
| `0012_jonah_memory` | `REPLACE` | Generalize to operator-memory candidates with a safe upgrade path |
| `0013_symbol_identity` through `0016_changelog_idempotency` | `PORTABLE` | Symbol identity, model/engine attribution fields, and idempotent writes; attribution must allow neutral hosts |
| standalone `0017_operator_memory` | `PORTABLE` — completed | Rename the historical candidate table and indexes without rewriting released migration history or losing rows |
| `0017_therapy_atlas`, `0018_therapy_atlas_security` | `VOXXO_ONLY` | Private Therapy Atlas domain |
| nested `migrations/0001_init` mirror | `REMOVE` — completed | Non-recursive runner and exact package-consumer smoke proved it was duplicate packaging debris |

### Production UI and documentation

- `app/app/components/atlas-viewer/*` and
  `app/app/components/instances/AtlasReindexStatusPanel.tsx`: `DEFER` as design
  input for a later independent local workbench, not part of the server release.
- `docs/research/atlas-roi-study/*` and `atlas-dataset-paper/*`: `ADAPTER` after
  privacy, provenance, and reproducibility review; useful foundations for public
  evidence but not publishable by assumption.
- `docs/atlas-commit-ergonomics.md` and `docs/atlas-roi-baseline.md`: `ADAPTER`
  into public product and benchmark documentation.
- `docs/atlas/atlas-batch-*`, `batch-*`, Gemini lifecycle/communication/tool
  notes, and `docs/audit/atlas-*`: `VOXXO_ONLY` work history. Mine decisions and
  defects, but do not ship the internal artifacts.

## Standalone source inventory

### Package and release surface

- `package.json`: `@voxxo/atlas` `0.1.0`, AGPL baseline, build/check/dev/init/start
  scripts, `atlas` and `atlas-mcp` binaries, no test script, and no Node engines.
- `README.md`: deterministic product story and broad tool table; its quickstart
  invokes `npx atlas-mcp-server` even though the package is named `@voxxo/atlas`.
- `AGENTS.md`: standalone Atlas development and Atlas-writeback discipline.
- `PROMOTION_MANIFEST.md`: frozen promotion contract and release gates.
- No `.github/` workflow, `docs/` directory, release workflow, examples directory,
  security policy, contribution guide, changelog, or migration guide exists at
  the frozen standalone revision.

### Core and host files

- `src/config.ts`, `db.ts`, `dbAsync.ts`, `embeddings.ts`, `index.ts`, `paths.ts`,
  `queryLog.ts`, `resources/context.ts`, `server.ts`, `types.ts`, `vendor.d.ts`,
  and `watcher.ts`.
- `dbAsync.ts` is not an asynchronous I/O boundary: its promise-returning wrappers
  open and execute synchronous `better-sqlite3` calls on the caller. It must be
  replaced before claiming responsive concurrent MCP handling.
- `embeddings.ts` deliberately throws or disables dense retrieval. This is an
  honest baseline, not a production-equivalent embedding implementation.

### Deterministic indexing pipeline

- `src/pipeline/community.ts`, `crossref.ts`, `flow.ts`, `index.ts`, `progress.ts`,
  `scan.ts`, `shared.ts`, `structure.ts`, and `treesitter.ts`.
- `src/pipeline/prompts/pass05.txt`, `pass1.txt`, and `pass2.txt`; reachability and
  product-claim review must decide whether these resources remain necessary.

### MCP tool implementations

- Composite/operations: `admin.ts`, `audit.ts`, `graphComposite.ts`, `query.ts`,
  `commit.ts`, `diff.ts`, and `worktree.ts`.
- Retrieval: `ask.ts`, `brief.ts`, `catalog.ts`, `changelog.ts`, `cluster.ts`,
  `history.ts`, `lookup.ts`, `patterns.ts`, `plan_context.ts`, `search.ts`,
  `similar.ts`, and `snippet.ts`.
- Graph/risk: `cycles.ts`, `gaps.ts`, `graph.ts`, `hotspots.ts`, `impact.ts`,
  `neighbors.ts`, `reachability.ts`, `smells.ts`, `structuralSymbols.ts`, and
  `trace.ts`.
- Writeback helpers: `commitIdentityValidation.ts`, `commitPayload.ts`,
  `commitResult.ts`, `deriveCommitCandidates.ts`, and `hazardsAutoSync.ts`.
- Infrastructure: `bridge.ts`, `helpers.ts`, `reindex.ts`, and `flush.ts`.
- `flush.ts` was not registered or imported and has been removed from standalone;
  queue/reindex behavior remains available through the registered admin surface.
- Production-only portable helpers missing as standalone files include
  `evidenceAuthority.ts`, `queryControl.ts`, `incompleteEntryTiers.ts`,
  `completenessScore.ts`, `hazardFilters.ts`, `hygiene.ts`, and
  `rootDiscoveryAsync.ts`.

### Tests and migrations

- Tests: `commitPayload.test.ts`, `dbAsync.test.ts`, `queryDispatch.test.ts`, and
  `worktree.test.ts`; six `node:test` cases pass, but no canonical package test
  script exists and Vitest rejects the files as empty suites.
- Migrations: production-parity names from `0001` through `0016`, including the
  duplicate `0002` number, file witnesses, personal `0012_jonah_memory`, and the
  nested bootstrap mirror.
- No migration test fixture, fresh-install test, upgrade fixture, interrupted
  migration test, or corrupt-database recovery test is present.

Promotion result: the suite now includes nine `node:test` cases, including focused
fresh and pre-`0017` upgrade coverage that preserves operator-memory rows, duplicate
dedupe keys, row identity, and changelog relationships. `npm run test:package`
builds, packs, installs, imports all five current export paths, resolves both bins,
verifies the 140-file allowlist, applies all 18 direct migrations, and proves the
fresh head exposes only neutral operator-memory schema objects. The duplicate
nested migration is deleted. Exact frozen-package staged upgrade, interruption,
and corruption fixtures remain open work.

### Excluded legacy source

Standalone duplicates the production `_legacy` pipeline and Anthropic, Gemini,
local, Ollama, and OpenAI providers. The tree is excluded by `tsconfig.json` and
should be removed after reachability and third-party-license validation.

Promotion result: the entire standalone `_legacy` tree is removed, the obsolete
TypeScript exclusion is gone, the production build and seven-test suite pass, and
the post-build npm manifest contains no removed file or provider marker.

## Capability matrix

| Capability | Production state | Standalone state | Disposition |
| --- | --- | --- | --- |
| Composite query/graph/audit/admin tools | Deep, typed, extensively tested | Broad surface exists with older behavior | `PORTABLE` reconciliation |
| Evidence authority | Explicit current/index/history/inference envelope | Missing dedicated helper and consistent envelope | `PORTABLE` priority |
| Snippet-first lookup | Curated highlights, hazards, live-source precedence, dedupe | Earlier lookup implementation | `PORTABLE` plus golden tests |
| Query planning and cancellation | Shared bounded controller | No `queryControl.ts` | `PORTABLE` |
| Completeness and hygiene | Tiered scoring, filters, fuzzy dedupe | Partial behavior embedded in tools | `PORTABLE` shared helpers |
| History analytics | Count, entries, timeline, grouping, filters, relevance | History files exist; production semantics unverified | `PORTABLE` contract comparison |
| Snapshots/diffs | Retention, historical endpoints, git fallback | Backported direct tools with four-test total suite | `PORTABLE` with fixtures |
| Graph analysis | Symbol-aware impact, trace, cycles, reachability | Broad graph handlers exist | `PORTABLE` semantic parity |
| Writeback | Strict identity, batch, idempotency, ranged-hazard convergence | Strong partial backport | `PORTABLE` plus transaction tests |
| Database execution | Synchronous SQLite isolated in relay workers | Synchronous SQLite runs inside promise wrappers | `REPLACE` with standalone workers |
| Index/refresh/watch | Detached worker, locking, daemon, repair paths | In-process pipeline and watcher | `ADAPTER` |
| Dense embeddings | Local 384-dimensional engine with gating and refresh | Explicitly disabled scaffold | `ADAPTER`, optional |
| File witnesses | Canonical event-backed tap provenance | Schema/read remnants without host evidence | `VOXXO_ONLY` default; future provider |
| Worktree Atlas | Managed seeds, merges, workers, UI | Status/diff tools exist | Generic subset `PORTABLE`; orchestration excluded |
| Ambient Atlas | Relay tool-boundary automatic retrieval | Absent | `VOXXO_ONLY` |
| Operator memory | Jonah-named candidate inbox | Jonah-named migration copied | `REPLACE` as neutral operator memory |
| Therapy Atlas | Private schema, handlers, routes, tests | Absent | `VOXXO_ONLY` |
| Local visual workbench | Mission Control Atlas viewer | Absent | `DEFER` |
| Public packaging | Private facade and monorepo runtime | Publish-shaped but incomplete release hygiene | `REPLACE` release surface |

## Relay-coupling boundaries

| Production dependency | Public boundary |
| --- | --- |
| Relay worker-pool task dispatch | Standalone worker-thread or sidecar protocol with cancellation and queue bounds |
| `better-sqlite3` worker-owned handles | Typed persistence service; no synchronous request-path fallback |
| Canonical agent events and file witnesses | Optional provenance provider; absent by default |
| Claims, squads, chatroom, task rails | Excluded from Atlas core |
| Ambient tool-boundary injection | Excluded; public callers invoke Atlas explicitly |
| Worktree lifecycle and chamber seeding | Optional repository adapter; no automatic worktree creation |
| Relay Atlas MCP client registry | Normal MCP transport and programmatic package API |
| Relay routes and admin process launching | CLI/admin service with safe dry-run, locks, and explicit mutation |
| Jonah candidate-memory naming | Host-neutral operator-memory candidates and neutral attribution |
| Therapy Atlas domain and ownership | Excluded completely |
| Mission Control components | Later independent workbench, if justified |
| Relay token/cost telemetry | Optional measured provider telemetry; never synthesized from characters |

## Configuration and dependency delta

### Configuration

Standalone currently supports `ATLAS_SOURCE_ROOT`, `ATLAS_WORKSPACE`,
`ATLAS_DB_PATH`, `ATLAS_CONCURRENCY`, `ATLAS_SQLITE_VEC_EXTENSION`,
`ATLAS_EMBEDDING_MODEL`, and `ATLAS_EMBEDDING_DIMENSIONS` plus corresponding CLI
flags. Production additionally establishes owner identity, snapshot retention,
embedding model/dimension aliases, layered worktree `.atlas/.env` resolution,
timeouts, and relay-only feature flags. Public config must choose one documented
name per setting, retain safe aliases only where compatibility requires them, and
keep relay feature flags out.

### Runtime dependencies

| Dependency | Production | Standalone baseline | Promotion action |
| --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` | `^1.12.0` in relay | `^1.0.0` | Reconcile API changes and pin tested range |
| `better-sqlite3` | `^12.8.0` relay; `^12.10.0` root | `^11.10.0` | Upgrade with migration/native-platform tests |
| `sqlite-vec` | `^0.1.9` | `^0.1.6` | Upgrade only after optional-vector tests |
| `tree-sitter` | `^0.25.0` | `^0.25.0` | Retain; verify language-peer compatibility |
| `zod` | `^4.3.6` | `^3.25.0` | Treat as an API migration, not a version bump |
| TypeScript | monorepo-managed | `^5.9.3` | Declare and test supported build range |
| Node | production runtime currently Node 22 | no standalone engines field | Select and test public support matrix |

## Production test disposition matrix

`DIRECT` means the test should port with only import/fixture normalization.
`ADAPT_FIXTURE` preserves portable behavior but replaces relay workers, routes,
databases, clocks, or worktrees. `REPLACE_EQUIVALENT` needs a new public test for
the same user invariant. `VOXXO_ONLY` is deliberately excluded.

| Production test | Disposition |
| --- | --- |
| `adminRoutes.atlasReindexStatus.test.ts` | `REPLACE_EQUIVALENT` — CLI/admin status |
| `ambientAtlasContext.test.ts` | `VOXXO_ONLY` |
| `ambientAtlasIntegration.test.ts` | `VOXXO_ONLY` |
| `atlasBriefHazardRanges.test.ts` | `DIRECT` |
| `atlasCatalog.test.ts` | `DIRECT` |
| `atlasChangelogAuthorBackfill.test.ts` | `VOXXO_ONLY` telemetry backfill |
| `atlasChangelogRecovery.test.ts` | `ADAPT_FIXTURE` persistence/recovery |
| `atlasCommitBatch.test.ts` | `DIRECT` |
| `atlasCommitBlurbReminder.test.ts` | `VOXXO_ONLY` relay coaching |
| `atlasCommitCrossWorkspace.test.ts` | `ADAPT_FIXTURE` bridge/persistence |
| `atlasCommitDriftResponse.test.ts` | `DIRECT` |
| `atlasCommitIdempotency.test.ts` | `DIRECT` |
| `atlasCommitInputSchema.test.ts` | `DIRECT` |
| `atlasCommitMessage.test.ts` | `ADAPT_FIXTURE` public worker writeback |
| `atlasCommitResult.test.ts` | `DIRECT` |
| `atlasCommitRetry.test.ts` | `ADAPT_FIXTURE` worker locking/retry |
| `atlasCommitSidecarFallback.test.ts` | `REPLACE_EQUIVALENT` — no inline fallback |
| `atlasCompletenessScore.test.ts` | `DIRECT` |
| `atlasConfig.test.ts` | `DIRECT` with public config names |
| `atlasCrossrefCollisionFiltering.test.ts` | `DIRECT` |
| `atlasDebtTracker.test.ts` | `VOXXO_ONLY` |
| `atlasFilePhase.test.ts` | `DIRECT` |
| `atlasFileWitnesses.test.ts` | `VOXXO_ONLY` default provenance |
| `atlasFtsHazardsWithRanges.test.ts` | `DIRECT` |
| `atlasGapFiltering.test.ts` | `DIRECT` |
| `atlasHazardsAutoSync.test.ts` | `DIRECT` |
| `atlasHazardsWithRanges.test.ts` | `DIRECT` |
| `atlasHistoryAnalytics.test.ts` | `DIRECT` |
| `atlasHistoryRelevance.test.ts` | `DIRECT` |
| `atlasHygiene.test.ts` | `DIRECT` |
| operator-memory persistence test | `REPLACE_EQUIVALENT` neutral public fixture and names |
| `atlasLaneE.test.ts` | `ADAPT_FIXTURE` inspect worker/persistence assumptions |
| `atlasLookup.test.ts` | `DIRECT` |
| `atlasLookupAsync.test.ts` | `ADAPT_FIXTURE` real worker boundary |
| `atlasLookupHazardRanges.test.ts` | `DIRECT` |
| `atlasLookupHistoryPagination.test.ts` | `DIRECT` |
| `atlasLookupSnippetFirst.test.ts` | `DIRECT` |
| `atlasMcpClient.nativeError.test.ts` | `VOXXO_ONLY` relay client |
| `atlasMergeWorktrees.test.ts` | `ADAPT_FIXTURE` optional repository adapter |
| `atlasMigrationDir.test.ts` | `DIRECT` |
| `atlasPatternsFormat.test.ts` | `DIRECT` |
| `atlasQueryInferAction.test.ts` | `DIRECT` |
| `atlasReachabilityFramework.test.ts` | `DIRECT` |
| `atlasRefreshDaemon.test.ts` | `ADAPT_FIXTURE` standalone process service |
| `atlasScanTargets.test.ts` | `DIRECT` |
| `atlasStress.test.ts` | `ADAPT_FIXTURE` standalone DB/workers |
| `atlasToolParity.test.ts` | `DIRECT` against public contract facade |
| `atlasToolSchemas.test.ts` | `DIRECT` |
| `atlasWatcherCoordination.test.ts` | `ADAPT_FIXTURE` standalone watcher/worker |
| `atlasWave49FtsRebuild.test.ts` | `DIRECT` migration/bootstrap regression |
| `atlasWorkspaceAlias.test.ts` | `DIRECT` |
| `atlasWorktreeTools.test.ts` | `ADAPT_FIXTURE` generic repository adapter |
| `bridgeRoutes.normalizeAtlasCommitPayload.test.ts` | `REPLACE_EQUIVALENT` MCP/package normalization |
| `fcToolContextAmbientAtlas.test.ts` | `VOXXO_ONLY` |
| `managedWorktreeAtlas.test.ts` | `VOXXO_ONLY` lifecycle orchestration |
| `therapyAtlas.integration.test.ts` | `VOXXO_ONLY` |
| `therapyAtlasDomain.test.ts` | `VOXXO_ONLY` |
| `atlas/__tests__/commitIdentityValidation.test.ts` | `DIRECT` |
| `atlas/__tests__/commitPayload.test.ts` | `DIRECT` |
| `atlas/__tests__/embeddings.test.ts` | `DIRECT` helper tests plus provider adapter cases |

The public suite also needs new tests not represented by a direct production
file: clean installation, supported schema upgrades from standalone `0.1.0`,
interrupted migration recovery, worker crash/cancellation/backpressure, MCP stdio
framing, package exports, clean-room installation from the packed artifact,
cross-platform native dependencies, private-data scanning, and MIT/package
metadata consistency.

## Immediate conclusions

1. The standalone tool surface is broader than its four-test suite suggests; the
   promotion is primarily semantic hardening and runtime isolation, not creation
   from scratch.
2. The first implementation prerequisite is a real standalone worker boundary.
   Porting production handlers before that would reproduce the main-thread
   blocking failure production already corrected.
3. Portable production helpers and tests should move before large handlers so
   later ports share evidence authority, query control, hygiene, and contracts.
4. Personal, therapy, ambient, claim, and relay coaching surfaces require explicit
   exclusion or neutral replacement; filename parity is not approval.
5. Release hygiene is a product gap equal to code parity: correct package commands,
   canonical tests, Node support, CI, migration fixtures, documentation, license
   proof, artifact inspection, and public smoke tests are mandatory.
