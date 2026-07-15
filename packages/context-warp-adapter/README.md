# @voxxo/atlas-context-warp

Optional provenance bridge between `context-warp-drive` prepare receipts and
Atlas 1.x evidence records.

```bash
npm install @voxxo/atlas context-warp-drive @voxxo/atlas-context-warp
```

```ts
import { buildPrepareReceipt } from 'context-warp-drive/fold';
import { foldReceiptToAtlasEvidence } from '@voxxo/atlas-context-warp';

const receipt = buildPrepareReceipt(rawMessages, preparedOutcome, {
  sessionId: 'opaque-session-id',
  measuredInputTokens: providerUsage.inputTokens,
});

const evidence = foldReceiptToAtlasEvidence(receipt, {
  workspace: 'my-project',
  subjectKey: 'prepare:opaque-session-id',
  contextWarpVersion: '0.1.0',
  observedAt: new Date().toISOString(),
});

await atlas.service.commit({
  filePath: 'src/session.ts',
  changelogEntry: 'Recorded the verified fold preparation used for this change.',
  evidence: [evidence],
});
```

The adapter copies receipt digests, counters, strategy identity, invalidation
conditions, and host-supplied measured token telemetry. It never estimates token
counts. It does not copy raw messages or folded-view text. Opaque raw-history
store references are omitted unless `includeSourceRef: true` is explicitly set.

Atlas does not depend on Context Warp, and Context Warp does not depend on Atlas.
This adapter alone declares both public packages as peer dependencies. Removing
it leaves both cores installable and functional.
