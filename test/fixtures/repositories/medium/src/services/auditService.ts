import { appendAudit, readAudit } from '../repository/memoryRepository.js';

export function recordAudit(message: string): void {
  appendAudit(message);
}

export function listAudit(): string[] {
  return readAudit();
}
