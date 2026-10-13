import { defineConfig } from 'vitest/config';

// Every step is a real `git` process; on a slow Windows runner a multi-step flow takes more than the default 5 s.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 120_000 },
});
