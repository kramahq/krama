import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createKrama } from '../src/index.js';

describe('audit storage', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it.each(['same', 'separate'] as const)(
    'keeps the audit record in the %s database and the event log working beside it',
    async (mode) => {
      const home = mkdtempSync(join(tmpdir(), `krama-audit-${mode}-`));
      dirs.push(home);
      const krama = await createKrama({ home, packs: [], definitions: [], auditStorage: mode });
      try {
        const ledger = krama.ports.ledger!;
        const { record } = await ledger.append({
          chain: 'control',
          actor: { type: 'system', id: 's' },
          kind: 'server.started',
          source: 'system',
        });
        expect(record.seq).toBe(1);
        const blob = await krama.ports.auditBlobs!.put(
          new TextEncoder().encode('body'),
          'text/plain',
        );
        expect(await krama.ports.auditBlobs!.has(blob.sha256)).toBe(true);
        expect((await ledger.verify('control', { blobs: krama.ports.auditBlobs! })).ok).toBe(true);
        await krama.ports.events.append({
          type: 'activity.message',
          subject: { type: 'run', id: 'x' },
          data: {},
        });
        expect(existsSync(join(home, 'audit-db'))).toBe(mode === 'separate');
      } finally {
        await krama.close();
      }
    },
    60_000,
  );
});
