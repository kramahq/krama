import type { AgentDefinition, BackendDescriptor, PackAgent } from '@kramahq/contract';
import { asObject } from './pack-inputs';
export type SetupDefinition = Pick<AgentDefinition, 'id' | 'backend'>;

/** Display declared configuration only. Registration does not prove installation, login or a running agent. */
export function agentSetup(
  agent: PackAgent | undefined,
  backends: BackendDescriptor[],
  definitions: SetupDefinition[],
) {
  if (agent?.config) {
    const matches = backends.filter((b) => Object.hasOwn(agent.config!, b.providerKey));
    const backend = matches.length === 1 ? matches[0] : undefined;
    let value: unknown = backend ? agent.config[backend.providerKey] : undefined;
    for (const key of backend?.mapping.model.split('.') ?? []) value = asObject(value)?.[key];
    return {
      source: 'Embedded config',
      backend: backend?.id,
      model: typeof value === 'string' ? value : undefined,
    };
  }
  if (agent?.definition) {
    const definition = definitions.find((d) => d.id === agent.definition);
    return {
      source: 'Registered agent',
      backend: definition?.backend.wrapper,
      model: definition?.backend.model,
    };
  }
  return {
    source: agent?.external
      ? 'External A2A agent'
      : agent?.git
        ? 'Git config'
        : 'Source unavailable',
    backend: undefined,
    model: undefined,
  };
}
