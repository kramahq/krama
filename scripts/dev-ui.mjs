// Starts the mock API and the UI dev server together, so the UI can be tried with no server and no agents:
//   pnpm build && pnpm dev:ui        then open http://localhost:5173
// Plain Node, no shell, so it behaves the same on Linux, macOS and Windows.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mock = join(root, 'apps', 'mock', 'dist', 'server.js');
if (!existsSync(mock)) {
  console.error('The mock API is not built yet. Run `pnpm build` first.');
  process.exit(1);
}

const uiDir = join(root, 'apps', 'ui');
const vite = join(
  dirname(createRequire(join(uiDir, 'package.json')).resolve('vite/package.json')),
  'bin',
  'vite.js',
);
const port = process.env.MOCK_PORT ?? '4010';

const children = [
  spawn(process.execPath, [mock], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PORT: port },
  }),
  spawn(process.execPath, [vite, '--host', '127.0.0.1'], {
    cwd: uiDir,
    stdio: 'inherit',
    env: { ...process.env, KRAMA_API: `http://127.0.0.1:${port}` },
  }),
];

const stop = () => {
  for (const c of children) c.kill();
};
process.on('SIGINT', () => {
  stop();
  process.exit(0);
});
process.on('SIGTERM', stop);
// If either side dies, the other has nothing to do.
for (const c of children)
  c.on('exit', (code) => {
    stop();
    process.exit(code ?? 0);
  });
