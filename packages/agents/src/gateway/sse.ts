/**
 * Passes a server-sent-events stream through, leaving out frames whose `data` is not JSON. The SDK treats one such frame
 * as fatal; an agent that sends one bad frame among good ones should not lose the delegation. Comments and
 * heartbeats pass untouched. (Everything the agent sent is still captured at the tap, see M3.5.)
 */
export function dropMalformedSseFrames(): TransformStream<Uint8Array, Uint8Array> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = '';
  const ok = (frame: string): boolean => {
    const data = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return true;
    try {
      JSON.parse(data);
      return true;
    } catch {
      return false;
    }
  };
  const emit = (c: TransformStreamDefaultController<Uint8Array>, frames: string[]) => {
    for (const f of frames) if (ok(f)) c.enqueue(enc.encode(`${f}\n\n`));
  };
  return new TransformStream({
    transform(chunk, c) {
      buf += dec.decode(chunk, { stream: true });
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() ?? '';
      emit(c, parts);
    },
    flush(c) {
      buf += dec.decode();
      if (buf.trim()) emit(c, [buf]);
    },
  });
}
