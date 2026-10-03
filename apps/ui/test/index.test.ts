import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('@kramahq/ui', () => {
  it('loads', () => {
    expect(PACKAGE_NAME).toBe('@kramahq/ui');
  });
});
