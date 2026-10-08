import type { RequestAuth } from './egress.js';

/** OAuth 2.0 client credentials (RFC 6749 §4.4): a service identity for a machine-to-machine call. */
export interface OAuthClientCredentials {
  type: 'oauth2_client_credentials';
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  /** Sent as `audience` (and `resource` is not): some authorisation servers require it. */
  audience?: string;
  /** Send the client id and secret in the form body instead of HTTP Basic. Default Basic. */
  clientAuth?: 'basic' | 'body';
}

/** How Krama authenticates to one agent origin. A static header set is `GatewayOptions.credentials`. */
export type AgentAuth = OAuthClientCredentials | { type: 'bearer'; token: string };

/** Early renewal margin, so a token is not used in the last seconds of its life. */
const SKEW_MS = 30_000;
const MAX_TOKEN_LIFETIME_MS = 24 * 60 * 60_000;

/**
 * Fetches and caches an access token. One request is in flight at a time, so a burst of calls shares a single fetch. The
 * token is held in memory only. `fetchImpl` must be the guarded fetch, so the token endpoint obeys the same egress rules
 * as the agent.
 */
export class OAuthTokenProvider implements RequestAuth {
  private token?: { value: string; expiresAt: number };
  private inflight?: Promise<string>;

  constructor(
    private readonly cfg: OAuthClientCredentials,
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async headers(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.accessToken()}` };
  }

  rejected(): void {
    this.token = undefined;
  }

  /** The values that must never appear in a log or an error: the client secret and the token in use. */
  secrets(): string[] {
    return [this.cfg.clientSecret, this.token?.value].filter((s): s is string => !!s);
  }

  private accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - SKEW_MS > this.now())
      return Promise.resolve(this.token.value);
    this.inflight ??= this.fetchToken().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    const { cfg } = this;
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (cfg.scope) form.set('scope', cfg.scope);
    if (cfg.audience) form.set('audience', cfg.audience);
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (cfg.clientAuth === 'body') {
      form.set('client_id', cfg.clientId);
      form.set('client_secret', cfg.clientSecret);
    } else {
      // RFC 6749 §2.3.1: the id and secret are form-urlencoded before they are joined.
      const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
      headers['authorization'] =
        `Basic ${Buffer.from(`${enc(cfg.clientId)}:${enc(cfg.clientSecret)}`).toString('base64')}`;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(cfg.tokenUrl, { method: 'POST', headers, body: form.toString() });
    } catch (e) {
      throw new TokenError(`The token endpoint could not be reached: ${(e as Error).message}`, {
        cause: e,
      });
    }
    let json: Record<string, unknown> | undefined;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    if (!res.ok)
      // The OAuth error code is a fixed vocabulary and safe to show; the description is the server's own text and is not.
      throw new TokenError(
        `The token endpoint answered HTTP ${res.status}${typeof json?.error === 'string' ? ` (${json.error.replace(/[^\w.-]/g, '')})` : ''}`,
      );
    const value = json?.access_token;
    if (typeof value !== 'string' || !value)
      throw new TokenError('The token endpoint answered without an access_token');
    if (typeof json?.token_type === 'string' && json.token_type.toLowerCase() !== 'bearer')
      throw new TokenError(`Unsupported token_type "${json.token_type.replace(/[^\w.-]/g, '')}"`);
    const seconds = Number(json?.expires_in);
    // No `expires_in` is treated as short-lived, not as forever.
    const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5 * 60_000;
    this.token = { value, expiresAt: this.now() + Math.min(lifetime, MAX_TOKEN_LIFETIME_MS) };
    return value;
  }
}

export class TokenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TokenError';
  }
}
