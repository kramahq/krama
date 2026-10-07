#!/usr/bin/env node
import { ConfigError } from './api/config.js';
import { PolicyError } from './api/policy.js';
import { serve } from './serve.js';

try {
  const s = await serve({ argv: process.argv.slice(2) });
  console.log(`Krama API listening on ${s.url}/api/v1 (home ${s.config.home})`);
  console.log(`Policy: ${s.config.policySources.join(' < ')}`);
  if (s.config.tokenGenerated)
    console.log(`A new access token was written to ${s.config.home}/token`);
  const stop = () => void s.close().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (e) {
  if (e instanceof ConfigError || e instanceof PolicyError) {
    console.error(e.message);
    process.exit(2);
  }
  throw e;
}
