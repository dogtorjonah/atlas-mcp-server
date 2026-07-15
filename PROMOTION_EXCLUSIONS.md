# Atlas Promotion Exclusion Ledger

This ledger records production capabilities and artifacts that do not enter the
standalone release unchanged. An exclusion is deliberate only when its reason,
public replacement or extension seam, scrub targets, and verification are
recorded here.

## Disposition rules

- `EXCLUDE`: the concept belongs to Voxxo or a private domain and has no public
  implementation in this release.
- `GENERALIZE`: preserve a useful capability under host-neutral names and types.
- `ADAPTER_ONLY`: expose an optional interface while keeping the production
  implementation outside the public package.
- `DEFER`: valid product work postponed until after the server release.
- `REMOVE`: delete dormant or misleading standalone material after reachability
  and license checks.

No excluded source may remain reachable through package exports, MCP tools, CLI
commands, migrations at the release head, examples, fixtures, packed artifacts,
or product claims.

## Private and operator-specific domains

| Production surface | Disposition | Reason | Public treatment | Scrub targets |
| --- | --- | --- | --- | --- |
| Therapy Atlas schema, ownership, domain types, worker handler, route boundary, Forge server, and tests | `EXCLUDE` | Private clinical/therapy domain unrelated to codebase intelligence | None | `therapy_atlas`, therapist/session fields, Therapy Atlas docs/tests/fixtures |
| Jonah-named candidate memory | `GENERALIZE` | Operator-memory review is potentially reusable; personal identity is not | `operator_memory` API and table via compatibility migration | migration/table/index/type/function/docs/test names containing `jonah_memory` except explicit historical upgrade notes |
| Jonah candidate-memory content | `EXCLUDE` | Runtime/operator data is private and is not source code | Schema and APIs only; never copy rows | database contents, exports, fixtures, screenshots, logs |
| Production owner instance fields used by Therapy Atlas | `EXCLUDE` | Relay authorization concept | None | `owner_instance_id` in Therapy Atlas artifacts |

## Swarm coordination and agent coaching

| Production surface | Disposition | Reason | Public treatment | Scrub targets |
| --- | --- | --- | --- | --- |
| Claims, squads, chatroom, task rails, and conflict forecasting | `EXCLUDE` | Voxxo orchestration primitives, not codebase facts | None | tool descriptions, prompts, schemas, examples, tests |
| Ambient Atlas automatic prompt injection | `EXCLUDE` | Relay tool-boundary behavior | Explicit Atlas calls only | ambient feature flags, term selection, cooldowns, prompt blocks |
| Atlas-first gate and commit-debt tracker | `EXCLUDE` | Agent behavior enforcement | Documentation may recommend workflows without runtime enforcement | relay reminders, debt state, system-prompt wording |
| Conditional blurb reminders | `EXCLUDE` | Relay coaching layer | Core commit validation remains | prompt/session hooks and reminder tests |
| Atlas Clock relay telemetry | `EXCLUDE` | Depends on in-memory relay tool events | Later generic observability only if backed by public events | relay session/tool timing fields |
| File witnesses backed by canonical agent events | `ADAPTER_ONLY` | Useful provenance idea but no generic event source exists | Optional provenance provider in a later release; no default witness promise | instance IDs, tap guidance, canonical-event readers, witness ranking claims |
| Model/session/cost-timeline author backfill | `EXCLUDE` | Depends on Voxxo transcripts and measured cost timelines | Accept explicit neutral attribution on public writes | transcript paths, session IDs, inferred author resolution |

## Relay runtime and infrastructure

| Production surface | Disposition | Reason | Public treatment | Scrub targets |
| --- | --- | --- | --- | --- |
| Relay worker-pool implementation and task types | `GENERALIZE` | Worker isolation is required; relay dispatch is not | Standalone worker-thread or sidecar protocol | `submitTask`, relay task names, worker registry imports |
| Relay Atlas MCP client registry and sidecar lifecycle | `GENERALIZE` | Public server needs transport, cancellation, and shutdown | Standard MCP transport and programmatic API | relay instance/session registry concepts |
| Relay HTTP/admin routes | `GENERALIZE` | Admin capability is useful; route coupling is not | CLI and public admin service | route request/response types and process-manager assumptions |
| Relay persistence lookup modules | `GENERALIZE` | Query semantics are useful; relay persistence imports are not | Typed public persistence service | imports from `relay/src/persistence` |
| Relay OAuth/process environment conventions | `EXCLUDE` | Host-specific process launch policy | Public server documents only its own environment | Claude/OAuth sanitizer references and relay process flags |
| Relay restart/deployment instructions | `EXCLUDE` | Public package has no Voxxo PM2 lifecycle | Normal package restart guidance | PM2 app names, relay ports, internal hostnames |

## Worktrees and repository lifecycle

| Production surface | Disposition | Reason | Public treatment | Scrub targets |
| --- | --- | --- | --- | --- |
| Atlas snapshot status and diff for ordinary repositories/worktrees | `GENERALIZE` | Useful repository intelligence | Retain generic status/diff tools | agent/chamber assumptions |
| Automatic worktree creation and Atlas seeding | `EXCLUDE` | Filesystem-layout mutation belongs to the host/operator | Optional explicit import/copy command only if later justified | lifecycle hooks and implicit worktree creation |
| Managed worktree merge orchestration | `ADAPTER_ONLY` | Generic database merge may be useful; lifecycle ownership is not | Optional repository adapter | claims, instance ownership, chamber metadata |

## UI and research artifacts

| Production surface | Disposition | Reason | Public treatment | Scrub targets |
| --- | --- | --- | --- | --- |
| Mission Control Atlas viewer and reindex panel | `DEFER` | React/Voxxo UI is not required for the standalone server | Later independent local workbench | Mission Control routes, auth, selectors, styling assumptions |
| Internal Atlas batch notes and audit reports | `EXCLUDE` | Work history contains internal process and possibly private context | Extract reusable decisions into public docs | agent names, rail IDs, internal paths, private findings |
| Existing ROI and dataset papers | `ADAPTER_ONLY` | Valuable evidence, but provenance/privacy/reproducibility require review | Publish only a scrubbed reproducible study | private repositories, transcripts, instance IDs, unmeasured token claims |
| Internal agent-feedback documents | `EXCLUDE` | Relay-specific operational history | Extract product issues without transcripts | prompts, identities, private paths |

## Legacy and misleading standalone material

| Standalone surface | Disposition | Reason | Required verification before removal |
| --- | --- | --- | --- |
| `_legacy/pipeline/embed.ts`, `extract.ts`, `summarize.ts` | `REMOVE` | Excluded from build and conflicts with deterministic/no-key positioning | Atlas reachability, package-content inspection, license review |
| `_legacy/providers/anthropic.ts`, `gemini.ts`, `localEmbedding.ts`, `ollama.ts`, `openai.ts` | `REMOVE` | Dormant network/provider implementations and unnecessary licensing/security surface | Atlas reachability, dependency scan, package-content inspection |
| nested `migrations/migrations/0001_init.sql` | `REMOVE` unless proven required | Non-recursive runner does not read it; duplicates schema bootstrap | Package/build consumer search and fresh-install test |
| unregistered `src/tools/flush.ts` | `REMOVE` or intentionally register | Dead or incomplete public surface | Atlas reachability and admin contract decision |
| disabled embedding claims that imply production parity | `GENERALIZE` | Scaffolding is not a working provider | State lexical-only default; add optional provider only after tests |
| README `npx atlas-mcp-server` command | `REMOVE`/replace | Does not match current package/bin identity | Clean-room package smoke test |

Removal verification completed on 2026-07-14 for both `_legacy` rows,
`src/tools/flush.ts`, and the duplicate nested migration: exact
import/export/registration and migration-consumer scans found no incoming
reachability; the production build and 71-test serial suite passed; a clean
tarball install imported every public entrypoint and applied all 20 direct
migrations; and the reviewed manifest contains none of the removed files,
provider markers, tests, source maps, raw source, or work records. The README,
examples, package identity, MIT grant, and installed-package checks are closed.

## Data and artifact exclusions

The following must never be copied from production or included in a package:

- `.atlas/` databases, WAL/SHM files, backups, migration launch files, locks, or
  embedding caches.
- Relay `data/`, message transcripts, canonical events, metadata indexes, Forge
  runtime directories, tool-result spools, and instance archives.
- `.env` files, tokens, keys, credentials, private URLs, internal hostnames, or
  desktop/sidecar configuration.
- Operator-memory rows, therapy records, file-witness events, agent transcripts,
  claims, task rails, or UI screenshots containing live state.
- Absolute home-directory paths, instance IDs, internal rail IDs, or agent names
  in public source comments, tests, examples, changelog entries, or fixtures.
- Generated build output, local `node_modules`, package-manager caches, temporary
  benchmark artifacts, and unpublished research corpora.

## Extension-seam decisions

Only these excluded concepts currently justify public interfaces:

1. **Worker service:** required for database, indexing, migration, filesystem, and
   embedding isolation.
2. **Persistence adapter:** SQLite remains default, but core tools consume typed
   operations rather than relay or raw driver ownership.
3. **Embedding provider:** optional, model/dimension identified, lexical fallback.
4. **Provenance provider:** deferred interface for explicit author/activity facts;
   no canonical-event or witness default.
5. **Repository adapter:** optional worktree/status/merge functions without
   automatic creation or host lifecycle authority.
6. **Context Warp receipt adapter:** the separate
   `@voxxo/atlas-context-warp` package maps digest-only public prepare receipts
   into protocol-v1 Atlas provenance evidence while both cores remain
   dependency-independent.

Claims, chatroom, task rails, Ambient Atlas, Therapy Atlas, and Mission Control do
not receive placeholder interfaces in the standalone core.

## Verification checklist

- [x] Searches for Therapy Atlas names return only explicit exclusion or migration
      history documentation.
- [x] Current API/schema/tool names use operator memory; the legacy personal table
      exists only during supported upgrade history.
- [x] No relay, claims, squad, chatroom, task-rail, Ambient Atlas, or canonical
      event import is reachable from public package exports.
- [x] No production runtime data or private path appears in tracked or packed
      artifacts.
- [x] Excluded `_legacy` source and the unregistered flush surface are removed
      after reachability, license, build, test, and package checks.
- [x] The duplicate nested migration is removed after package-consumer and
      fresh-install verification.
- [x] Worktree tools cannot implicitly create a worktree.
- [x] Optional providers degrade explicitly and do not fabricate missing evidence.
- [x] Public documentation distinguishes excluded integration from missing work.
- [x] Package allowlist, generated-output denylist, and clean-install checks pass
      on the current exact tarball; repeat privacy scans after final identity work.
