import { normalizeUserName, type User } from '../domain/user.js';
import { findUserByName, insertUser } from '../repository/userRepository.js';

export function createUser(name: string): User {
  const normalized = normalizeUserName(name);
  const existing = findUserByName(normalized);
  if (existing) return existing;
  return insertUser(normalized);
}
