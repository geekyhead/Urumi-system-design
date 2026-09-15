import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';

export type Role = 'admin' | 'user';

export interface AuthUser {
  name: string;
  role: Role;
  maxStores: number;
}

interface UserRecord extends AuthUser {
  tokenHash: Buffer;
}

interface UserFileEntry {
  name?: unknown;
  role?: unknown;
  maxStores?: unknown;
  token?: unknown;
}

const USER_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Bearer-token authentication against a users file rendered by the platform
 * Helm chart from a generated Secret (tokens never live in source or values).
 * Each user has a role and a personal store quota.
 */
export class Authenticator {
  private readonly users: UserRecord[] = [];

  constructor(
    readonly enabled: boolean,
    usersFile: string,
    private readonly anonymousMaxStores: number,
  ) {
    if (!enabled) return;
    const parsed = JSON.parse(fs.readFileSync(usersFile, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`${usersFile} must contain a JSON array of users`);
    for (const entry of parsed as UserFileEntry[]) {
      const name = String(entry.name ?? '');
      const token = String(entry.token ?? '');
      const role: Role = entry.role === 'admin' ? 'admin' : 'user';
      const maxStores = Number(entry.maxStores ?? 3);
      if (!USER_NAME.test(name)) throw new Error(`invalid user name "${name}" in ${usersFile}`);
      if (token.length < 20) throw new Error(`token for user "${name}" is too short`);
      if (!Number.isInteger(maxStores) || maxStores < 0) throw new Error(`invalid maxStores for user "${name}"`);
      this.users.push({ name, role, maxStores, tokenHash: sha256(token) });
    }
    if (this.users.length === 0) throw new Error(`${usersFile} defines no users`);
  }

  /** Returns the user for an Authorization header, or null when it is missing or wrong. */
  authenticate(header: string | undefined): AuthUser | null {
    if (!this.enabled) return { name: 'local', role: 'admin', maxStores: this.anonymousMaxStores };
    const match = header?.match(/^Bearer\s+(\S+)$/i);
    if (!match?.[1]) return null;
    const candidate = sha256(match[1]);
    let found: UserRecord | null = null;
    // Compare against every user so timing does not reveal which one matched.
    for (const user of this.users) {
      if (timingSafeEqual(user.tokenHash, candidate)) found = user;
    }
    return found ? { name: found.name, role: found.role, maxStores: found.maxStores } : null;
  }

  get userCount(): number {
    return this.users.length;
  }
}
