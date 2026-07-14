import type { User } from '../domain/user.js';
import { createUserId } from '../shared/ids.js';

const users: User[] = [];

export function findUserByName(name: string): User | undefined {
  return users.find((user) => user.name === name);
}

export function insertUser(name: string): User {
  const user = { id: createUserId(users.length + 1), name };
  users.push(user);
  return user;
}
