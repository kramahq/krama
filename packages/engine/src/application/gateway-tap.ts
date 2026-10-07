import type { GatewayTap, Transcript } from '../ports/index.js';

/**
 * A gateway tap that writes everything Krama sends to an agent and everything it gets back to the run's transcript, as the
 * protocol carried it. It does not wait for the write (so a stream is not slowed) and the transcript keeps the order.
 * An exchange with no run (reading an agent card, a health probe) is not a run's business and is not recorded here.
 */
export function createGatewayTap(transcript: Transcript): GatewayTap {
  return (e) => {
    const runId = e.correlation?.runId;
    if (!runId) return;
    if (e.direction === 'out' && e.kind === 'request') transcript.noteActivity(runId, e.agent.id);
    void transcript
      .record({
        runId,
        actor:
          e.direction === 'out'
            ? { type: 'system', id: 'krama-gateway' }
            : { type: 'agent', id: e.agent.id, instanceId: e.agent.id, role: e.agent.role },
        kind:
          e.kind === 'frame' ? 'a2a.frame' : e.kind === 'request' ? 'a2a.request' : `a2a.${e.kind}`,
        source: 'gateway-tap',
        sourceEventId: `tap:${e.callId}:${e.index}`,
        ...(e.correlation?.phaseId ? { phaseId: e.correlation.phaseId } : {}),
        ...(e.correlation?.stepId ? { stepId: e.correlation.stepId } : {}),
        payload: {
          direction: e.direction,
          agent: { id: e.agent.id, role: e.agent.role, backend: e.agent.backend },
          callId: e.callId,
          body: e.body,
        },
      })
      .catch(() => undefined);
  };
}
