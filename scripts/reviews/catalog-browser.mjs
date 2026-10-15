// After pnpm build: node scripts/reviews/catalog-browser.mjs
// Uses installed Chrome (or CHROME_PATH), real HTTP APIs and disposable local Git sources.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApi, createKrama, loadConfig } from '../../apps/server/dist/index.js';
import { Git } from '../../packages/git/dist/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(join(root, 'apps/ui/package.json'));
const { chromium } = require('playwright-core');
const scratch = mkdtempSync(join(tmpdir(), 'krama-catalog-browser-'));
const output = process.env.KRAMA_BROWSER_OUTPUT ?? join(scratch, 'screenshots');
mkdirSync(output, { recursive: true });
const git = new Git({ isolated: true });
const url = join(scratch, 'remote.git');
const work = join(scratch, 'work');
mkdirSync(work);
const identity = {
  GIT_AUTHOR_NAME: 'Browser Test',
  GIT_AUTHOR_EMAIL: 'browser@example.com',
  GIT_COMMITTER_NAME: 'Browser Test',
  GIT_COMMITTER_EMAIL: 'browser@example.com',
};
const token = 'catalog-browser-local-test-token';
let krama, app, vite, browser;
const errors = [];
try {
  await git.run(['init', '-q', '--bare', '-b', 'main', url]);
  await git.run(['init', '-q', '-b', 'main'], { cwd: work });
  const commit = async (version) => {
    mkdirSync(join(work, 'reviewer'), { recursive: true });
    mkdirSync(join(work, 'notes'), { recursive: true });
    writeFileSync(
      join(work, 'reviewer/config.json'),
      JSON.stringify({
        agentCard: {
          name: 'Careful reviewer',
          description: 'Reviews a draft before publication.',
          skills: [{ id: 'review', name: 'Review', description: 'Review a draft.' }],
        },
        claude: { model: `model-${version}` },
        mcp: {
          service: {
            type: 'http',
            url: 'https://svc.example/mcp',
            headers: { Authorization: 'Bearer ${SVC_TOKEN}' },
          },
        },
      }),
    );
    writeFileSync(
      join(work, 'notes/krama-pack.yaml'),
      `name: notes\nversion: ${version}\ndescription: A review team from a Git source.\nengine: ">=0.1.0"\norchestrator: reviewer\nagents:\n  reviewer:\n    git: "${url.replaceAll('\\', '/')}@main#reviewer"\n    secrets: { SVC_TOKEN: service-token }\n`,
    );
    await git.run(['add', '-A'], { cwd: work });
    await git.run(['commit', '-q', '-m', `Version ${version}`], { cwd: work, env: identity });
    await git.run(['push', '-q', url, 'main'], { cwd: work });
    return git.text(['rev-parse', 'HEAD'], { cwd: work });
  };
  const first = await commit('0.1.0');
  const home = join(scratch, 'home');
  mkdirSync(home);
  krama = await createKrama({
    home,
    packs: [],
    definitions: [],
    engineVersion: '0.3.0',
    sources: { git },
  });
  app = await buildApi({
    krama,
    config: loadConfig({ argv: ['--home', home, '--token', token, '--port', '0'], env: {} }),
    autoStartRuns: false,
    validateResponses: true,
  });
  const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const vitePath = join(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  const port = process.env.KRAMA_BROWSER_PORT ?? '5189';
  const uiUrl = `http://127.0.0.1:${port}`;
  vite = spawn(
    process.execPath,
    [vitePath, '--host', '127.0.0.1', '--port', port, '--strictPort'],
    {
      cwd: join(root, 'apps/ui'),
      env: { ...process.env, KRAMA_API: apiUrl, VITE_KRAMA_DEMO: '', VITE_KRAMA_API: '/api/v1' },
      stdio: 'ignore',
    },
  );
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(uiUrl)).ok) break;
    } catch {
      /* waiting for Vite */
    }
    if (i >= 100 || vite.exitCode !== null) throw new Error('UI server did not start');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : { channel: 'chrome' }),
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((value) => localStorage.setItem('krama.token', value), token);
  const screenshot = async (name) => {
    await page.locator('main').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
  };
  const visible = async (locator) => locator.waitFor({ state: 'visible', timeout: 20_000 });
  const allow = async (button) => {
    await visible(page.getByRole('heading', { name: 'Review access' }));
    const boxes = page.getByRole('checkbox');
    assert.ok((await boxes.count()) > 0, 'The source must request consent');
    assert.equal(await button.isEnabled(), false, 'Install must wait for consent');
    for (const box of await boxes.all()) await box.check();
    assert.equal(await button.isEnabled(), true);
  };
  const source = async (kind, path) => {
    await page.getByLabel('Repository URL', { exact: true }).fill(url);
    await page.getByLabel('Git ref', { exact: true }).fill('main');
    await page.getByLabel('Path in repository', { exact: true }).fill(path);
    if (kind === 'agent') {
      await page.getByLabel('Agent ID', { exact: true }).fill('reviewer/default');
      await page.getByRole('button', { name: 'Add binding', exact: true }).click();
      await page.getByLabel('Variable 1', { exact: true }).fill('SVC_TOKEN');
      await page.getByLabel('Secret reference 1', { exact: true }).fill('service-token');
    }
    await page.getByRole('button', { name: `Preview ${kind}`, exact: true }).click();
  };
  await page.goto(`${uiUrl}/packs`);
  await page.getByRole('button', { name: 'Add pack', exact: true }).click();
  await source('pack', 'notes');
  await allow(page.getByRole('button', { name: 'Install pack', exact: true }));
  await screenshot('pack-consent-desktop');
  await page.getByRole('button', { name: 'Install pack', exact: true }).click();
  await visible(page.getByRole('heading', { name: 'Version history' }));
  await screenshot('pack-detail-desktop');
  await page.getByRole('button', { name: 'Disable pack', exact: true }).click();
  await visible(page.getByRole('button', { name: 'Enable pack', exact: true }));
  await page.getByRole('button', { name: 'Enable pack', exact: true }).click();
  await visible(page.getByRole('button', { name: 'Disable pack', exact: true }));
  const next = await commit('0.2.0');
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await page.getByRole('button', { name: 'Preview update', exact: true }).click();
  await allow(page.getByRole('button', { name: 'Apply reviewed update', exact: true }));
  await page.getByRole('button', { name: 'Apply reviewed update', exact: true }).click();
  await visible(page.getByText('v0.2.0', { exact: true }));
  await page.getByRole('button', { name: 'Restore 0.1.0', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm restore', exact: true }).click();
  await visible(page.getByText('v0.1.0', { exact: true }));
  await page.goto(`${uiUrl}/agents`);
  await page.getByRole('button', { name: 'Add agent', exact: true }).click();
  await source('agent', 'reviewer');
  await allow(page.getByRole('button', { name: 'Install agent', exact: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('agent-consent-mobile');
  await page.getByRole('button', { name: 'Install agent', exact: true }).click();
  await visible(page.getByRole('heading', { name: 'Capabilities and tools' }));
  await screenshot('agent-detail-mobile');
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'Mobile page must fit the viewport',
  );
  await commit('0.3.0');
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await page.getByRole('button', { name: 'Preview update', exact: true }).click();
  await allow(page.getByRole('button', { name: 'Apply reviewed update', exact: true }));
  await page.getByRole('button', { name: 'Apply reviewed update', exact: true }).click();
  await visible(page.getByText('model-0.3.0', { exact: true }));
  await page.getByRole('button', { name: `Restore ${next.slice(0, 12)}`, exact: true }).click();
  await page.getByRole('button', { name: 'Confirm restore', exact: true }).click();
  await visible(page.getByText('model-0.2.0', { exact: true }));
  await page.getByRole('button', { name: 'Remove agent', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await visible(page.getByRole('heading', { name: 'No agents yet' }));
  await page.goto(`${uiUrl}/packs/pack_notes`);
  await page.getByRole('button', { name: 'Remove pack', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await visible(page.getByRole('heading', { name: 'No packs yet' }));
  assert.deepEqual(errors, [], 'No browser exceptions');
  console.log(
    JSON.stringify(
      {
        passed: true,
        first,
        next,
        screenshots: output,
        checks: [
          'pack install/consent/update/rollback/disable/enable/remove',
          'agent install/secret bindings/update/rollback/remove',
          'mobile overflow',
          'browser exceptions',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  vite?.kill();
  await app?.close();
  await krama?.close();
  // Screenshots remain available for visual inspection; credentials and registries do not.
  for (const name of ['home', 'work', 'remote.git'])
    rmSync(join(scratch, name), { recursive: true, force: true });
}
