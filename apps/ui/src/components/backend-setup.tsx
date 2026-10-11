import type { Pack } from '@kramahq/contract';
import { useAgentDefinitions, useBackends } from '@/api/queries';
import { agentSetup } from '@/lib/agent-setup';
import { Card } from './ui/primitives';

/** Descriptor data is configuration. It must not be shown as an installation or authentication check. */
export function BackendSetup({ pack }: { pack: Pack }) {
  const backends = useBackends();
  const definitions = useAgentDefinitions();
  const required = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const agent = pack.agents?.[id];
    const setup = agentSetup(agent, backends.data?.items ?? [], definitions.data?.items ?? []);
    if (setup.backend) required.add(setup.backend);
    agent?.subAgents?.forEach((child) => visit(child.agent));
  };
  if (pack.orchestrator) visit(pack.orchestrator);
  return (
    <Card className="p-4">
      <h2 className="m-0 text-sm font-medium">Local backend setup</h2>
      <p className="mt-1 text-xs text-ink3">
        Install wrappers on the server machine. Installation and sign-in have not been checked here.
      </p>
      {required.size > 0 ? (
        <ul className="m-0 list-none space-y-3 p-0">
          {[...required].map((id) => {
            const backend = backends.data?.items.find((b) => b.id === id);
            return (
              <li key={id} className="text-xs text-ink2">
                <div className="font-medium">
                  {backend?.label ?? id}
                  <span className="ml-1 font-mono text-ink3">
                    {backend?.package.minVersion ? ` · ${backend.package.minVersion}` : ''}
                  </span>
                </div>
                {backend?.package.install && (
                  <code className="mt-1 block break-all text-ink3">{backend.package.install}</code>
                )}
                {backend?.providerKey === 'codex' && (
                  <p className="mt-1 mb-0">Existing Codex subscription login can be used.</p>
                )}
                {backend?.providerKey === 'copilot' && (
                  <p className="mt-1 mb-0">Existing GitHub Copilot authentication can be used.</p>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mb-0 text-xs text-ink3">
          Backend requirements will be resolved from this pack’s agent sources.
        </p>
      )}
    </Card>
  );
}
