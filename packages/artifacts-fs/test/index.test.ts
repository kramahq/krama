import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('@kramahq/artifacts-fs', () => {
  it('loads', () => {
    expect(PACKAGE_NAME).toBe('@kramahq/artifacts-fs');
  });
});
