// A stand-in for an A2A wrapper, started by the runtime exactly like a real one:
//   node fake-wrapper.mjs --config <file> --port <n> --hostname <h> --advertise-host <h>
// Behaviour comes from the `fake` option in the config's provider section.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const config = JSON.parse(readFileSync(arg('--config'), 'utf8'));
const port = Number(arg('--port'));
const host = arg('--hostname') ?? '127.0.0.1';
const section = config.fake ?? {};
const fake = section.fake ?? {};

if (fake.exitImmediately !== undefined) {
  console.error(`boom: ${fake.exitImmediately}`);
  process.exit(3);
}

let healthy = true;
if (fake.grandchildPidFile) {
  // A child that would be orphaned if only the wrapper were killed.
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(fake.grandchildPidFile, String(g.pid));
}

const server = createServer((req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/.well-known/agent-card.json')
    return fake.neverReady || !healthy
      ? json(503, { error: 'not ready' })
      : json(200, { name: config.agentCard?.name, protocolVersion: '1.0' });
  if (req.url === '/debug')
    return json(200, {
      argv: process.argv.slice(2),
      config,
      env: process.env,
      cwd: process.cwd(),
      pid: process.pid,
    });
  if (req.url === '/debug/sick') {
    healthy = false;
    return json(200, { healthy });
  }
  if (req.url === '/debug/well') {
    healthy = true;
    return json(200, { healthy });
  }
  return json(404, { error: 'not found' });
});

setTimeout(
  () => server.listen(port, host, () => console.log(`fake wrapper listening on ${host}:${port}`)),
  fake.startDelayMs ?? 0,
);
if (fake.crashAfterMs) setTimeout(() => process.exit(1), fake.crashAfterMs);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
