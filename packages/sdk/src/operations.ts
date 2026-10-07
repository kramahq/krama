import { OPERATIONS, type OperationTypes } from './generated/operations.js';

export { OPERATIONS, type OperationTypes };
export type OperationId = keyof OperationTypes;

type Skip = 'stream';
/** Operations that return a JSON body, an empty `204` or raw bytes (not the SSE streams, see `client.events`). */
export type CallableId = {
  [K in OperationId]: (typeof OPERATIONS)[K]['kind'] extends Skip ? never : K;
}[OperationId];

type Has<T> = [T] extends [undefined] ? false : true;
type IfMatchArg<K extends OperationId> = (typeof OPERATIONS)[K]['ifMatch'] extends true
  ? { ifMatch: string | number }
  : { ifMatch?: never };

/** What a call takes: path parameters, query, body, and the headers some operations need. */
export type CallArgs<K extends OperationId> = (Has<OperationTypes[K]['params']> extends true
  ? { params: OperationTypes[K]['params'] }
  : { params?: never }) &
  (Has<OperationTypes[K]['query']> extends true
    ? { query?: OperationTypes[K]['query'] }
    : { query?: never }) &
  (Has<OperationTypes[K]['body']> extends true
    ? Record<never, never> extends OperationTypes[K]['body']
      ? { body?: OperationTypes[K]['body'] }
      : { body: OperationTypes[K]['body'] }
    : { body?: never }) &
  IfMatchArg<K> & {
    /** Sent as `Idempotency-Key`; generated when the operation needs one and none is given. */
    idempotencyKey?: string;
    signal?: AbortSignal;
  };

export type CallResult<K extends OperationId> = OperationTypes[K]['response'];

/** One method per operation, named by its `operationId` in the contract. */
export type Api = { [K in CallableId]: (args: CallArgs<K>) => Promise<CallResult<K>> };

/** Arguments are optional when the operation needs none. */
export type CallFn = <K extends CallableId>(
  id: K,
  ...args: Record<never, never> extends CallArgs<K> ? [args?: CallArgs<K>] : [args: CallArgs<K>]
) => Promise<CallResult<K>>;

export function fillPath(path: string, params: Record<string, string> | undefined): string {
  return path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = params?.[name];
    if (v === undefined || v === '') throw new TypeError(`Missing path parameter "${name}"`);
    return encodeURIComponent(v);
  });
}
