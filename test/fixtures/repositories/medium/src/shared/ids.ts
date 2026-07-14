export function createUserId(sequence: number): string {
  return `user-${sequence.toString().padStart(4, '0')}`;
}

export const isUserId = (value: string): boolean => /^user-\d{4}$/.test(value);
