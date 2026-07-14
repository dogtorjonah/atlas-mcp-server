import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(testDir, '../../migrations/0011_hazards_with_ranges.sql');

function executableSql(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
}

test('structured-hazard migration retains its released SQL effect', () => {
  const source = readFileSync(migrationPath, 'utf8');

  assert.equal(
    executableSql(source),
    "ALTER TABLE atlas_files ADD COLUMN hazards_with_ranges TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hazards_with_ranges));",
  );
});
