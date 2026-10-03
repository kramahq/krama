import { defineConfig } from 'vitest/config';

// Embedded Postgres (WASM) starts slowly on some CI runners, notably Windows, so allow generous timeouts.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } });
