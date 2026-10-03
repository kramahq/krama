import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('@kramahq/testing', () => {
  it('loads', () => {
    expect(PACKAGE_NAME).toBe('@kramahq/testing');
  });
});
