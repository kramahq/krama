import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { formatReports, run, validatePacks } from '../src/index.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'krama cli '));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const pack = (over: { orchestrator?: string } = {}) => `
name: notes
version: 0.1.0
description: Notes.
engine: ">=0.1.0"
orchestrator: ${over.orchestrator ?? 'planner'}
agents:
  planner:
    config:
      agentCard: { name: planner, description: Plans }
      claude: { model: claude-sonnet-5-5 }
    subAgents:
      - { agent: writer, hint: Writes. }
  writer:
    config:
      agentCard:
        name: writer
        description: Writes
        skills: [ { id: write, name: Write, description: Writes } ]
      codex: { model: gpt-5-codex }
`;

const put = (dir: string, file: string, text: string) => {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), text);
};

const cli = async (argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join(''), err: err.join('') };
};

describe('krama pack validate', () => {
  it('passes a valid pack and says so', async () => {
    const d = tmp();
    put(d, 'krama-pack.yaml', pack());
    const r = await cli(['pack', 'validate', d]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('ok');
    expect(r.out).toContain('notes 0.1.0');
  });

  it('fails an invalid pack with each problem and where it is', async () => {
    const d = tmp();
    put(d, 'krama-pack.yaml', pack({ orchestrator: 'nobody' }));
    const r = await cli(['pack', 'validate', d]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('INVALID');
    expect(r.out).toContain('orchestrator');
  });

  it('checks each pack in the folders of a directory, and fails if any one is wrong', async () => {
    const d = tmp();
    put(d, 'good/krama-pack.yaml', pack());
    put(d, 'bad/krama-pack.yaml', pack({ orchestrator: 'nobody' }));
    put(d, 'not-a-pack/readme.md', 'hi');
    const reports = await validatePacks(d);
    expect(reports.map((r) => [r.dir.split(/[\\/]/).pop(), r.ok])).toEqual([
      ['bad', false],
      ['good', true],
    ]);
    expect((await cli(['pack', 'validate', d])).code).toBe(1);
  });

  it('prints JSON for a machine', async () => {
    const d = tmp();
    put(d, 'krama-pack.yaml', pack());
    const r = await cli(['pack', 'validate', d, '--json']);
    expect(JSON.parse(r.out)).toMatchObject([{ name: 'notes', version: '0.1.0', ok: true }]);
  });

  it('applies a backend allow-list', async () => {
    const d = tmp();
    put(d, 'krama-pack.yaml', pack());
    const r = await cli(['pack', 'validate', d, '--allowed-backends', 'a2a-claude']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('a2a-codex');
  });

  it('says what is wrong when there is nothing to check or the command is not known', async () => {
    const empty = await cli(['pack', 'validate', tmp()]);
    expect(empty.code).toBe(2);
    expect(empty.err).toContain('krama-pack.yaml');
    const unknown = await cli(['frobnicate']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('krama pack validate');
    expect((await cli(['pack', 'validate', '--nonsense'])).code).toBe(2);
  });

  it('formats a clean report on one line', () => {
    expect(formatReports([{ dir: '/x', name: 'a', version: '1.0.0', ok: true, issues: [] }])).toBe(
      'ok      a 1.0.0',
    );
  });
});
