import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAtlasCommitPayload } from '../tools/commitPayload.js';

test('normalizes aliases into canonical atlas_commit fields only', () => {
  const normalized = normalizeAtlasCommitPayload({
    filePath: ' src/file.ts ',
    description: ' tighten atlas contract ',
    keyTypes: 'One,\nTwo',
    hazardsAdded: ['alpha', ' beta '],
    breakingChanges: 'yes',
  });

  assert.deepEqual(normalized, {
    file_path: 'src/file.ts',
    changelog_entry: 'tighten atlas contract',
    summary: 'tighten atlas contract',
    key_types: ['One', 'Two'],
    hazards_added: ['alpha', 'beta'],
    breaking_changes: true,
  });
});

test('normalizes public_api string lists into canonical object entries', () => {
  const normalized = normalizeAtlasCommitPayload({
    file_path: 'src/file.ts',
    changelog_entry: 'document api',
    publicApi: 'foo\nbar',
  });

  assert.deepEqual(normalized.public_api, [
    { name: 'foo', type: 'value' },
    { name: 'bar', type: 'value' },
  ]);
});

test('normalizes source_highlights shorthand records', () => {
  const normalized = normalizeAtlasCommitPayload({
    file_path: 'src/file.ts',
    changelog_entry: 'add snippets',
    sourceHighlights: [
      {
        text: 'const value = 1;',
        start_line: '10',
        endLine: 12,
        title: 'example',
      },
    ],
  });

  assert.deepEqual(normalized.source_highlights, [
    {
      id: 1,
      content: 'const value = 1;',
      startLine: 10,
      endLine: 12,
      label: 'example',
    },
  ]);
});
