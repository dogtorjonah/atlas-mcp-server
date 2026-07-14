import { createUserHandler } from './handler.js';

export function route(path: string, name: string): string {
  return path === '/users' ? createUserHandler(name).value.name : 'not-found';
}
