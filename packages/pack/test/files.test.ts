import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withAbsolutePaths } from '../src/index.js';

describe('withAbsolutePaths', () => {
  const dir = resolve('/packs/sdlc');
  const config = {
    agentCard: { name: 'a' },
    memory: {
      instructions: './agents/a/memory/instructions.md',
      skills: ['./agents/a/memory/skills/x', resolve('/elsewhere/skill')],
    },
  };

  it('makes the file paths absolute against the directory they were written for, leaving the rest alone', () => {
    const out = withAbsolutePaths(config, dir) as typeof config;
    expect(out.memory.instructions).toBe(resolve(dir, 'agents/a/memory/instructions.md'));
    expect(out.memory.skills).toEqual([
      resolve(dir, 'agents/a/memory/skills/x'),
      resolve('/elsewhere/skill'),
    ]);
    expect(out.agentCard).toEqual({ name: 'a' });
  });

  it('does not change its input, and passes a config without files through', () => {
    withAbsolutePaths(config, dir);
    expect(config.memory.instructions).toBe('./agents/a/memory/instructions.md');
    const plain = { agentCard: {}, claude: {} };
    expect(withAbsolutePaths(plain, dir)).toBe(plain);
  });
});
