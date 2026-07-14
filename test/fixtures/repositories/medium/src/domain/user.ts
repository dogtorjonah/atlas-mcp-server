export interface User {
  id: string;
  name: string;
}

export function normalizeUserName(name: string): string {
  return name.trim().toLowerCase();
}
