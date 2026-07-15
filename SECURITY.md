# Security policy

## Reporting a vulnerability

Please do not open a public issue for an undisclosed vulnerability. Use GitHub's
private vulnerability reporting for `dogtorjonah/atlas-mcp-server`. Include the affected
version, operating system, reproduction steps, impact, and any proposed
mitigation. If private reporting is unavailable, open an issue that asks for a
private contact without including exploit details.

You should receive an acknowledgement within seven days. A fix timeline depends
on severity, reproducibility, and native dependency coordination. Published
advisories will credit reporters who want attribution.

## Supported versions

Security fixes target the latest 1.x release. Pre-1.0 versions are not supported
after 1.0.0 because their storage, transport, and license contracts differ.

## Trust boundary

Atlas is a local developer tool, not a multi-tenant authorization service.
Anyone who can invoke its process or MCP transport receives the authority of the
operating-system account running it, subject to Atlas path checks. Do not expose
the stdio process through an unauthenticated network bridge.

Atlas can read authorized repository files and write its configured data,
backup, and cache directories. It rejects repository-relative traversal and
canonical paths outside the source root, but it does not sandbox parser native
modules or untrusted package installation scripts.

Treat the following as sensitive:

- `.atlas/atlas.sqlite` and its backups;
- source snippets, snapshots, changelog entries, hazards, and highlights;
- explicit external provenance payloads and source references;
- logs produced by a host application around Atlas results.

The default package has no telemetry, hosted account, API key, or automatic
network provider. Optional embedding providers are supplied by the host and may
transmit text according to that provider's implementation. Enabling one is a
separate trust decision.

## Deployment guidance

- Run Atlas with the least-privileged operating-system account that can read the
  repository and write the selected data directory.
- Keep project-local `.atlas/` directories out of version control and shared
  artifacts unless the repository owner explicitly approves them.
- Use project-local data for strong repository separation or user-global data
  only when its shared registry is intended.
- Preserve file permissions on databases and backups.
- Pin and review the release tarball and checked-in `sbom.cdx.json` in controlled
  environments.
- Do not parse human CLI or MCP text; branch on structured error codes.
- Before upgrades, retain the verified backup created by the migration path.

## Dependency and release controls

Release CI installs a clean packed artifact on supported operating systems and
Node versions, verifies the package allowlist and migrations, exercises native
SQLite and parser modules, and checks the deterministic SBOM. Dependency license
obligations are recorded in `THIRD_PARTY_NOTICES.md`.
