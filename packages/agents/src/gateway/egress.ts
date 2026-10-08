import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

/** Why an outbound call was refused before or while it ran. */
export class EgressError extends Error {
  constructor(
    readonly code: 'blocked_address' | 'blocked_origin' | 'redirect' | 'too_large' | 'bad_url',
    message: string,
  ) {
    super(message);
    this.name = 'EgressError';
  }
}

export interface EgressPolicy {
  /**
   * Allow loopback and private addresses. True only for agents Krama started itself; an agent anyone else runs is
   * reached over the public network only.
   */
  allowPrivate: boolean;
  /** When set, only these origins (`https://host:port`) may be called, and only these may receive credentials. */
  allowedOrigins?: readonly string[];
  /** Hard cap on the bytes read from one response (a stream counts as one response). */
  maxResponseBytes: number;
}

export const MANAGED_EGRESS: EgressPolicy = {
  allowPrivate: true,
  maxResponseBytes: 64 * 1024 * 1024,
};
export const EXTERNAL_EGRESS: EgressPolicy = {
  allowPrivate: false,
  maxResponseBytes: 25 * 1024 * 1024,
};

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, including cloud metadata services
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const)
  blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const)
  blocked.addSubnet(net, prefix, 'ipv6');

/** True when `ip` is a public unicast address. IPv4-mapped IPv6 is judged by the IPv4 inside it. */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  const text = mapped ? mapped[1]! : bare;
  const family = isIP(text);
  if (family === 0) return false;
  return !blocked.check(text, family === 4 ? 'ipv4' : 'ipv6');
}

const normOrigin = (o: string): string => {
  try {
    return new URL(o).origin;
  } catch {
    return o;
  }
};

/** Checks a URL against a policy without touching the network. Literal addresses are judged here; names at connect. */
export function checkUrl(raw: string, policy: EgressPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressError('bad_url', `Not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new EgressError('bad_url', `Only http and https are allowed, not ${url.protocol}`);
  if (url.username || url.password)
    throw new EgressError('bad_url', 'Credentials in a URL are not allowed');
  if (policy.allowedOrigins && !policy.allowedOrigins.map(normOrigin).includes(url.origin))
    throw new EgressError('blocked_origin', `${url.origin} is not on the allow-list`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!policy.allowPrivate && isIP(host) && !isPublicAddress(host))
    throw new EgressError('blocked_address', `${host} is not a public address`);
  return url;
}

/** TLS material (PEM text) for one destination origin: a client certificate for mutual TLS, and/or a private CA. */
export interface TlsMaterial {
  cert?: string;
  key?: string;
  passphrase?: string;
  /** Extra trusted CA certificate(s), for a server certificate issued by the organisation's own CA. */
  ca?: string;
}

/**
 * Where outbound calls go through a proxy. `env` reads `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` (either case) when the
 * request is made; `none` never proxies; an object names the proxy. The destination is still the agent's own origin.
 */
export type ProxyConfig = 'env' | 'none' | { url?: string; noProxy?: string };

/** Per-origin request authentication that can be renewed: used for tokens that expire. */
export interface RequestAuth {
  headers(): Promise<Record<string, string>>;
  /** The server answered 401: drop what was sent so the next `headers()` gets a fresh credential. */
  rejected(): void;
}

export interface SafeFetchOptions {
  policy: EgressPolicy;
  /** Default `none`. Applies only to destinations the proxy's own `NO_PROXY` list does not exclude. */
  proxy?: ProxyConfig;
  /** TLS material for a destination origin. */
  tlsFor?: (origin: string) => TlsMaterial | undefined;
  /** Renewable authentication for a destination origin (OAuth); sent only to that origin, retried once on a 401. */
  authFor?: (origin: string) => RequestAuth | undefined;
  /** Headers to add for a destination origin (credentials). Never sent anywhere else. */
  credentialsFor?: (origin: string) => Record<string, string> | undefined;
  /** Upper bound for non-streaming calls (card, cancel). Streams are bounded by the gateway's own timers. */
  signal?: AbortSignal;
}

/**
 * A `fetch` for calls to agents: no redirects, a proxy only when asked for, a response size cap, an origin allow-list and, for
 * agents Krama did not start, a check of the address each socket actually connects to (so a name that later resolves to
 * a private address is refused too). Credentials are attached only for the origin they were issued for.
 */
export function createSafeFetch(o: SafeFetchOptions): typeof fetch {
  const { policy } = o;
  const guard: Agent.Options['connect'] = policy.allowPrivate
    ? {}
    : {
        lookup(hostname, lookupOptions, callback) {
          lookup(hostname, { all: true, verbatim: true })
            .then((addresses) => {
              if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
                throw new EgressError(
                  'blocked_address',
                  `${hostname} resolves to a non-public address`,
                );
              const usable = lookupOptions.family
                ? addresses.filter((a) => a.family === lookupOptions.family)
                : addresses;
              if (!usable.length) throw new EgressError('blocked_address', 'No usable address');
              if (lookupOptions.all) callback(null, usable);
              else callback(null, usable[0]!.address, usable[0]!.family);
            })
            .catch((e: unknown) => callback(e as Error, '', 0));
        },
      };
  // One dispatcher per origin, because the TLS material is per origin.
  const dispatchers = new Map<string, Dispatcher>();
  const dispatcherFor = (origin: string): Dispatcher => {
    const hit = dispatchers.get(origin);
    if (hit) return hit;
    const tls = o.tlsFor?.(origin);
    const material = tls ? { ...tls } : {};
    const proxy = o.proxy ?? 'none';
    // Direct connections check the address they connect to. A proxied one cannot be checked that way (the socket goes to
    // the proxy, which resolves the name), so the proxy is then the control point and only the origin allow-list and
    // literal-address checks apply.
    const d: Dispatcher =
      proxy === 'none'
        ? new Agent({ connect: { ...guard, ...material } })
        : new EnvHttpProxyAgent({
            connect: { ...guard, ...material },
            requestTls: material,
            ...(typeof proxy === 'object' && proxy.url
              ? { httpProxy: proxy.url, httpsProxy: proxy.url }
              : {}),
            ...(typeof proxy === 'object' && proxy.noProxy !== undefined
              ? { noProxy: proxy.noProxy }
              : {}),
          });
    dispatchers.set(origin, d);
    return d;
  };

  return async (input, init) => {
    const source = input instanceof Request ? input : undefined;
    const url = checkUrl(
      typeof input === 'string' || input instanceof URL ? input.toString() : input.url,
      policy,
    );
    const base: Record<string, string> = {};
    source?.headers.forEach((v, k) => (base[k.toLowerCase()] = v));
    new Headers(init?.headers).forEach((v, k) => (base[k.toLowerCase()] = v));
    for (const [k, v] of Object.entries(o.credentialsFor?.(url.origin) ?? {}))
      base[k.toLowerCase()] = v;
    delete base['cookie'];
    delete base['proxy-authorization'];

    let body: unknown = init?.body;
    if (body === undefined && source && source.method !== 'GET' && source.method !== 'HEAD')
      body = await source.text();
    const auth = o.authFor?.(url.origin);
    const send = async (): Promise<Awaited<ReturnType<typeof undiciFetch>>> => {
      const headers = { ...base };
      for (const [k, v] of Object.entries((await auth?.headers()) ?? {}))
        headers[k.toLowerCase()] = v;
      return undiciFetch(url, {
        method: init?.method ?? source?.method ?? 'GET',
        headers,
        body: body as never,
        redirect: 'manual',
        dispatcher: dispatcherFor(url.origin),
        signal: init?.signal ?? o.signal ?? null,
      });
    };
    let res = await send();
    // A renewable credential that the server rejects is renewed once; the request is replayed only when its body can be.
    if (
      res.status === 401 &&
      auth &&
      (typeof body === 'string' || body === undefined || body === null)
    ) {
      await res.body?.cancel().catch(() => undefined);
      auth.rejected();
      res = await send();
    }

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new EgressError(
        'redirect',
        `${url.origin} answered with a redirect, which is not followed`,
      );
    }
    if (Number(res.headers.get('content-length') ?? 0) > policy.maxResponseBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new EgressError(
        'too_large',
        `Response from ${url.origin} exceeds ${policy.maxResponseBytes} bytes`,
      );
    }
    if (!res.body) return res as unknown as Response;

    const reader = res.body.getReader();
    let total = 0;
    const capped = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) return controller.close();
          total += value.byteLength;
          if (total > policy.maxResponseBytes)
            throw new EgressError(
              'too_large',
              `Response from ${url.origin} exceeds ${policy.maxResponseBytes} bytes`,
            );
          controller.enqueue(value);
        } catch (e) {
          controller.error(e);
          await reader.cancel().catch(() => undefined);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    const keep = new Headers();
    for (const k of ['content-type', 'content-length', 'cache-control', 'a2a-version'])
      if (res.headers.has(k)) keep.set(k, res.headers.get(k)!);
    return new Response(capped, { status: res.status, statusText: res.statusText, headers: keep });
  };
}

/** Removes known secret values (and their base64 / URL-encoded forms) from text that may be logged or returned. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    for (const form of [s, Buffer.from(s).toString('base64'), encodeURIComponent(s)])
      out = out.split(form).join('[redacted]');
  }
  return out;
}
