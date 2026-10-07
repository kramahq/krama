import type { AgentCard } from '@a2a-js/sdk';

export interface CardIssue {
  severity: 'warning' | 'info';
  code: string;
  message: string;
}

export interface CardReport {
  /** The interfaces the card advertises, as the gateway sees them. */
  interfaces: { binding: string; version: string; url: string }[];
  /** The one the gateway will use, if any. */
  selected?: { binding: string; version: string; url: string };
  streaming: boolean;
  skills: number;
  issues: CardIssue[];
}

const brief = (i: AgentCard['supportedInterfaces'][number]) => ({
  binding: i.protocolBinding,
  version: i.protocolVersion,
  url: i.url,
});

/**
 * An advisory view of an agent card: what it advertises and what would get in the way. It never blocks a call. A
 * strict check would turn away agents that work fine, so problems are reported for a person to judge.
 */
export function reportCard(card: AgentCard, selectedUrl?: string): CardReport {
  const interfaces = card.supportedInterfaces.map(brief);
  const issues: CardIssue[] = [];
  const warn = (code: string, message: string) =>
    issues.push({ severity: 'warning', code, message });
  if (!card.name) warn('name-missing', 'The card has no name.');
  if (!card.description)
    issues.push({
      severity: 'info',
      code: 'description-missing',
      message: 'The card has no description.',
    });
  if (!card.version) warn('version-missing', 'The card has no version.');
  if (!interfaces.length) warn('no-interfaces', 'The card advertises no interface to call.');
  else {
    if (!interfaces.some((i) => /^1\./.test(i.version)))
      warn(
        'legacy-only',
        'The agent advertises only a 0.3 interface; calls go through the compatibility layer.',
      );
    if (!interfaces.some((i) => /^(jsonrpc|http\+json)$/i.test(i.binding)))
      warn(
        'no-supported-binding',
        'No JSON-RPC or HTTP+JSON interface is advertised (gRPC is not used).',
      );
  }
  if (!card.capabilities?.streaming)
    issues.push({
      severity: 'info',
      code: 'no-streaming',
      message: 'Streaming is not advertised; each call returns once.',
    });
  if (!card.skills?.length)
    issues.push({
      severity: 'info',
      code: 'no-skills',
      message: 'The card lists no skills, so it cannot be matched by capability.',
    });
  const selected = selectedUrl ? interfaces.find((i) => i.url === selectedUrl) : undefined;
  return {
    interfaces,
    ...(selected ? { selected } : {}),
    streaming: Boolean(card.capabilities?.streaming),
    skills: card.skills?.length ?? 0,
    issues,
  };
}
