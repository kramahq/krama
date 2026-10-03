import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('@kramahq/agents', () => {
  it('loads', () => {
    expect(PACKAGE_NAME).toBe('@kramahq/agents');
  });
});
