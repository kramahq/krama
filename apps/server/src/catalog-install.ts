import type { Pack, PermissionRequest } from '@kramahq/contract';

/** Why a catalogue install operation did not happen, in terms a route can map to a status. */
export class InstallError extends Error {
  constructor(
    readonly code:
      'not_found' | 'conflict' | 'invalid' | 'forbidden' | 'blocked' | 'engine_incompatible',
    message: string,
    readonly issues: { severity: 'warn' | 'error'; message: string; path?: string }[] = [],
  ) {
    super(message);
    this.name = 'InstallError';
  }
}

/** The source itself is something to allow when it is not on the trusted list: there is no admin to ask but the one installing. */
export function sourcePermission(
  src: { url: string; ref: string },
  trust: Pack['trust'],
): PermissionRequest[] {
  if (trust === 'trusted') return [];
  return [
    {
      id: `source:${src.url}`,
      kind: 'network',
      subject: src.url,
      risk: 'high',
      reason:
        'This source is not on the trusted list. What it contains runs with the access listed here.',
      requestedBy: 'source',
    },
  ];
}

/**
 * What a person said about what a pack asks for, checked: every permission is answered, none is made up, and nothing is
 * declined (a pack is installed with all it asks for or not at all). `already` is what an earlier version was allowed.
 * Returns what is allowed now, which is what the next update starts from.
 */
export function consentFor(
  asked: readonly PermissionRequest[],
  said: { granted: string[]; declined: string[] },
  already: ReadonlySet<string> = new Set(),
  kind: 'pack' | 'agent' = 'pack',
): { granted: string[]; declined: string[] } {
  const ids = new Set(asked.map((p) => p.id));
  const granted = new Set(said.granted);
  const unknown = [...said.granted, ...said.declined].filter((i) => !ids.has(i) && !already.has(i));
  if (unknown.length)
    throw new InstallError('invalid', `This ${kind} does not ask for: ${unknown.join(', ')}`);
  if (said.declined.length)
    throw new InstallError(
      'forbidden',
      `You declined ${said.declined.join(', ')}. An install requires everything it asks for, or not at all.`,
    );
  const open = asked.filter((p) => !already.has(p.id) && !granted.has(p.id));
  if (open.length)
    throw new InstallError(
      'invalid',
      `${open.length === 1 ? '1 permission has' : `${open.length} permissions have`} not been answered: ${open.map((p) => p.id).join(', ')}`,
    );
  return {
    granted: asked.filter((p) => already.has(p.id) || granted.has(p.id)).map((p) => p.id),
    declined: [],
  };
}
