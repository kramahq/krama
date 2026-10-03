import type { AgentDefinition, RosterEntry } from '@kramahq/contract';
import { DomainError } from './errors.js';
import { matchDefinitions, type Candidate } from './matching.js';

export interface ResolvedRole {
  role: string;
  definition: AgentDefinition;
  /** Backend to run on. Differs from the definition's own when the roster pins another backend. */
  backend: string;
  count: number;
  /** Other usable definitions, best first, for fallback or a person to choose. */
  alternatives: Candidate[];
}

export interface RosterResolution {
  resolved: ResolvedRole[];
  /** Optional roles that could not be filled. */
  skipped: { role: string; reason: string }[];
}

export interface RosterContext {
  /** Whether a backend can be used right now (registered, allowed, healthy enough to try). */
  backendUsable: (backend: string) => boolean;
}

/**
 * Turns a pack roster into concrete agents. A `definitionId` pins the definition (a `backend` then overrides where it runs);
 * otherwise the best-ranked usable candidate wins. A required role nobody can fill fails the whole resolution
 * with `roster_unsatisfied`, listing every unfilled role at once.
 */
export function resolveRoster(
  roster: readonly RosterEntry[],
  defs: readonly AgentDefinition[],
  ctx: RosterContext,
): RosterResolution {
  const resolved: ResolvedRole[] = [];
  const skipped: RosterResolution['skipped'] = [];
  const missing: { role: string; reason: string }[] = [];

  for (const entry of roster) {
    const { select } = entry;
    let chosen: Candidate | undefined;
    let alternatives: Candidate[] = [];
    let reason = '';

    if (select.definitionId) {
      const def = defs.find((d) => d.id === select.definitionId);
      const backend = select.backend ?? def?.backend.wrapper;
      if (!def) reason = `definition "${select.definitionId}" not found`;
      else if (!backend || !ctx.backendUsable(backend))
        reason = `backend "${backend}" is not available`;
      else {
        chosen = {
          definition: def,
          coverage: 1,
          backendMatch: Boolean(select.backend),
          costPerMTok: def.costHint?.perMillionTokens?.amount,
          reasons: ['definition:pinned'],
        };
        resolved.push({
          role: entry.role,
          definition: def,
          backend,
          count: entry.count ?? 1,
          alternatives: [],
        });
      }
    } else {
      const ranked = matchDefinitions(
        defs,
        {
          role: entry.role,
          ...(select.capabilities ? { capabilities: select.capabilities } : {}),
          ...(select.backend ? { backend: select.backend } : {}),
        },
        (d) => ctx.backendUsable(d.backend.wrapper),
      );
      // A pinned backend is a requirement for roster selection, not just a preference.
      const eligible = select.backend ? ranked.filter((c) => c.backendMatch) : ranked;
      chosen = eligible[0];
      alternatives = ranked.filter((c) => c !== chosen);
      if (!chosen)
        reason = ranked.length
          ? `no usable definition runs on ${select.backend}`
          : `no usable definition for role "${entry.role}"${select.capabilities?.length ? ` with ${select.capabilities.join(', ')}` : ''}`;
      else
        resolved.push({
          role: entry.role,
          definition: chosen.definition,
          backend: chosen.definition.backend.wrapper,
          count: entry.count ?? 1,
          alternatives,
        });
    }

    if (!chosen) (entry.optional ? skipped : missing).push({ role: entry.role, reason });
  }

  if (missing.length > 0) {
    throw new DomainError(
      'roster_unsatisfied',
      `Roster cannot be satisfied: ${missing.map((m) => `${m.role} (${m.reason})`).join('; ')}`,
      { missing },
    );
  }
  return { resolved, skipped };
}
