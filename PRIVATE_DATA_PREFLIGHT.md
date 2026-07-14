# Private-Data and Public-Artifact Preflight

Run date: 2026-07-14 UTC. Source baseline: standalone `815a07f` plus the current
promotion records. This is the initial remediation census, not the final release
certificate. Every blocker below must be closed before the exact `v1.0.0` artifact
is tagged or published.

## Scope

Automated and manual checks covered:

- TypeScript source, tests, prompts, migrations, README, AGENTS, package and
  lockfile metadata, and promotion/relicensing documents.
- Hidden and ordinary repository files, excluding `.git`, `node_modules`, and
  generated `dist` where appropriate.
- Secret prefixes and secret-like assignments.
- Absolute local paths, private network addresses, Tailscale names, internal
  hostnames, operator/personal names, Therapy Atlas terms, relay paths, instance
  identifiers, task-process identifiers, and external URLs.
- Runtime databases, environment files, keys, logs, JSONL, backups, binary/native
  assets, WASM, archives, images, and proprietary fixtures.
- The current `npm pack --dry-run --json` manifest.
- All three indexing prompt templates by manual reading.

The final gate repeats these checks on a clean checkout, generated `dist`, the
actual tarball, extracted tarball, SBOM/provenance records, source maps, and public
registry preview.

## Automated scan results

| Scan | Result |
| --- | --- |
| Private-key/API-token prefix patterns | No matches |
| Secret-like identifiers/headers | No provider API-key variables or authorization headers remain in active source after dormant-provider removal |
| `.env`, database, SQLite, JSONL, log, key, certificate, backup, or runtime-data files | No repository matches |
| Native/binary/WASM/archive/image artifacts outside excluded dependencies/build output | No matches |
| Private/Tailscale IPs or hostnames | No matches |
| Literal relay instance IDs, rail IDs, rollout labels, or implementation-step IDs in public source | No matches after remediation |
| Therapy Atlas code/schema | No implementation; mentions occur only in promotion exclusion/migration records |
| External URLs | Current AGPL text, official licensing/dependency references, and npm lockfile registry/funding URLs |
| Prompt templates | Three short code-analysis prompts; no system policy, personal data, credentials, private examples, or proprietary fixtures |

Generic `instance_id` and `author_instance_id` schema/API fields are not live
identifiers. They are host-neutral optional provenance fields and are approved for
publication subject to the provenance-adapter contract.

## Current package-surface finding

The current dry-run package has a **release-clean file surface** but still carries
the pre-promotion identity and license:

- identity: `@voxxo/atlas@0.1.0`;
- 140 entries after adding the public architecture contract and standalone `0017`;
- exact size is re-measured by the package smoke after every public-document change;
- no bundled npm dependencies;
- explicit roots: `dist`, 18 direct migrations, README, ARCHITECTURE, LICENSE,
  `THIRD_PARTY_NOTICES.md`, and npm-required `package.json`.

The exact manifest contains no raw source, tests, source maps, AGENTS, promotion
records, compiler cache, database/runtime artifact, legacy provider, unregistered
flush tool, or nested migration. The historical personal-name migration remains
because existing `0.1.0` databases require it; standalone `0017` and the current
API rename it without rewriting history.

The final package should contain only the built public API/CLI/server output,
required migrations and prompt templates, public README/license/security/upgrade
documentation, and third-party notices. Tests, AGENTS, promotion working records,
legacy providers, duplicate migrations, source-only internal comments, local
automation state, and unneeded raw source are excluded unless deliberately listed
and reviewed.

## Approved public references

These findings are intentional and may remain:

- `Copyright (c) 2026 Jonah`, author `Jonah`, and the `dogtorjonah` GitHub
  identity in public authorship/repository metadata.
- Explicit historical-license statements in `RELICENSE_AUDIT.md` and
  `MIT_TRANSITION_PLAN.md`.
- Therapy Atlas names in exclusion and negative migration/test documentation that
  proves the private domain is absent.
- Production `relay/src/atlas` paths in promotion provenance records.
- Public upstream GitHub, SQLite, Open Source Initiative, GNU, GitHub Docs, and npm
  registry/funding URLs.
- Generic provenance field names such as `instance_id`, `author_instance_id`,
  engine, model, and author name when no live values are shipped.
- `.voxxo-swarm` and `.voxxo-swarm-worktrees` in filesystem ignore lists only, if
  retained solely to avoid indexing host metadata and not used as runtime roots.
- Historical `0012_jonah_memory.sql` as an immutable upgrade input only. Current
  APIs and migration-head schema must use operator memory after public `0017`.
- Historical AGPL text in the historical release, not in the `v1.0.0` root
  license or package.

## Release blockers and remediation

| Finding | Status | Required remediation or closure evidence |
| --- | --- | --- |
| Root AGPL license and AGPL root metadata | Open — replace | MIT implementation batch and metadata consistency gate |
| Historical operator-memory storage uses a personal-name table | Closed | Standalone `0017_operator_memory.sql` performs a data-preserving rename; current code writes only `atlas_operator_memory`; focused fresh/upgrade tests preserve row IDs, duplicate dedupe keys, and changelog relationships; the exact 18-migration package smoke exposes only neutral schema objects at head |
| Hard-coded developer home fallback in `src/tools/bridge.ts` | Closed | Replaced with `os.homedir()`; focused typecheck and seven-test Node suite pass |
| Internal rail, implementation-step, and numbered-rollout breadcrumbs in public source/comments/log text | Closed | Rewritten as stable product rationale; exact-token scrub scanner returns no matches |
| Private host implementation paths in current public source comments | Closed | Replaced with public symbols and schema descriptions; promotion provenance records retain explicit origins |
| Dormant `_legacy` providers/pipelines and unregistered flush surface | Closed | Atlas/index evidence was incomplete, so exact imports, exports, server registration, and entrypoint scans proved zero incoming reachability; deletion followed; build and seven tests pass; the 286-entry package manifest contains none of the removed paths, provider names, endpoints, or API-key markers |
| No package `files` allowlist; tests, AGENTS, work records, source, and duplicate migration are packed | Closed | The explicit manifest allowlist produces 140 reviewed entries, including the public architecture contract and standalone `0017`; no test, source map, raw source, work record, cache, database, or local artifact is present |
| `migrations/migrations/0001_init.sql` duplicate | Closed | Non-recursive loader and exact reference scans proved no consumer; source deleted; clean tarball install applied all 18 direct migrations to a fresh database |
| Current package identity/version/license do not match the planned public `v1.0.0` MIT release | Open — replace | Freeze product/package identity, update manifest/lockfile, then verify registry previews |
| Current source scan does not cover generated `dist` or source maps | Closed for current tree; repeat at final gate | Clean release build emits no source maps; generated and installed trees pass the denylist; final exact-version artifact scan remains mandatory |
| Monorepo-scoped Forge dependency security gate cannot discover the standalone workspace | Open — replace evidence path | Add standalone SBOM/security runner or a generic Forge workspace root before final gate |

None of these blockers is approved for the final package. The task rail contains
or receives explicit implementation rows, and the final privacy gate stays before
publication.

## Manual prompt and fixture review

The three prompt templates ask only for concise file blurbs, structured code
metadata, and cross-file symbol usage. They contain placeholders for file/symbol
names and no hidden system instructions, provider keys, operator details, example
repositories, or private source fragments. They are approved as public product
source.

The current repository has no dedicated fixture directory and no tracked binary,
image, transcript, dataset, or model artifact. Future fixtures must use synthetic
repository names, synthetic IDs, non-routable example domains, and clearly fake
credentials. Production database rows or transcripts may never be anonymized and
reused as fixtures without a separate privacy review; build synthetic fixtures
instead.

## Final automated gate

The pre-publish gate must fail on:

- known secret prefixes or high-entropy credential assignments;
- private keys/certificates, `.env`, databases, WAL/SHM, logs, transcripts, JSONL,
  backups, runtime `data/`, or caches;
- absolute operator home paths, private IPs, Tailscale/internal hostnames, live
  instance/rail IDs, or private URLs;
- Therapy Atlas implementation/schema names outside explicit negative docs/tests;
- personal-name operator-memory APIs or migration-head schema;
- internal rail/wave/step breadcrumbs in production source;
- unexpected package files, native binaries, WASM, source maps with absolute paths,
  or bundled dependency code without notices;
- AGPL project metadata outside explicit historical-transition records;
- a tarball manifest, license, version, name, digest, or SBOM different from the
  release candidate.

The allowlist is path- and context-specific. A global string allowlist for
`Jonah`, `AGPL`, `therapy`, `instance_id`, or `relay/src` is forbidden because it
would hide a real leak in source or generated output.

## Initial preflight verdict

No credential, private runtime data, private hostname, proprietary fixture, live
instance identifier, or private binary asset was found.

The repository is **not yet publication-ready** because compatibility names and old
release metadata remain. The public-source path, process-breadcrumb,
dormant-provider, duplicate-migration, and package-surface findings are closed.
The remaining open rows above are explicit release blockers, not secret findings;
rerun this preflight on the exact artifact before `v1.0.0` publication.
