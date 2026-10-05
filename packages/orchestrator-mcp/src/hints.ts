/** One agent a caller may use, as it is described in that caller's prompt. */
export interface AgentLine {
  id: string;
  description?: string | undefined;
  /** When to use it, from the pack. Guidance only: what the caller can actually reach is set by its `subAgents` config. */
  hint?: string | undefined;
}

const sentence = (s: string) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/** The section appended to a caller's system prompt (PACK-FORMAT section 6). Empty when the agent calls nobody. */
export function renderAgentsSection(lines: readonly AgentLine[]): string {
  if (lines.length === 0) return '';
  const items = lines.map((l) => {
    const parts = [
      l.description?.trim() ? sentence(l.description) : '',
      l.hint?.trim() ? `When to use: ${sentence(l.hint)}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    return parts ? `- ${l.id}: ${parts}` : `- ${l.id}`;
  });
  return `## Agents you can call\n${items.join('\n')}`;
}
