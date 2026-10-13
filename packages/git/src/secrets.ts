/** Things that are credentials by their shape. A pack or an agent never carries one: it names a variable and binds it. */
const SHAPES: { re: RegExp; what: string }[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'a private key' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}/, what: 'an API key' },
  { re: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/, what: 'a GitHub token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'an AWS access key' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, what: 'a Slack token' },
  { re: /\bBearer\s+(?!\$\{)[A-Za-z0-9._~+/=-]{20,}/, what: 'a bearer token' },
];

export interface SecretFinding {
  path: string;
  line: number;
  what: string;
}

/** The credentials in a text file, by file and line. The value itself is never part of a finding. */
export function scanText(path: string, text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++)
    for (const s of SHAPES)
      if (s.re.test(lines[i]!)) {
        out.push({ path, line: i + 1, what: s.what });
        break;
      }
  return out;
}

/** A buffer that is not text (a NUL byte in its start) is not scanned. */
export const looksBinary = (b: Uint8Array): boolean => b.subarray(0, 8000).includes(0);
