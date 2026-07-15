import path from 'node:path';

import { openAtlasNodeHost } from '@voxxo/atlas/node';

const sourceRoot = path.resolve(process.argv[2] ?? process.cwd());
const host = await openAtlasNodeHost({ sourceRoot, dataMode: 'project' });

try {
  const indexed = await host.service.admin({ action: 'index', full: true });
  if (!indexed.ok) {
    throw new Error(`${indexed.error.code}: ${indexed.error.message}`);
  }

  const catalog = await host.service.query({ action: 'catalog', limit: 20 });
  if (!catalog.ok) {
    throw new Error(`${catalog.error.code}: ${catalog.error.message}`);
  }

  process.stdout.write(`${JSON.stringify({
    sourceRoot,
    index: indexed.data,
    catalog: catalog.data,
  }, null, 2)}\n`);
} finally {
  await host.close();
}
