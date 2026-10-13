/** One thing wrong (or worth knowing) about a pack, with the path in the pack that causes it. */
export interface PackIssue {
  severity: 'error' | 'warning';
  /** A stable name for the kind of problem, for tools and tests. */
  code: string;
  /** Where in the pack, e.g. `agents.reviewer.subAgents[0].agent`. */
  path: string;
  message: string;
}

export const error = (code: string, path: string, message: string): PackIssue => ({
  severity: 'error',
  code,
  path,
  message,
});

export const warning = (code: string, path: string, message: string): PackIssue => ({
  severity: 'warning',
  code,
  path,
  message,
});

export const hasErrors = (issues: readonly PackIssue[]): boolean =>
  issues.some((i) => i.severity === 'error');
