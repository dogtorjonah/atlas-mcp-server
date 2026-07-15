# Contributing

Thanks for helping improve Atlas. Keep changes deterministic, local-first, and
bounded. A public operation must not silently add network access, global state,
unbounded work, or content-derived token estimates.

## Set up

```bash
git clone https://github.com/dogtorjonah/atlas-mcp-server.git
cd atlas-mcp-server
npm ci
npm run check
npm test
```

Use Node 20 or newer. Native modules are built for the active Node ABI, so switch
Node versions before `npm ci`, not afterward.

## Change guidelines

- Add deterministic tests for behavior changes. Inject clocks and request ID
  factories when output includes time or identity.
- Keep programmatic camelCase and serialized snake_case boundaries explicit.
- Preserve source authority: current repository content outranks stale indexed
  metadata; historical snapshots remain labeled historical.
- Keep database and filesystem I/O behind the worker-backed persistence and host
  boundaries for async application paths.
- Treat optional capabilities as optional. A missing embedding provider must not
  change lexical fallback order or make core imports fail.
- Update migrations additively. Never edit an already released migration's
  executable SQL.
- Update `PUBLIC_API.md`, examples, and upgrade notes when a public contract
  changes.
- Do not commit `.atlas/`, generated release-regression artifacts, credentials,
  absolute developer paths, or private repository contents.

## Verify a release-shaped change

```bash
npm run check
npm test
npm run test:adapter
npm run sbom:check
npm run test:package
npm run test:release
```

`test:release` produces one candidate tarball and runs all release checks against
that exact artifact. Do not substitute a source-tree-only result for it.

## Pull requests

Describe the problem, the chosen boundary, user-visible changes, tests, and any
migration or privacy impact. Small, reviewable changes are preferred. By
contributing, you agree that your contribution is licensed under the repository's
MIT License.
