import type { Readable } from 'node:stream';
import type { ApiRequest } from './context.js';

/**
 * A non-JSON answer: the bytes of a file or an artifact. A route that returns one skips the contract's `response`
 * schema, which describes JSON bodies.
 */
export class RawBody {
  constructor(
    readonly body: Buffer | Uint8Array | Readable | undefined,
    readonly o: { status?: number; mediaType: string; headers?: Record<string, string> },
  ) {}
  get status(): number {
    return this.o.status ?? 200;
  }
}

export interface ByteRangeSpec {
  start: number;
  /** Inclusive. */
  end: number;
}

/**
 * One `bytes=` range of a body of `size` bytes. `undefined` means serve everything (no header, a unit other than
 * bytes, or several ranges, which are not supported); `'unsatisfiable'` is a 416.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRangeSpec | 'unsatisfiable' | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  if (size === 0) return 'unsatisfiable';
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    return { start: Math.max(size - n, 0), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/** Headers every served file carries. The bytes are untrusted: they are never sniffed into another type. */
const SAFE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'accept-ranges': 'bytes',
} as const;

/** Types a browser runs as a page when opened directly. They are sandboxed so they cannot act as the API's origin. */
const ACTIVE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|(application|text)\/xml)\b/i;

export type Negotiated =
  | { kind: 'not_modified'; response: RawBody }
  | { kind: 'unsatisfiable'; response: RawBody }
  | { kind: 'full' | 'partial'; range: ByteRangeSpec | undefined; headers: Record<string, string> };

/**
 * Decides how to answer a GET for `size` bytes: `304` when the `ETag` is current, `416` for a range outside the body,
 * otherwise the range to read (or the whole body) and the headers to send with it.
 */
export function negotiate(
  req: Pick<ApiRequest, 'headers'>,
  size: number,
  o: { etag?: string; mediaType?: string },
): Negotiated {
  const base: Record<string, string> = {
    ...SAFE_HEADERS,
    ...(o.mediaType && ACTIVE.test(o.mediaType) ? { 'content-security-policy': 'sandbox' } : {}),
    ...(o.etag ? { etag: o.etag } : {}),
  };
  const inm = req.headers['if-none-match'];
  if (o.etag && typeof inm === 'string' && notModifiedByTag(inm, o.etag))
    return {
      kind: 'not_modified',
      response: new RawBody(undefined, { status: 304, mediaType: 'text/plain', headers: base }),
    };
  const range = parseRange(req.headers['range'] as string | undefined, size);
  if (range === 'unsatisfiable')
    return {
      kind: 'unsatisfiable',
      response: new RawBody(undefined, {
        status: 416,
        mediaType: 'text/plain',
        headers: { ...base, 'content-range': `bytes */${size}` },
      }),
    };
  if (!range)
    return { kind: 'full', range: undefined, headers: { ...base, 'content-length': String(size) } };
  return {
    kind: 'partial',
    range,
    headers: {
      ...base,
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
      'content-length': String(range.end - range.start + 1),
    },
  };
}

/** `If-None-Match` against a strong tag (`"abc"`), as opposed to the version tags of `helpers.notModified`. */
function notModifiedByTag(header: string, etag: string): boolean {
  return (
    header.trim() === '*' || header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)
  );
}

/** Media types for the files an agent commonly leaves in a workspace; anything else is opaque bytes. */
const MEDIA_TYPES: Record<string, string> = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json',
  csv: 'text/csv; charset=utf-8',
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  tsx: 'text/plain; charset=utf-8',
  jsx: 'text/plain; charset=utf-8',
  py: 'text/plain; charset=utf-8',
  yaml: 'text/plain; charset=utf-8',
  yml: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  zip: 'application/zip',
  patch: 'text/x-diff; charset=utf-8',
  diff: 'text/x-diff; charset=utf-8',
};

export function mediaTypeOfPath(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  return (ext && MEDIA_TYPES[ext]) || 'application/octet-stream';
}
