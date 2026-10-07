import type {
  Artifact,
  Message,
  Part,
  StreamResponse,
  Task,
  TaskState,
  TaskStatus,
} from '@a2a-js/sdk';

type Json = Record<string, unknown>;

/**
 * The SDK hands back typed v1 objects for every protocol version it speaks (0.3 agents are translated by its
 * compatibility layer). The codec reads one plain shape, so the typed objects are flattened to it here, in one place.
 * Task states keep their v1 names (`TASK_STATE_WORKING`); `mapState` accepts both spellings.
 */

const STATE_NAMES: Record<number, string> = {
  0: 'TASK_STATE_UNSPECIFIED',
  1: 'TASK_STATE_SUBMITTED',
  2: 'TASK_STATE_WORKING',
  3: 'TASK_STATE_COMPLETED',
  4: 'TASK_STATE_FAILED',
  5: 'TASK_STATE_CANCELED',
  6: 'TASK_STATE_INPUT_REQUIRED',
  7: 'TASK_STATE_REJECTED',
  8: 'TASK_STATE_AUTH_REQUIRED',
};

const stateName = (s: TaskState): string => STATE_NAMES[s as number] ?? 'TASK_STATE_UNSPECIFIED';

const part = (p: Part): Json => {
  const c = p.content;
  const meta = p.metadata ? { metadata: p.metadata } : {};
  switch (c?.$case) {
    case 'text':
      return { kind: 'text', text: c.value, ...meta };
    case 'data':
      return { kind: 'data', data: c.value, ...meta };
    case 'raw':
      return {
        kind: 'file',
        raw: Buffer.from(c.value).toString('base64'),
        mediaType: p.mediaType || undefined,
        ...(p.filename ? { name: p.filename } : {}),
        ...meta,
      };
    case 'url':
      // A reference, not content: keep the address visible rather than dropping the part.
      return { kind: 'text', text: c.value, ...meta };
    default:
      return { kind: 'text', text: '' };
  }
};

const artifact = (a: Artifact): Json => ({
  artifactId: a.artifactId,
  name: a.name,
  parts: a.parts.map(part),
  ...(a.metadata ? { metadata: a.metadata } : {}),
});

const message = (m: Message): Json => ({
  kind: 'message',
  messageId: m.messageId,
  ...(m.contextId ? { contextId: m.contextId } : {}),
  ...(m.taskId ? { taskId: m.taskId } : {}),
  role: m.role,
  parts: m.parts.map(part),
  ...(m.metadata ? { metadata: m.metadata } : {}),
});

const status = (s: TaskStatus | undefined): Json | undefined =>
  s
    ? { state: stateName(s.state), ...(s.message ? { message: message(s.message) } : {}) }
    : undefined;

export const taskToWire = (t: Task): Json => ({
  kind: 'task',
  id: t.id,
  ...(t.contextId ? { contextId: t.contextId } : {}),
  status: status(t.status),
  artifacts: t.artifacts.map(artifact),
  ...(t.metadata ? { metadata: t.metadata } : {}),
});

/** One typed stream payload to the plain shape the codec reads. Unknown payloads yield `undefined` and are skipped. */
export function streamToWire(r: StreamResponse): Json | undefined {
  const p = r.payload;
  switch (p?.$case) {
    case 'task':
      return taskToWire(p.value);
    case 'message':
      return message(p.value);
    case 'statusUpdate':
      return {
        kind: 'status-update',
        taskId: p.value.taskId,
        ...(p.value.contextId ? { contextId: p.value.contextId } : {}),
        status: status(p.value.status),
        ...(p.value.metadata ? { metadata: p.value.metadata } : {}),
      };
    case 'artifactUpdate':
      return {
        kind: 'artifact-update',
        taskId: p.value.taskId,
        ...(p.value.contextId ? { contextId: p.value.contextId } : {}),
        artifact: p.value.artifact ? artifact(p.value.artifact) : undefined,
        append: p.value.append,
        lastChunk: p.value.lastChunk,
      };
    default:
      return undefined;
  }
}
