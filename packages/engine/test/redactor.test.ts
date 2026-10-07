import { describe, expect, it } from 'vitest';
import { Redactor } from '../src/index.js';

describe('Redactor', () => {
  it('masks a registered value wherever it appears, and says which rule fired', () => {
    const r = new Redactor();
    r.addValue('s3cr3t-value-123', 'event-token');
    const { value, rules } = r.redact({
      a: 'token is s3cr3t-value-123 here',
      b: ['x', { c: 's3cr3t-value-123s3cr3t-value-123' }],
      n: 5,
      ok: true,
      none: null,
    });
    expect(JSON.stringify(value)).not.toContain('s3cr3t-value-123');
    expect(value.a).toBe('token is [REDACTED:event-token] here');
    expect(rules).toEqual(['event-token']);
    expect(value.n).toBe(5);
    expect(value.none).toBeNull();
  });

  it('recognises credentials by their shape', () => {
    const r = new Redactor();
    const cases: [string, string][] = [
      ['Authorization: Bearer abcdefghijklmnop0123456789', 'bearer-token'],
      ['key sk-abcdefghijklmnopqrstuvwx', 'api-key'],
      ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'github-token'],
      ['AKIAABCDEFGHIJKLMNOP', 'aws-access-key'],
      ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', 'jwt'],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----', 'private-key'],
      ['krm_evt_AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'krama-token'],
    ];
    for (const [text, rule] of cases) {
      const { value, rules } = r.redact({ text });
      expect(rules, text).toEqual([rule]);
      expect(value.text).toContain(`[REDACTED:${rule}]`);
    }
    // The word "Bearer" itself stays, so the line still reads.
    expect(r.redact('Authorization: Bearer abcdefghijklmnop0123456789').value).toBe(
      'Authorization: Bearer [REDACTED:bearer-token]',
    );
  });

  it('leaves ordinary text, short strings and binary alone', () => {
    const r = new Redactor();
    r.addValue('short', 'too-short-to-register');
    expect(r.size).toBe(0);
    const bytes = new Uint8Array([1, 2, 3]);
    const input = { t: 'a normal sentence with the word short and Bearer of news', bytes };
    const out = r.redact(input);
    expect(out.rules).toEqual([]);
    expect(out.value.t).toBe(input.t);
    expect(out.value.bytes).toBe(bytes);
  });

  it('does not change its input and can forget a value', () => {
    const r = new Redactor();
    r.addValue('abcdefghij-token', 'tok');
    const input = { x: 'abcdefghij-token' };
    r.redact(input);
    expect(input.x).toBe('abcdefghij-token');
    r.removeValue('abcdefghij-token');
    expect(r.redact(input).rules).toEqual([]);
  });

  it('can be used twice in a row: the patterns carry no state between calls', () => {
    const r = new Redactor();
    const t = 'key sk-abcdefghijklmnopqrstuvwx';
    expect(r.redact(t).rules).toEqual(['api-key']);
    expect(r.redact(t).rules).toEqual(['api-key']);
  });
});
