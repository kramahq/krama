import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DelegationMode } from '@kramahq/contract';

/** What a token allows: acting as the orchestrator of exactly one run, with the tool surface its delegation mode implies. */
export interface Scope {
  runId: string;
  role: 'orchestrator';
  delegation: DelegationMode;
  expiresAt: number;
}

const hash = (t: string) => createHash('sha256').update(t).digest();

/**
 * Scoped, expiring bearer tokens for MCP callers. Only hashes are kept in memory, so a heap dump or log
 * cannot yield a usable token. A token works for one run; it is revoked when the run ends.
 */
export class TokenRegistry {
  private readonly byHash = new Map<string, Scope>();
  constructor(
    private readonly now: () => number = Date.now,
    /** Told every token the moment it is made, so the platform can keep it out of anything it records. */
    private readonly onIssue?: (token: string) => void,
  ) {}

  issue(runId: string, ttlMs = 6 * 60 * 60_000, delegation: DelegationMode = 'krama'): string {
    const token = `krm_${randomBytes(32).toString('base64url')}`;
    this.byHash.set(hash(token).toString('hex'), {
      runId,
      role: 'orchestrator',
      delegation,
      expiresAt: this.now() + ttlMs,
    });
    this.onIssue?.(token);
    return token;
  }

  verify(token: string | undefined): Scope | undefined {
    if (!token) return undefined;
    const key = hash(token).toString('hex');
    const scope = this.byHash.get(key);
    if (!scope) return undefined;
    // Constant-time confirmation of the lookup, then expiry.
    if (!timingSafeEqual(Buffer.from(key, 'hex'), hash(token))) return undefined;
    if (scope.expiresAt <= this.now()) {
      this.byHash.delete(key);
      return undefined;
    }
    return scope;
  }

  /** Revokes every token issued for a run. */
  revokeRun(runId: string): number {
    let n = 0;
    for (const [k, s] of this.byHash)
      if (s.runId === runId) {
        this.byHash.delete(k);
        n++;
      }
    return n;
  }

  get size(): number {
    return this.byHash.size;
  }
}

/** The `mcp` entry and environment to give an orchestrator agent so it can call back into Krama. */
export function mcpEntryFor(
  baseUrl: string,
  token: string,
  envVar = 'KRAMA_MCP_TOKEN',
): { mcp: Record<string, unknown>; env: Record<string, string> } {
  return {
    mcp: {
      krama: {
        type: 'http',
        url: `${baseUrl.replace(/\/$/, '')}/mcp`,
        headers: { Authorization: `Bearer \${${envVar}}` },
      },
    },
    env: { [envVar]: token },
  };
}
