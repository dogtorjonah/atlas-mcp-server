# Atlas MIT Relicensing Audit

This is a technical provenance and release audit, not legal advice. Its purpose is
to retain the evidence used to move the standalone repository from AGPL-3.0 to
MIT and to make any unresolved ownership risk release-blocking rather than
implicit.

## Decision

The repository may proceed to an MIT release on the current evidence:

- The operator explicitly instructed this promotion wave to change the standalone
  license to MIT.
- The full reachable standalone Git history records only `Jonah` and
  `dogtorjonah` as authors.
- The full reachable production history for `relay/src/atlas` records the same two
  author aliases and reaches the Voxxo initial commit.
- No third-party copyright or source-license notice was found in active
  standalone `src/` or `migrations/` source.
- The only active source-origin note says deterministic commit-candidate
  heuristics were ported from the internal `atlas-densify` Forge server, an
  operator-controlled Voxxo artifact. That origin remains documented.

The conclusion is conditional on the operator's instruction representing
authority to relicense the work and on the dependency/license audit remaining
clean. Git authorship is strong provenance evidence but is not, by itself, proof
against an undisclosed employer assignment, contract, copied snippet, or other
third-party right.

## Git evidence

The audit used the safe Git history interface with all refs enabled.

| Scope | Earliest observed commit | Current observed commit | Observed author aliases |
| --- | --- | --- | --- |
| standalone repository | `bc64d67` — initial standalone commit | `815a07f` | `Jonah`, `dogtorjonah` |
| production `relay/src/atlas` | `259b2a13` — Voxxo initial commit | `3f134e20` | `Jonah`, `dogtorjonah` |

Both histories reached their initial commits within the requested full-history
result, not merely a recent time window. The two aliases use the operator's normal
Git identity variants. No separate human or organization contributor identity was
observed in either scoped history.

Evidence is retained in the relay's safe-Git tool-result records for this wave;
the public repository should retain this audit and the relevant commit hashes,
not relay spool paths or personal email addresses.

## Source-origin scan

The active source and migration scan covered copyright notices, SPDX markers,
license declarations, and common derivation wording.

Findings:

1. `src/tools/deriveCommitCandidates.ts` identifies its heuristics as ported from
   internal Forge server `atlas-densify` with provenance label
   `scaffold-deterministic-v1`.
2. No active source file declares a third-party copyright holder or a source
   license different from the repository license.
3. `_legacy/providers/*` contains external API endpoint URLs, not copyright
   notices. Those dormant providers are scheduled for removal and are not part of
   the promoted public architecture.
4. The existing root `LICENSE` is the repository's AGPL-3.0 license text. It is
   replaced only after this ownership audit and the third-party dependency audit
   pass.
5. No vendored source directory is part of the intended package. `node_modules`,
   build output, caches, databases, and runtime data are release-excluded.

## Imported production code

Promoted code must come from the operator-controlled Voxxo repository and retain
traceability to its production commit. For each copied or adapted production
file, the promotion record must capture:

- production path and commit;
- standalone path and commit;
- whether the copy is exact, adapted, generalized, or rewritten;
- excluded private or relay-specific regions;
- tests proving the public semantics;
- any source-origin note already present in production.

Code copied from an untracked runtime artifact, transcript, external answer, blog,
package source, or other repository is blocked until its author and license are
recorded. A similar algorithm is not sufficient provenance.

## Operator authority record

The operator's July 14, 2026 instruction was: change the standalone Atlas license
to MIT, matching Context Warp Drive. This audit treats that explicit instruction,
together with the single-operator Git history, as the release authority signal.

Before publishing the MIT tag, the release checklist reconfirms:

- no employer, client, collaborator, or contractor owns part of the promoted
  source;
- no contributor agreement or provider term prevents the intended grant;
- no externally copied snippet remains without compatible provenance;
- all new promotion commits are made under the same operator authority;
- the copyright line uses the operator's chosen public name and year.

If any answer changes, MIT publication pauses until the affected code is excluded,
rewritten from a clean specification, or permission is documented.

## Third-party distinction

Relicensing the repository's own source does not relicense its dependencies. Each
runtime and development dependency retains its own license and notice obligations.
The separate dependency-license audit must classify direct and transitive
packages, optional native components, bundled output, examples, and copied assets.

An incompatible or unknown dependency blocks the MIT release even when the
repository source itself is controlled by the operator.

## License mechanics

The release uses the unmodified standard MIT text and a root copyright notice
chosen by the operator. Package metadata, README badges, documentation, generated
notices, repository metadata, packed artifacts, and release notes must agree on
MIT.

Primary reference links:

- MIT license text: <https://opensource.org/license/mit>
- GNU GPL FAQ on a copyright holder releasing a program under multiple licenses:
  <https://www.gnu.org/licenses/gpl-faq.html#ReleaseUnderGPLAndNF>
- GitHub guidance on repository licensing:
  <https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository>

Changing the root license does not erase prior AGPL releases. Existing published
versions remain available under the grants that accompanied them; the new MIT
grant applies to the source and release identified by the new commit/tag.

## Blocking conditions

Stop relicensing if any of these appears:

- a contributor identity not accounted for above;
- a third-party copyright or incompatible source-license notice;
- code imported from an external source without documented permission;
- a contributor, employment, client, or provider agreement inconsistent with MIT;
- a dependency or bundled asset with unknown or incompatible distribution terms;
- a generated artifact whose source and license cannot be reproduced;
- a private-domain or runtime artifact copied into the public package.

The affected material must be removed, replaced with a clean implementation from
a behavior-only specification, or covered by written permission before release.

## Audit acceptance

- [x] Full standalone history reaches the initial commit and contains only the two
      operator aliases.
- [x] Full production Atlas-path history reaches the initial commit and contains
      only the same operator aliases.
- [x] Active source/migration notice scan found no third-party copyright notice.
- [x] Internal Forge-derived heuristic provenance is identified.
- [x] Operator explicitly directed the MIT transition.
- [x] External and private source origins are release-blocking by policy.
- [ ] Third-party dependency/license audit is complete.
- [ ] Exact packed artifact contains the MIT license and no excluded material.
- [ ] Final release commit/tag and public metadata agree on MIT.
