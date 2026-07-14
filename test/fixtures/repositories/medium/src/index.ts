import { route } from './api/router.js';
import { one } from './cycles/one.js';
import { recordAudit } from './services/auditService.js';

export type { Account, User } from './reexports/index.js';

export function handle(path: string, name: string): string {
  const response = route(path, name);
  recordAudit(`route:${path}`);
  return `${response}:${one.name}`;
}
