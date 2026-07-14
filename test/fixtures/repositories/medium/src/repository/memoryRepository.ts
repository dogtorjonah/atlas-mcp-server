const events: string[] = [];
const maxEvents = 4;

export function appendAudit(message: string): void {
  events.push(message);
  if (events.length > maxEvents) events.shift();
}

export function readAudit(): string[] {
  return [...events];
}
