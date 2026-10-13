/** Where an agent directory lives in git: a repository, a ref to resolve at install, and a directory inside it. */
export interface GitSource {
  url: string;
  ref: string;
  /** The agent directory (or its `config.json`) inside the repository; empty for the repository root. */
  path: string;
}

/**
 * `repo@ref#dir` (PACK-FORMAT §2.1). The repository may itself contain `@` (`git@host:org/repo.git`), so the ref is what
 * follows the **last** `@` before the `#`. A ref is required: an install pins a commit, and "whatever is current" is not
 * something a pack should say.
 */
export function parseGitSource(
  value: string | { url: string; ref?: string; path?: string },
): GitSource | { error: string } {
  if (typeof value !== 'string') {
    if (!value.url?.trim()) return { error: 'A git source needs a repository url' };
    if (!value.ref?.trim()) return { error: 'A git source needs a ref (a tag, branch or commit)' };
    return {
      url: value.url.trim(),
      ref: value.ref.trim(),
      path: (value.path ?? '').replace(/^\/+|\/+$/g, ''),
    };
  }
  const hash = value.indexOf('#');
  const head = hash === -1 ? value : value.slice(0, hash);
  const path = hash === -1 ? '' : value.slice(hash + 1);
  const at = head.lastIndexOf('@');
  if (at <= 0 || at === head.length - 1)
    return {
      error:
        'A git source is written repo@ref#dir, for example github.com/acme/agents@v1.2.0#workers/author',
    };
  return {
    url: head.slice(0, at).trim(),
    ref: head.slice(at + 1).trim(),
    path: path.replace(/^\/+|\/+$/g, ''),
  };
}

/** The same source written the one way a lockfile and a digest use. */
export const formatGitSource = (s: GitSource): string =>
  `${s.url}@${s.ref}${s.path ? `#${s.path}` : ''}`;
