import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(projectRoot, 'package.json');
const lockPath = path.join(projectRoot, 'package-lock.json');
const outputPath = path.join(projectRoot, 'sbom.cdx.json');

const [manifest, lock] = await Promise.all([
  readFile(manifestPath, 'utf8').then(JSON.parse),
  readFile(lockPath, 'utf8').then(JSON.parse),
]);

assert.equal(lock.lockfileVersion, 3, 'SBOM generation requires package-lock v3');
assert.equal(lock.packages?.['']?.name, manifest.name, 'package-lock root name differs from package.json');
assert.equal(lock.packages?.['']?.version, manifest.version, 'package-lock root version differs from package.json');

function packageName(location, record) {
  if (typeof record.name === 'string' && record.name) return record.name;
  const marker = 'node_modules/';
  const index = location.lastIndexOf(marker);
  if (index < 0) return null;
  const tail = location.slice(index + marker.length);
  if (!tail) return null;
  const parts = tail.split('/');
  return parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function purl(name, version) {
  if (name.startsWith('@')) {
    const [scope, base] = name.split('/');
    return `pkg:npm/${encodeURIComponent(scope)}/${encodeURIComponent(base)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function license(name) {
  return typeof name === 'string' && name.trim()
    ? [{ license: { name: name.trim() } }]
    : undefined;
}

function integrityHashes(integrity) {
  if (typeof integrity !== 'string') return undefined;
  const [algorithm, encoded] = integrity.split('-', 2);
  const alg = algorithm === 'sha512' ? 'SHA-512'
    : algorithm === 'sha384' ? 'SHA-384'
      : algorithm === 'sha256' ? 'SHA-256'
        : algorithm === 'sha1' ? 'SHA-1'
          : null;
  if (!alg || !encoded) return undefined;
  return [{ alg, content: Buffer.from(encoded, 'base64').toString('hex').toUpperCase() }];
}

const components = Object.entries(lock.packages)
  .filter(([location, record]) => location !== '' && !record.dev && !record.link && record.version)
  .map(([location, record]) => {
    const name = packageName(location, record);
    if (!name) throw new Error(`Cannot derive package name for lock location ${location}`);
    const componentPurl = purl(name, record.version);
    const slash = name.startsWith('@') ? name.indexOf('/') : -1;
    return {
      type: 'library',
      'bom-ref': componentPurl,
      ...(slash > 0 ? { group: name.slice(0, slash) } : {}),
      name: slash > 0 ? name.slice(slash + 1) : name,
      version: record.version,
      ...(license(record.license) ? { licenses: license(record.license) } : {}),
      ...(integrityHashes(record.integrity) ? { hashes: integrityHashes(record.integrity) } : {}),
      purl: componentPurl,
      ...(record.optional ? {
        properties: [{ name: 'atlas:npm:optional', value: 'true' }],
      } : {}),
    };
  })
  .sort((left, right) => left.purl.localeCompare(right.purl));

const rootPurl = purl(manifest.name, manifest.version);
const document = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    tools: {
      components: [{
        type: 'application',
        name: 'atlas-sbom-generator',
        version: '1',
      }],
    },
    component: {
      type: 'library',
      'bom-ref': rootPurl,
      group: '@voxxo',
      name: 'atlas',
      version: manifest.version,
      licenses: [{ license: { name: manifest.license } }],
      purl: rootPurl,
      externalReferences: [
        { type: 'vcs', url: manifest.repository.url.replace(/^git\+/u, '') },
        { type: 'website', url: manifest.homepage },
      ],
    },
  },
  components,
  dependencies: [{
    ref: rootPurl,
    dependsOn: Object.keys(manifest.dependencies ?? {})
      .map((name) => {
        const record = lock.packages[`node_modules/${name}`];
        if (!record?.version) throw new Error(`Direct dependency ${name} is missing from package-lock.json.`);
        return purl(name, record.version);
      })
      .sort(),
  }],
};

const rendered = `${JSON.stringify(document, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const existing = await readFile(outputPath, 'utf8').catch(() => '');
  if (existing !== rendered) {
    process.stderr.write('sbom.cdx.json is stale; run npm run sbom.\n');
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, rendered, 'utf8');
  process.stdout.write(`Wrote ${path.relative(projectRoot, outputPath)} with ${components.length} runtime components.\n`);
}
