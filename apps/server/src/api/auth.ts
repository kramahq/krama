import { createHash, timingSafeEqual } from 'node:crypto';
import type { Me } from '@kramahq/contract';

/** The caller behind a request. Local mode has one principal; OIDC (later) maps real users onto the same shape. */
export interface Principal {
  id: string;
  name: string;
  roles: string[];
  permissions: string[];
}

export const LOCAL_PRINCIPAL: Principal = {
  id: 'u_local',
  name: 'Local user',
  roles: ['admin'],
  permissions: ['*'],
};

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Static bearer-token authenticator (D11). Compares digests in constant time. */
export class TokenAuth {
  private readonly expected: Buffer;
  constructor(
    token: string,
    private readonly principal: Principal = LOCAL_PRINCIPAL,
  ) {
    this.expected = digest(token);
  }

  /** The principal for an `Authorization` header value, or `undefined` when it is missing or wrong. */
  authenticate(header: string | undefined): Principal | undefined {
    if (!header) return undefined;
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!m) return undefined;
    return timingSafeEqual(digest(m[1]!), this.expected) ? this.principal : undefined;
  }
}

export const toMe = (p: Principal, preferences: Record<string, unknown>): Me => ({
  id: p.id,
  name: p.name,
  roles: p.roles,
  permissions: p.permissions,
  preferences,
});

/** The contract's roles, lowest first; each one includes everything below it (section 6.8). */
export const ROLES = ['viewer', 'requester', 'approver', 'author', 'operator', 'admin'] as const;
const rank = (role: string): number => {
  const r = role === 'owner' ? 'admin' : role;
  return (ROLES as readonly string[]).indexOf(r);
};

/**
 * Whether a principal may call a route with the contract's `perm` text: `public` and `any` need no role, otherwise
 * any alternative (`requester(own)/operator`) is enough, and a higher role includes the lower ones. Ownership
 * (`(own)`) is a per-resource check the handler makes; here it counts as the bare role.
 */
export function satisfies(p: Principal, perm: string): boolean {
  if (perm === 'public' || perm === 'any') return true;
  const need = perm
    .split('/')
    .map((a) => rank(a.replace(/\(.*\)/, '').trim()))
    .filter((r) => r >= 0);
  if (!need.length) return false; // an unknown requirement is never silently granted
  const has = Math.max(-1, ...p.roles.map(rank));
  return has >= Math.min(...need);
}
