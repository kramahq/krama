import { defineConfig } from 'vitest/config';

// Tests start real child processes and servers; CI runners (notably Windows) can be slow.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
