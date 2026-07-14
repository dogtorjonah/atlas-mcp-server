import type { User } from './user.js';

export interface Account {
  id: string;
  owner: User;
}

export const describeAccount = (account: Account): string => `${account.id}:${account.owner.name}`;
