# AGPL-to-MIT Transition Plan

This plan governs the license change for standalone Atlas. It is a new license
grant for a new release, not a revocation or rewrite of grants that accompanied
older releases.

## First MIT release

The first MIT release target is **`1.0.0`**, tagged **`v1.0.0`** only after every
promotion rail gate passes.

The jump from `0.1.0` is deliberate: the release changes the license, public
product identity, tool contracts, worker architecture, persistence migration
head, documentation, and compatibility guarantees. If the rail is incomplete,
do not publish an interim MIT prerelease under the stable tag. Pre-release testing
uses local packs or semver prerelease identifiers such as `1.0.0-rc.1` and must
carry the same MIT metadata as the candidate source.

## Copyright and license text

The root `LICENSE` uses the standard, unmodified MIT text with the same public
identity convention as Context Warp Drive:

```text
MIT License

Copyright (c) 2026 Jonah
```

The remainder is the standard MIT permission and warranty text from
<https://opensource.org/license/mit>.

This release is **MIT only**. Do not use `MIT OR AGPL-3.0-only`, dual-license
language, or a second root AGPL license file. Historical AGPL text remains
available in the source tree of the historical release/commit where it applied.

## Historical AGPL releases

- Standalone Atlas `0.1.0` and any earlier published source remain available under
  the `AGPL-3.0-only` grant that accompanied those versions.
- Those existing grants are not revoked, narrowed, or invalidated.
- The repository history and historical tag/commit remain immutable.
- The `v1.0.0` source and artifact are offered under MIT.
- A file that is identical in both histories may be used under the grant attached
  to the version from which the user obtains it; release notes should avoid
  pretending the earlier publication never occurred.

Before `v1.0.0`, verify that the published `0.1.0` commit/tag is identifiable. If
no immutable tag exists, record the published commit hash in release history; do
not move an existing tag or rewrite the old release.

## SPDX and machine-readable metadata

All current-release metadata uses the exact SPDX identifier `MIT`:

- root `package.json` `license`;
- root package-lock package `license` after lock regeneration;
- generated package manifest in the npm tarball;
- CycloneDX/SPDX SBOM declared license for the Atlas component;
- repository license detection and badges;
- MCP/npm registry metadata and release provenance;
- any container, binary, or package manifest produced from the release.

Per-file SPDX headers are not required for every project-authored source file in
this release. If the project adopts them, use exactly:

```text
SPDX-License-Identifier: MIT
```

Do not mechanically add headers to generated files, SQL copied from third parties,
dependency code, license texts, snapshots, or historical artifacts.

## Files and public metadata to update

At the implementation step, update and verify:

1. Root `LICENSE` — replace AGPL with the standard MIT text and 2026 Jonah line.
2. `package.json` — set `license` to `MIT`, set `version` to the selected candidate
   version only when the release manager opens that version, and align package
   identity/repository/homepage/bugs/author metadata.
3. `package-lock.json` — regenerate so root name, version, and license match.
4. README — MIT badge, licensing section, install names, package names, and
   historical-license link.
5. `RELICENSE_AUDIT.md` and `THIRD_PARTY_NOTICES.md` — retain in source and package.
6. `CHANGELOG.md` or release history — add the exact transition note below.
7. Contribution, security, support, architecture, and release documentation — no
   stale AGPL claims.
8. GitHub repository settings — license detection, description, topics, and
   release page.
9. npm/MCP registry records — published manifest declares MIT and points to this
   repository and tag.
10. SBOM/provenance attestations — Atlas component MIT; dependencies keep their own
    licenses.

Search the tracked source, generated `dist`, packed tarball, documentation, badges,
lockfile, SBOM, and registry preview for `AGPL`, `GPL`, `copyleft`, and stale
license URLs. The only allowed hits after transition are explicit historical
statements such as this document and `RELICENSE_AUDIT.md`.

## Required release-note wording

Use this substance in `CHANGELOG.md`, the GitHub release, and registry notes:

> Atlas 1.0.0 is the first release of the standalone project offered under the
> MIT License. Releases through 0.1.0 remain available under the AGPL-3.0-only
> license that accompanied them; those existing grants are unchanged. This
> release also establishes the standalone public-core boundary, excluding
> Voxxo-only orchestration and private-domain features.

Minor formatting changes are allowed, but all three facts must remain: first MIT
release, old grants unchanged, and private/Voxxo boundaries excluded.

## Source and artifact boundary

The license change applies only to project source and artifacts included in the
`v1.0.0` release. It does not relabel:

- third-party dependencies or nested notices;
- private runtime data, databases, transcripts, or operator-memory rows;
- production Voxxo code not included in the standalone release;
- historical release artifacts;
- external services, models, datasets, or APIs.

The exact npm tarball must contain the MIT root license and third-party notice
record, and must not contain the historical AGPL root license, private artifacts,
or dependency source/binaries accidentally copied from `node_modules`.

## Release sequence

1. Complete and retain copyright and dependency-license audits.
2. Freeze the release commit candidate and exact package identity.
3. Apply MIT text and metadata changes in one reviewable batch.
4. Regenerate the lockfile from the changed root manifest.
5. Build and pack from a clean checkout of the candidate commit.
6. Inspect the tarball file list, manifests, licenses, notices, SBOM, source maps,
   and secret/private-reference scan.
7. Install the exact tarball in clean Linux, macOS, and Windows environments and
   exercise lexical plus supported native/vector paths.
8. Verify GitHub and registry previews report MIT before publishing.
9. Create immutable signed/annotated `v1.0.0` tag from the verified commit.
10. Publish once, verify public metadata and install digest, then preserve all
    provenance artifacts.

No tag or registry publish occurs from a dirty tree, a different build commit, or
an artifact rebuilt after verification.

## Acceptance checklist

- [x] Root license text is standard MIT with `Copyright (c) 2026 Jonah`.
- [ ] Root manifest, lockfile, SBOM, and tarball manifest say exactly `MIT`;
      public registry and repository previews remain a post-publish check.
- [x] Release notes state that prior AGPL grants remain valid.
- [x] No ambiguous dual-license expression applies to Atlas project source.
- [ ] Prior release tag/commit remains immutable and identifiable.
- [x] Historical AGPL wording appears only in explicit transition records.
- [x] Dependency licenses and nested notices remain distinct.
- [ ] Exact verified artifact is the artifact tagged and published.
- [ ] Public GitHub/npm/MCP metadata is re-read after publication and reports MIT.
