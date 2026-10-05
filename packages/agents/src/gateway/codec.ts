import { mapUsageSummary, type GatewayEvent, type TaskState } from '@kramahq/engine';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Task state names across A2A 0.3 (`input-required`) and 1.0 (`TASK_STATE_INPUT_REQUIRED`). */
export function mapState(raw: unknown): TaskState {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/^task_state_/, '')
    .replace(/_/g, '-');
  switch (s) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'rejected':
      return 'failed';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    case 'input-required':
    case 'auth-required':
      return 'input_required';
    default:
      return 'working'; // submitted, working, unknown
  }
}

export const isTerminal = (s: TaskState): boolean =>
  s === 'completed' || s === 'failed' || s === 'canceled' || s === 'timed_out';

const partsText = (parts: unknown): string =>
  (Array.isArray(parts) ? parts : [])
    .map((p) => obj(p))
    .filter((p) => p && (p.kind === 'text' || p.text !== undefined))
    .map((p) => str(p!.text) ?? '')
    .join('');

// The mapping is shared with the HTTP event sink so both channels count usage the same way.
export { mapUsageSummary };

/** Accumulates streamed artifact chunks so each artifact is emitted once, complete. */
export class ArtifactAssembler {
  private bufs = new Map<
    string,
    { name: string; text: string[]; data: unknown[]; files: Uint8Array[]; mediaType?: string }
  >();

  /** Returns events for a finished artifact, or nothing while chunks are still arriving. */
  push(event: Json): GatewayEvent[] {
    const a = obj(event.artifact);
    if (!a) return [];
    const id = str(a.artifactId) ?? str(a.name) ?? 'artifact';
    const cur = event.append === true ? this.bufs.get(id) : undefined;
    const buf = cur ?? { name: str(a.name) ?? id, text: [], data: [], files: [] };
    for (const p of Array.isArray(a.parts) ? a.parts : []) {
      const part = obj(p);
      if (!part) continue;
      if (part.kind === 'text' || typeof part.text === 'string')
        buf.text.push(str(part.text) ?? '');
      else if (part.kind === 'data' || part.data !== undefined) buf.data.push(part.data);
      else if (part.kind === 'file' || part.file !== undefined || part.raw !== undefined) {
        const f = obj(part.file) ?? part;
        const b64 = str(f.bytes) ?? str(f.raw);
        if (b64) buf.files.push(Uint8Array.from(Buffer.from(b64, 'base64')));
        buf.mediaType = str(f.mimeType) ?? str(f.mediaType) ?? buf.mediaType;
      }
    }
    this.bufs.set(id, buf);
    return event.lastChunk === false ? [] : this.flush(id);
  }

  flush(id?: string): GatewayEvent[] {
    const out: GatewayEvent[] = [];
    for (const [key, b] of [...this.bufs]) {
      if (id !== undefined && key !== id) continue;
      this.bufs.delete(key);
      const text = b.text.join('');
      if (text)
        out.push({
          kind: 'artifact',
          name: b.name,
          mediaType: 'text/plain',
          bytes: new TextEncoder().encode(text),
        });
      for (const d of b.data)
        out.push({ kind: 'artifact', name: b.name, mediaType: 'application/json', data: d });
      for (const f of b.files)
        out.push({
          kind: 'artifact',
          name: b.name,
          mediaType: b.mediaType ?? 'application/octet-stream',
          bytes: f,
        });
    }
    return out;
  }
}

export interface DecodeState {
  taskId?: string;
  contextId?: string;
  assembler: ArtifactAssembler;
  lastState?: TaskState;
}

/** Sideband artifact names the wrappers publish (`trace.*`). Unknown ones are kept as status events, never dropped. */
function decodeTrace(name: string, event: Json): GatewayEvent[] {
  const a = obj(event.artifact);
  const dataPart = (Array.isArray(a?.parts) ? a!.parts : [])
    .map(obj)
    .find((p) => p && (p.kind === 'data' || p.data !== undefined));
  const data = obj(dataPart?.data) ?? {};
  const text = partsText(a?.parts);
  const tool = str(data.toolName);
  switch (name) {
    case 'trace.mcp.start':
      return [
        {
          kind: 'sideband',
          type: 'tool_call',
          ...(tool ? { toolName: tool } : {}),
          text: tool ?? 'tool call',
          raw: data,
        },
      ];
    case 'trace.mcp':
      return [
        {
          kind: 'sideband',
          type: 'tool_result',
          ...(tool ? { toolName: tool } : {}),
          ...(typeof data.isError === 'boolean' ? { isError: data.isError } : {}),
          ...(typeof data.durationMs === 'number' ? { durationMs: data.durationMs } : {}),
          text: tool ?? 'tool result',
          raw: data,
        },
      ];
    case 'trace.thinking':
    case 'trace.thought':
      return [
        {
          kind: 'sideband',
          type: 'thinking',
          text: text || str(data.text) || str(data.thought) || '',
          raw: data,
        },
      ];
    case 'trace.usage':
      return []; // per-call usage; the final `x-usage` summary is the single source of truth (avoids double counting)
    default:
      return [{ kind: 'sideband', type: 'status', text: text || name, raw: { name, ...data } }];
  }
}

/** One A2A stream event or task snapshot → zero or more gateway events. */
export function decodeEvent(event: Json, st: DecodeState): GatewayEvent[] {
  const out: GatewayEvent[] = [];
  st.taskId = str(event.taskId) ?? (event.kind === 'task' ? str(event.id) : undefined) ?? st.taskId;
  st.contextId = str(event.contextId) ?? st.contextId;
  const kind = str(event.kind);

  if (kind === 'artifact-update' || (kind === undefined && event.artifact)) {
    const name = str(obj(event.artifact)?.name) ?? '';
    return name.startsWith('trace.') ? decodeTrace(name, event) : st.assembler.push(event);
  }

  if (kind === 'message') {
    const text = partsText(event.parts);
    if (text)
      out.push({
        kind: 'artifact',
        name: 'message',
        mediaType: 'text/plain',
        bytes: new TextEncoder().encode(text),
      });
    st.taskId ??= `msg_${str(event.messageId) ?? 'reply'}`;
    out.push({
      kind: 'state',
      state: 'completed',
      taskId: st.taskId,
      ...(st.contextId ? { contextId: st.contextId } : {}),
    });
    st.lastState = 'completed';
    return out;
  }

  const status = obj(event.status);
  if (status || kind === 'status-update' || kind === 'task') {
    // A full task snapshot may carry finished artifacts.
    for (const art of Array.isArray(event.artifacts) ? event.artifacts : []) {
      const a = obj(art);
      if (a && !String(a.name ?? '').startsWith('trace.'))
        out.push(...st.assembler.push({ artifact: a, lastChunk: true }));
    }
    const usage = mapUsageSummary(obj(event.metadata)?.['x-usage']);
    if (usage && usage.usage.length) out.push({ kind: 'usage', usage: usage.usage, cost: null });
    if (status) {
      const state = mapState(status.state);
      const text = partsText(obj(status.message)?.parts);
      // Provisional wire format for a permission request (wrapper task W3): metadata["x-access-request"] = { path, mode? }.
      const ar = obj(obj(event.metadata)?.['x-access-request']);
      const accessPath = str(ar?.path);
      if (st.taskId) {
        // Drain finished artifacts before a terminal state so consumers see them first.
        if (isTerminal(state)) out.unshift(...st.assembler.flush());
        out.push({
          kind: 'state',
          state,
          taskId: st.taskId,
          ...(st.contextId ? { contextId: st.contextId } : {}),
          ...(text ? { text } : {}),
          ...(state === 'input_required' && accessPath
            ? {
                request: {
                  type: 'access' as const,
                  path: accessPath,
                  ...(ar?.mode === 'read' || ar?.mode === 'write' ? { mode: ar.mode } : {}),
                },
              }
            : {}),
        });
        st.lastState = state;
      }
    }
  }
  return out;
}

/** Parse SSE bytes into JSON-RPC `result` objects, skipping malformed frames. */
export async function* sseResults(
  body: ReadableStream<Uint8Array>,
  onError: (e: { code?: number; message: string }) => void,
): AsyncGenerator<Json> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const frames = function* (final: boolean) {
    const parts = buf.split(/\r?\n\r?\n/);
    buf = final ? '' : (parts.pop() ?? '');
    for (const part of final ? parts : parts) {
      const data = part
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('');
      if (data) yield data;
    }
  };
  const handle = function* (data: string): Generator<Json> {
    try {
      const env = obj(JSON.parse(data));
      const err = obj(env?.error);
      if (err)
        onError({
          ...(typeof err.code === 'number' ? { code: err.code } : {}),
          message: str(err.message) ?? 'A2A error',
        });
      const result = obj(env?.result);
      if (result) yield result;
    } catch {
      /* malformed frame: skip */
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const d of frames(false)) yield* handle(d);
    }
    buf += dec.decode();
    for (const d of frames(true)) yield* handle(d);
  } finally {
    reader.releaseLock();
  }
}
