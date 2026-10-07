import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Krama } from '../compose.js';
import type { Principal } from './auth.js';
import type { ServerConfig } from './config.js';
import type { OperationRegistry } from './operations.js';

/** What every handler can reach. Handlers go through the engine and its ports, never around them. */
export interface ApiContext {
  krama: Krama;
  config: ServerConfig;
  /** Reported as `engineVersion`. */
  version: string;
  /** Starts long-running work and answers `GET /operations/{id}`. */
  operations: OperationRegistry;
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

/** What a stream handler gets besides the request: the raw socket, once it decides to take it. */
export interface StreamContext {
  req: IncomingMessage;
  /** Takes over the response (Fastify stops managing it) and returns the raw one. Call it once, before writing. */
  hijack(): ServerResponse;
  /** Headers already set on the reply (CORS, request id) that a hijacked response must repeat. */
  headers: Record<string, string>;
}

/** Returned by a stream handler that has taken over the response. */
export const STREAMED = Symbol('streamed');

/** A route with `stream: true`: returns a body (a replay page) or `STREAMED`. */
export type StreamHandler = (req: ApiRequest, s: StreamContext) => Promise<unknown>;
export type StreamHandlers = Record<string, StreamHandler>;
