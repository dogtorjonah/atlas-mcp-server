import { createUser } from '../services/userService.js';
import type { Result } from '../shared/result.js';
import type { User } from '../domain/user.js';

export function createUserHandler(name: string): Result<User> {
  return {
    ok: true,
    value: createUser(name),
  };
}
