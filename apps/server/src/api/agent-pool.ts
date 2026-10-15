import type { AgentPreviewRequest } from '@kramahq/contract';
import type { ApiRequest, Handlers } from './context.js';
import { toProblem } from './problems.js';
import { actorOf } from './work.js';

type Review = {
  previewId: string;
  manifestDigest: string;
  consent: { granted: string[]; declined: string[] };
};
const id = (req: ApiRequest): string => decodeURIComponent(req.params['id']!);

export function agentPoolHandlers(): Handlers {
  return {
    previewAgentDefinition: (req) =>
      req.ctx.operations.start(
        {
          type: 'agent_definition.preview',
          owner: req.principal.id,
          message: 'Fetching and checking the agent',
        },
        async () => {
          try {
            return { ...(await req.ctx.krama.agentPool.preview(req.body as AgentPreviewRequest)) };
          } catch (e) {
            throw toProblem(e, req.requestId);
          }
        },
      ),
    previewAgentDefinitionUpdate: (req) =>
      req.ctx.operations.start(
        {
          type: 'agent_definition.update.preview',
          owner: req.principal.id,
          message: 'Checking the agent update',
        },
        async () => {
          try {
            return {
              ...(await req.ctx.krama.agentPool.previewUpdate(
                id(req),
                (req.body ?? {}) as { ref?: string; secrets?: Record<string, string> },
              )),
            };
          } catch (e) {
            throw toProblem(e, req.requestId);
          }
        },
      ),
    installAgentDefinition: (req) =>
      req.ctx.krama.agentPool.install(req.body as Review, actorOf(req.principal)),
    updateAgentDefinition: (req) =>
      req.ctx.krama.agentPool.update(id(req), req.body as Review, actorOf(req.principal)),
    rollbackAgentDefinition: (req) =>
      req.ctx.krama.agentPool.rollback(
        id(req),
        (req.body as { sha: string }).sha,
        actorOf(req.principal),
        (req.body as { digest?: string }).digest,
      ),
    listAgentDefinitionVersions: (req) => ({ items: req.ctx.krama.agentPool.versions(id(req)) }),
    uninstallAgentDefinition: async (req, reply) => {
      await req.ctx.krama.agentPool.uninstall(id(req), actorOf(req.principal));
      reply.code(204);
      return undefined;
    },
  };
}
