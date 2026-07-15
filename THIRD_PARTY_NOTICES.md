# Third-Party License Audit and Notices

This record covers the dependency graph locked for the standalone Atlas MIT
promotion. It is generated from `package-lock.json` version 3 plus installed
package metadata and license files. Re-run it whenever the lockfile, build mode,
or copied-source inventory changes.

## Distribution model

The current build uses `tsc`; it does not bundle dependency source or binaries
into Atlas `dist/`. The npm package declares runtime dependencies, and npm installs
those packages as separate distributions with their own metadata and notices.

This distinction is a release invariant. If Atlas later bundles JavaScript,
native binaries, grammar sources, Unicode data, or WASM, the release must include
the complete applicable upstream license and notice texts in the bundled artifact
and regenerate this audit before publishing.

## Lockfile census

The current lock contains 177 installed package entries and no unknown
license identifiers.

| License expression | Packages | MIT-release disposition |
| --- | ---: | --- |
| `MIT` | 152 | Compatible; preserve notices when redistributed |
| `ISC` | 10 | Compatible; preserve notices when redistributed |
| `Apache-2.0` | 3 | Compatible; preserve license and any NOTICE content when redistributed |
| `BSD-3-Clause` | 3 | Compatible; preserve notice and conditions |
| `BSD-2-Clause` | 1 | Compatible; preserve notice and conditions |
| `MIT OR Apache` | 6 | Compatible; Atlas selects MIT for `sqlite-vec` artifacts |
| `BSD-2-Clause OR MIT OR Apache-2.0` | 1 | Compatible; preserve selected-license notice if redistributed |
| `MIT OR WTFPL` | 1 | Compatible; preserve selected-license notice if redistributed |

No GPL, AGPL, LGPL, SSPL, BUSL, Commons Clause, noncommercial, source-available,
proprietary, or unknown package license appears in the locked dependency graph.

## Direct runtime dependencies

| Dependency | Locked version | License evidence | Notes |
| --- | ---: | --- | --- |
| `@modelcontextprotocol/sdk` | `1.29.0` | package metadata and installed `LICENSE`: MIT | The upstream main/v2 line now describes new contributions as Apache-2.0 while existing code remains MIT; any upgrade requires a fresh version-specific audit. |
| `better-sqlite3` | `11.10.0` | package metadata and installed `LICENSE`: MIT | Native addon; includes SQLite, whose official project places deliverable core code in the public domain. |
| `sqlite-vec` | `0.1.9` | package metadata: `MIT OR Apache`; upstream has both license files | Atlas selects MIT. The npm wrapper and platform packages omit license files, so do not bundle them without copying the upstream MIT notice. |
| `tree-sitter` | `0.25.0` | package metadata and installed `LICENSE`: MIT | Native parser runtime; package also carries a nested Unicode/ICU notice that must travel with any bundle of that data. |
| `tree-sitter-go` | `0.23.4` | package metadata and installed `LICENSE`: MIT | External grammar package, not bundled by Atlas. |
| `tree-sitter-java` | `0.23.5` | package metadata and installed `LICENSE`: MIT | External grammar package, not bundled by Atlas. |
| `tree-sitter-javascript` | `0.25.0` | package metadata and installed `LICENSE`: MIT | External grammar package, not bundled by Atlas. |
| `tree-sitter-python` | `0.25.0` | package metadata and installed `LICENSE`: MIT | External grammar package, not bundled by Atlas. |
| `tree-sitter-rust` | `0.23.3` | package metadata and installed `LICENSE`: MIT | External grammar package, not bundled by Atlas. |
| `tree-sitter-typescript` | `0.23.2` | package metadata and installed `LICENSE`: MIT | External TypeScript/TSX grammars, not bundled by Atlas. |
| `zod` | `3.25.76` | package metadata and installed `LICENSE`: MIT | Runtime schema validation. |

## Development dependencies

| Dependency | Locked version | License |
| --- | ---: | --- |
| `@types/better-sqlite3` | `7.6.13` | MIT |
| `@types/node` | `20.19.43` | MIT |
| `tsx` | `4.23.1` | MIT |
| `typescript` | `5.9.3` | Apache-2.0 |

Development dependencies are not included in the npm package, but their licenses
remain part of the reproducible build record.

## Native and optional components

`sqlite-vec` declares platform packages for Darwin x64/arm64, Linux x64/arm64,
and Windows x64. The current install selected `sqlite-vec-linux-x64`. All six lock
entries declare `MIT OR Apache`; the upstream repository publishes both
`LICENSE-MIT` and `LICENSE-APACHE`.

The Atlas runtime treats vector loading as optional and can operate lexically
without the extension. Package metadata currently declares `sqlite-vec` as a
normal dependency, however, so “optional at runtime” must not be documented as
“not installed.” A later packaging step may move it to `optionalDependencies`
only after clean-install, no-native-extension, and vector-enabled fixtures pass.

`better-sqlite3` is a required native dependency. Its MIT license is compatible;
the SQLite core it embeds is public domain according to SQLite's official
copyright statement. Atlas must not imply that unrelated SQLite extensions such
as SEE are included or public domain.

## Nested notices

The installed Tree-sitter package includes Unicode/ICU data and a dedicated
notice under `vendor/tree-sitter/lib/src/unicode/LICENSE`. That file includes
Unicode, IBM/ICU, Google/BSD, and other data-source terms.

Because Atlas does not bundle Tree-sitter, that notice remains in the separate
Tree-sitter npm distribution. Any future single-file, binary, container, desktop,
or WASM distribution that embeds Tree-sitter must reproduce the complete nested
notice rather than listing Tree-sitter as MIT only.

## sqlite-vec attribution

Atlas selects the MIT option for `sqlite-vec` `0.1.9` and its platform artifact.

- Copyright: Alex Garcia, 2024.
- License: MIT.
- Upstream license text:
  <https://github.com/asg017/sqlite-vec/blob/main/LICENSE-MIT>
- Upstream repository: <https://github.com/asg017/sqlite-vec>

The upstream npm packages checked in this audit contain license identifiers but
no license file. Atlas does not currently bundle those packages. If it ever does,
the complete upstream MIT notice must be copied into the distributed notices.

## Copied, generated, and vendored material

- Active standalone source contains one internal-origin note:
  `src/tools/deriveCommitCandidates.ts` derives heuristics from the
  operator-controlled `atlas-densify` Forge server. This is project provenance,
  not a third-party dependency.
- No active source or migration declares a third-party copyright holder or
  incompatible source license.
- Dormant `_legacy/providers/*` code is excluded and scheduled for removal; it is
  not used to justify the promoted implementation.
- Prompt templates and SQL migrations are project source. They require the same
  ownership/provenance checks as TypeScript and are not treated as unowned data.
- No third-party native binary, WASM module, generated grammar, model weight,
  dataset, font, image, or other asset is intentionally tracked for inclusion in
  the public package.
- `node_modules`, `dist`, caches, SQLite databases, and runtime data are not source
  and may not be copied into a release tarball except freshly generated `dist`
  output verified from the release commit.

## Primary upstream evidence

- SQLite public-domain statement: <https://www.sqlite.org/copyright.html>
- better-sqlite3 repository and MIT license:
  <https://github.com/WiseLibs/better-sqlite3>
- sqlite-vec dual-license repository:
  <https://github.com/asg017/sqlite-vec>
- Tree-sitter repository and MIT license:
  <https://github.com/tree-sitter/tree-sitter>
- MCP TypeScript SDK repository and version-line license warning:
  <https://github.com/modelcontextprotocol/typescript-sdk>

Installed package metadata and license files for the exact locked versions remain
the release authority when a repository's default branch has moved to a later
version or license arrangement.

## Release rules

1. Do not publish if any lockfile entry has an unknown or unapproved license.
2. Do not infer a package license from its repository alone; check the exact
   locked artifact.
3. Do not bundle a dependency until its complete notice tree is included.
4. Do not label optional behavior as an optional installation while the package is
   a normal dependency.
5. Generate and inspect the final packed-artifact dependency/SBOM report from the
   standalone repository. The current monorepo-scoped Forge security gate could
   not discover this external workspace and produced no standalone SBOM.
6. Re-audit the MCP SDK on upgrade because its main/v2 licensing differs from the
   locked v1 package.
7. Re-audit native packages on version or platform-matrix changes.
8. Preserve this file in source and the packed artifact.

## Audit verdict

The current locked dependency graph is compatible with an MIT-licensed Atlas
source release. There are no unknown or reciprocal licenses in the lockfile.

This verdict assumes dependencies remain external, the exact locked versions are
used, the `sqlite-vec` MIT selection and Tree-sitter nested notice are preserved,
and the final clean-room packed artifact confirms that no dependency code or
binary was accidentally bundled.
