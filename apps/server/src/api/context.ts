import type { Krama } from '../compose.js';
import type { Principal } from './auth.js';
import type { ServerConfig } from './config.js';

/** What every handler can reach. Handlers go through the engine and its ports, never around them. */
export interface ApiContext {
  krama: Krama;
  config: ServerConfig;
  /** Reported as `engineVersion`. */
  version: string;
}

export interface ApiRequest<Q = unknown, B = unknown> {
  params: Record<string, string>;
  query: Q;
  body: B;
  headers: Record<string, string | string[] | undefined>;
  principal: Principal;
  /** Parsed `If-Match` version, on routes that declare `ifMatch`. */
  ifMatch: number | undefined;
  /** The `Idempotency-Key` header, when sent on a route that supports it. */
  idempotencyKey: string | undefined;
  /** Correlates a failure in the logs with the `traceId` a client sees. */
  requestId: string;
  ctx: ApiContext;
}

export interface ApiReply {
  /** Sets the success status when it differs from the route's default. */
  code(status: number): void;
  header(name: string, value: string): void;
}

/** Returns the response body, or a `Versioned` body to send an `ETag`. */
export type Handler = (req: ApiRequest, reply: ApiReply) => unknown | Promise<unknown>;
export type Handlers = Record<string, Handler>;
