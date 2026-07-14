if (import.meta.url.endsWith('.ts')) {
  const { register } = await import('tsx/esm/api');
  const unregister = register();
  const sourceWorker = './sqliteWorker.ts';
  await import(sourceWorker);
  await unregister();
} else {
  await import('./sqliteWorker.js');
}
