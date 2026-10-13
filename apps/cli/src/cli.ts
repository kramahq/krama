import { parseArgs } from 'node:util';
import { PACK_FILE } from '@kramahq/pack';
import { findPacks, formatReports, validatePacks } from './commands/pack-validate.js';

const USAGE = `krama pack validate [dir] [--online] [--allowed-backends a,b] [--json]

Checks the pack in <dir> (default: the current directory), or each pack in its folders, against the
backends Krama knows: the graph, each agent's config, files, secrets and variables. Exits 0 when every
pack is valid, 1 when one is not, 2 when it could not run.

  --online   fetch the agents a pack takes from git, at their pinned commits, and check those too
  --json     print the report as JSON
`;

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

/** Runs the command line and returns the exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  if (cmd !== 'pack' || sub !== 'validate') {
    io.err(USAGE);
    return cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 2;
  }
  let args;
  try {
    args = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        online: { type: 'boolean' },
        json: { type: 'boolean' },
        'allowed-backends': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return 2;
  }
  if (args.values.help) {
    io.out(USAGE);
    return 0;
  }
  const dir = args.positionals[0] ?? '.';
  if (findPacks(dir).length === 0) {
    io.err(`No ${PACK_FILE} in ${dir} or in its folders\n`);
    return 2;
  }
  const allowed = args.values['allowed-backends']?.split(',').map((s) => s.trim());
  const reports = await validatePacks(dir, {
    ...(args.values.online ? { online: true } : {}),
    ...(allowed ? { allowedBackends: allowed } : {}),
  });
  io.out(`${args.values.json ? JSON.stringify(reports, null, 2) : formatReports(reports)}\n`);
  return reports.every((r) => r.ok) ? 0 : 1;
}
