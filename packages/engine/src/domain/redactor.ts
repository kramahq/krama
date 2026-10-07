/**
 * Masks secrets before anything is hashed or stored. Two kinds of rule: **values** the platform knows are secret (the
 * tokens it issued, a resolved secret) and **patterns** for secrets it does not know about (an API key an agent printed
 * in a tool result). Redaction runs before the hash, so the chain stays verifiable and the secret is not in it.
 */
export interface RedactionResult<T> {
  value: T;
  /** The rules that matched, once each. Empty when nothing was masked. */
  rules: string[];
}

interface Pattern {
  name: string;
  re: RegExp;
}

/** Shapes of credentials that are safe to recognise by form. Kept narrow: a false match hides ordinary text. */
const PATTERNS: readonly Pattern[] = [
  {
    name: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { name: 'bearer-token', re: /\b(Bearer)\s+[A-Za-z0-9\-._~+/]{16,}=*/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: 'api-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'krama-token', re: /\bkrm_[a-z]{2,4}_[A-Za-z0-9_-]{16,}\b/g },
];

/** A secret shorter than this would also match ordinary words, so it is not registered as a value. */
const MIN_VALUE_LENGTH = 8;

const mask = (name: string) => `[REDACTED:${name}]`;

export class Redactor {
  private readonly values = new Map<string, string>();

  /** Registers a secret value to mask wherever it appears, under a label that names what it was. */
  addValue(value: string | undefined, label = 'secret'): void {
    if (value && value.length >= MIN_VALUE_LENGTH) this.values.set(value, label);
  }

  /** Forgets a registered value (a token that was revoked). */
  removeValue(value: string): void {
    this.values.delete(value);
  }

  get size(): number {
    return this.values.size;
  }

  text(s: string, hit: Set<string>): string {
    let out = s;
    for (const [value, label] of this.values) {
      if (out.includes(value)) {
        out = out.split(value).join(mask(label));
        hit.add(label);
      }
    }
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      if (p.re.test(out)) {
        p.re.lastIndex = 0;
        out = out.replace(p.re, (...m: string[]) =>
          p.name === 'bearer-token' ? `${m[1]} ${mask(p.name)}` : mask(p.name),
        );
        hit.add(p.name);
      }
    }
    return out;
  }

  /** A copy of `value` with every string masked, in arrays, objects and object keys' values. The input is not changed. */
  redact<T>(value: T): RedactionResult<T> {
    const hit = new Set<string>();
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return this.text(v, hit);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        if (v instanceof Uint8Array) return v;
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
        return out;
      }
      return v;
    };
    return { value: walk(value) as T, rules: [...hit].sort() };
  }
}
