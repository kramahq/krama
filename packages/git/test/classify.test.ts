import { describe, expect, it } from 'vitest';
import { classify } from '../src/git.js';

describe('classify', () => {
  it('reads a refused request as an authentication failure', () => {
    expect(
      classify("fatal: unable to access 'https://h/r.git/': The requested URL returned error: 403"),
    ).toBe('auth_failed');
    expect(classify('remote: Permission denied (publickey).')).toBe('auth_failed');
  });

  it('does not take a number inside a commit hash or a path for an HTTP status', () => {
    const sha = 'a1403f5c9d2e7b0a4c6e8f1a3b5d7c9e0f2a4b6c';
    expect(classify(`fatal: Not a valid object name ${sha}`)).toBe('failed');
    expect(classify('fatal: cannot open /tmp/run-403-x/.git/HEAD: failed')).toBe('failed');
  });
});
