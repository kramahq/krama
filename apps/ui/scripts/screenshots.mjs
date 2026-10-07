// Takes screenshots of the screens against a running UI (and the mock behind it).
//   node scripts/screenshots.mjs <outDir> [baseUrl]
// Needs Chromium: set CHROME to its executable, or PLAYWRIGHT_BROWSERS_PATH to a Playwright cache.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const out = process.argv[2] ?? 'screenshots';
const base = process.argv[3] ?? 'http://127.0.0.1:5173';
mkdirSync(out, { recursive: true });

function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dir = existsSync(root)
    ? readdirSync(root).find((d) => /^chromium-\d+$/.test(d))
    : undefined;
  return dir ? join(root, dir, 'chrome-linux', 'chrome') : undefined;
}

// [file name, path, { theme, width, height, wait (selector), full }]
const SHOTS = JSON.parse(process.env.SHOTS ?? '[]');

const browser = await chromium.launch({ executablePath: chromePath(), args: ['--no-sandbox'] });
for (const [name, path, o = {}] of SHOTS) {
  const ctx = await browser.newContext({
    viewport: { width: o.width ?? 1440, height: o.height ?? 900 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('krama.theme', t);
    } catch {}
  }, o.theme ?? 'light');
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  // The live event stream is held open on purpose, so the network is never idle: wait for content instead.
  await page.goto(base + path, { waitUntil: 'load' });
  if (o.wait)
    await page
      .waitForSelector(o.wait, { timeout: 8000 })
      .catch(() => errors.push(`never saw ${o.wait}`));
  if (o.click)
    await page
      .click(o.click)
      .catch((e) => errors.push(`click ${o.click}: ${e.message.split('\n')[0]}`));
  await page.waitForTimeout(o.settle ?? 1200);
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: o.full ?? false });
  console.log(`${name}.png${errors.length ? `  ⚠ ${errors.slice(0, 2).join(' | ')}` : ''}`);
  await ctx.close();
}
await browser.close();
