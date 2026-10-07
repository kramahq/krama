import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  policyFile,
  policyFromEnv,
  readPolicyFile,
  resolvePolicy,
  type PolicyFile,
  type ServerPolicy,
} from './policy.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface ServerConfig {
  /** Database, artifacts, agent configs, workspaces, the token file, `policy.json`. */
  home: string;
  host: string;
  port: number;
  /** The static bearer token every non-public route requires (D11). */
  token: string;
  /** `true` when the token was generated and written to `<home>/token` on this start. */
  tokenGenerated: boolean;
  policy: ServerPolicy;
  /** Where the policy came from, for `/settings` and the startup line. */
  policySources: string[];
  /** Browser origins allowed by CORS. Empty = same-origin only (loopback origins are always allowed). */
  corsOrigins: string[];
  /** Largest JSON body, in bytes. */
  bodyLimit: number;
}

export const DEFAULT_PORT = 4747;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
export const isLoopback = (host: string): boolean => LOOPBACK.has(host);

export interface ConfigInput {
  /** Process arguments after the executable and script (`--port 4747 ...`). */
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

const OPTIONS = {
  home: { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  token: { type: 'string' },
  policy: { type: 'string' },
  'allow-remote': { type: 'boolean' },
  cors: { type: 'string', multiple: true },
  'allowed-backends': { type: 'string' },
  'delegation-mode': { type: 'string' },
  'delegation-proxy': { type: 'string' },
  'external-hosts': { type: 'string' },
} as const;

/**
 * Builds the server configuration. Precedence per setting: built-in default, then `policy.json`, then `KRAMA_*`
 * environment variables, then command-line flags. Binds to loopback unless `--allow-remote` is given, and always
 * requires a token (D11): one is generated into `<home>/token` (mode 0600) when none is supplied.
 */
export function loadConfig(input: ConfigInput = {}): ServerConfig {
  const env = input.env ?? process.env;
  let args;
  try {
    args = parseArgs({ args: [...(input.argv ?? [])], options: OPTIONS, strict: true }).values;
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }

  const home = resolve(args.home ?? env['KRAMA_HOME'] ?? join(homedir(), '.krama'));
  const host = args.host ?? env['KRAMA_HOST'] ?? '127.0.0.1';
  const allowRemote = args['allow-remote'] === true || env['KRAMA_ALLOW_REMOTE'] === '1';
  if (!isLoopback(host) && !allowRemote)
    throw new ConfigError(
      `Refusing to listen on ${host}: the server binds to loopback unless --allow-remote is given`,
    );

  const rawPort = args.port ?? env['KRAMA_PORT'];
  const port = rawPort === undefined ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new ConfigError(`Invalid port: ${rawPort}`);

  // Token: flag, env, an existing token file, else generate one.
  const tokenFile = join(home, 'token');
  let token = args.token ?? env['KRAMA_TOKEN'];
  let tokenGenerated = false;
  if (token === undefined && existsSync(tokenFile)) token = readFileSync(tokenFile, 'utf8').trim();
  if (!token) {
    token = randomBytes(24).toString('base64url');
    mkdirSync(home, { recursive: true });
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
    tokenGenerated = true;
  }
  if (token.length < 16) throw new ConfigError('The token must be at least 16 characters');

  // Policy layers.
  const sources: string[] = ['built-in defaults'];
  const layers: (PolicyFile | undefined)[] = [];
  const explicit = args.policy ?? env['KRAMA_POLICY'];
  const policyPath = explicit
    ? isAbsolute(explicit)
      ? explicit
      : resolve(explicit)
    : join(home, 'policy.json');
  if (explicit || existsSync(policyPath)) {
    layers.push(readPolicyFile(policyPath));
    sources.push(policyPath);
  }
  const fromEnv = policyFromEnv(env);
  if (Object.keys(fromEnv).length) {
    layers.push(fromEnv);
    sources.push('environment');
  }
  const flags: Record<string, unknown> = {};
  if (args['allowed-backends'])
    flags['allowedBackends'] = args['allowed-backends']
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  if (args['external-hosts'])
    flags['externalHosts'] = args['external-hosts']
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const delegation: Record<string, unknown> = {};
  if (args['delegation-mode']) delegation['mode'] = args['delegation-mode'];
  if (args['delegation-proxy']) delegation['proxy'] = args['delegation-proxy'];
  if (Object.keys(delegation).length) flags['delegation'] = delegation;
  if (Object.keys(flags).length) {
    const r = policyFile.safeParse(flags);
    if (!r.success)
      throw new ConfigError(
        'Invalid policy flag: ' +
          r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    layers.push(r.data);
    sources.push('command line');
  }

  return {
    home,
    host,
    port,
    token,
    tokenGenerated,
    policy: resolvePolicy(...layers),
    policySources: sources,
    corsOrigins: [
      ...(args.cors ?? []),
      ...(env['KRAMA_CORS_ORIGINS']
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean) ?? []),
    ],
    bodyLimit: 1024 * 1024, // contract 6.7: 1 MiB for JSON
  };
}
