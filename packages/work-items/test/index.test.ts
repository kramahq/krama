import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('@kramahq/work-items', () => {
  it('loads', () => {
    expect(PACKAGE_NAME).toBe('@kramahq/work-items');
  });
});
