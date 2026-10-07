#!/usr/bin/env node
/**
 * A scripted stand-in for an A2A wrapper, started by the runtime exactly like a real one:
 *   node agent.js --config <file> --port <n> --hostname <h> --advertise-host <h>
 * Which persona it plays comes from the `script` option in the config's provider section. No model is involved, so the
 * walking skeleton is deterministic and free. The orchestrator persona follows the same protocol a real orchestrator
 * does: it calls Krama's MCP tools, and reaches workers either through `delegate_to_agent` or, in `native` mode,
 * directly over A2A using the `subAgents` list Krama generated for it.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

type Json = Record<string, unknown>;

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const config = JSON.parse(readFileSync(arg('--config')!, 'utf8')) as Json;
const port = Number(arg('--port'));
const host = arg('--hostname') ?? '127.0.0.1';
const section = (config.demo ?? {}) as Json;
const script = String(section.script ?? 'worker');
const agentName = String((config.agentCard as Json | undefined)?.name ?? script);
const events = (config.events ?? {}) as {
  transport?: string;
  httpUrl?: string;
  httpHeaders?: Record<string, string>;
};

/**
 * What a real wrapper does when `events.transport` is `http`: POST each event to the sink, best effort. The agent never
 * fails because the sink is down.
 */
async function emit(eventType: string, data: Json): Promise<void> {
  if (events.transport !== 'http' || !events.httpUrl) return;
  try {
    await fetch(events.httpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(events.httpHeaders ?? {}) },
      body: JSON.stringify({
        eventId: `ev_${Math.random().toString(36).slice(2)}${Date.now()}`,
        eventType,
        agentId: agentName.toLowerCase(),
        agentName,
        timestamp: new Date().toISOString(),
        data,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* best effort */
  }
}

// ---- personas ---------------------------------------------------------------------------------

interface Reply {
  text: string;
  tokens: { input: number; output: number };
}

let drafts = 0;
let reviews = 0;

function author(task: string): Reply {
  drafts += 1;
  const fix = /changes requested[:\s]+(.+)/is.exec(task)?.[1]?.trim();
  return {
    text: `Release notes, draft ${drafts}.${fix ? ` Revised to address: ${fix.slice(0, 120)}` : ''}`,
    tokens: { input: 120, output: 80 },
  };
}

function reviewer(): Reply {
  reviews += 1;
  return {
    text:
      reviews === 1
        ? 'CHANGES REQUESTED: add a one-line summary at the top.'
        : 'APPROVED: reads well and covers the changes.',
    tokens: { input: 150, output: 40 },
  };
}

const textOf = (result: Json | undefined): string => {
  const artifacts = ((result?.task as Json | undefined)?.artifacts ?? []) as Json[];
  return artifacts
    .flatMap((a) => (a.parts ?? []) as Json[])
    .map((p) => String(p.text ?? ''))
    .join('');
};

/** What an A2A sub-agent tool does: send one message to a worker and wait for the finished task. */
async function callWorker(agentCardUrl: string, text: string): Promise<string> {
  const base = new URL(agentCardUrl).origin;
  const res = await fetch(`${base}/a2a/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: {
        message: {
          messageId: `m_${Date.now()}`,
          role: 'ROLE_USER',
          parts: [{ text, mediaType: 'text/plain' }],
        },
      },
    }),
  });
  const body = (await res.json()) as { result?: Json; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return textOf(body.result);
}

type Trace = (tool: string) => void;

async function orchestrator(trace: Trace): Promise<Reply> {
  const mcp = (config.mcp as Json | undefined)?.krama as { url: string } | undefined;
  const token = process.env.KRAMA_MCP_TOKEN;
  if (!mcp || !token) throw new Error('The orchestrator needs the Krama MCP endpoint and token');
  const client = new Client({ name: 'demo-orchestrator', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const call = async (name: string, args: Json = {}): Promise<Json> => {
    trace(name);
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]?.text ?? '{}';
    const body = JSON.parse(text) as Json;
    if (r.isError) throw new Error(`${name} failed: ${text}`);
    return body;
  };
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    const relay = names.includes('delegate_to_agent');
    const subAgents = ((config.subAgents as Json | undefined)?.agents ?? []) as {
      name: string;
      agentCardUrl: string;
    }[];
    const say: string[] = [`delegation: ${relay ? 'krama relay' : 'native sub-agents'}`];
    let lastDraft = '';
    let feedback = '';
    for (let guard = 0; guard < 12; guard++) {
      const run = (await call('get_run')) as {
        status: string;
        currentPhaseIds: string[];
        phases: { id: string; roles: string[] }[];
      };
      if (run.status !== 'running') {
        say.push(`run is ${run.status}`);
        break;
      }
      const phaseId = run.currentPhaseIds[0];
      const phase = run.phases.find((p) => p.id === phaseId);
      if (!phase) break;
      const role = phase.roles[0]!;
      const evaluating = phase.id === 'review';
      const task = evaluating
        ? `Review this draft and say APPROVED or CHANGES REQUESTED:\n${lastDraft}`
        : `Write the release notes.${feedback ? ` Changes requested: ${feedback}` : ''}`;

      let answer: string;
      if (relay) {
        answer = String(
          (await call('delegate_to_agent', { phaseId: phase.id, role, task })).answer ?? '',
        );
      } else {
        const target = subAgents.find((a) => a.name === role);
        if (!target) throw new Error(`No sub-agent configured for ${role}`);
        trace(`${role} (sub-agent)`);
        answer = await callWorker(target.agentCardUrl, task);
      }
      say.push(`${role}: ${answer.slice(0, 70)}`);

      if (evaluating && /CHANGES REQUESTED/i.test(answer)) {
        feedback = answer;
        await call('record_phase_outcome', {
          phaseId: phase.id,
          status: 'partial',
          reason: 'The reviewer asked for changes',
          gating: 'loop_back',
          loopTarget: 'draft',
          feedback: answer,
        });
      } else {
        if (!evaluating) lastDraft = answer;
        await call('record_phase_outcome', {
          phaseId: phase.id,
          status: 'success',
          reason: evaluating ? 'The reviewer approved' : 'Draft delivered',
          gating: 'continue',
        });
      }
    }
    return { text: say.join('\n'), tokens: { input: 400, output: 160 } };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function reply(text: string, trace: Trace): Promise<Reply> {
  if (script === 'orchestrator') return orchestrator(trace);
  const out = script === 'reviewer' ? reviewer() : author(text);
  // Report the way a wrapper does: the work, then the end of the turn with its usage.
  await emit('tool_call_start', { toolName: 'compose' });
  await emit('tool_call_end', { toolName: 'compose', isError: false, durationMs: 1 });
  await emit('agent_finished', {
    usage: { inputTokens: out.tokens.input, outputTokens: out.tokens.output, llmCalls: 1 },
  });
  return out;
}

// ---- A2A server -------------------------------------------------------------------------------

const rpc = (id: unknown, result: unknown) => JSON.stringify({ jsonrpc: '2.0', id, result });
const usage = (t: Reply['tokens']) => ({
  'x-usage': { inputTokens: t.input, outputTokens: t.output, llmCalls: 1 },
});
const read = async (req: IncomingMessage) => {
  let raw = '';
  for await (const c of req) raw += c;
  return raw;
};

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/.well-known/agent-card.json')
    return json(200, {
      name: agentName,
      description: `Scripted ${script} agent for the demo`,
      version: '1.0.0',
      capabilities: { streaming: true },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [{ id: 'work', name: agentName, description: `Does the ${script} job`, tags: [] }],
      supportedInterfaces: [
        {
          url: `http://${host}:${port}/a2a/jsonrpc`,
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
          tenant: '',
        },
      ],
    });
  if (req.method !== 'POST' || req.url !== '/a2a/jsonrpc') return json(404, { error: 'not found' });

  const body = JSON.parse(await read(req)) as { id: unknown; method: string; params?: Json };
  if (body.method === 'CancelTask')
    return json(
      200,
      JSON.parse(
        rpc(body.id, { id: (body.params as Json).id, status: { state: 'TASK_STATE_CANCELED' } }),
      ),
    );

  const message = (body.params?.message ?? {}) as Json;
  const text = ((message.parts ?? []) as Json[]).map((p) => String(p.text ?? '')).join('');
  const taskId = `task_${Math.random().toString(36).slice(2, 10)}`;
  const contextId = String(message.contextId ?? `ctx_${script}`);
  const artifact = (t: string) => ({
    artifactId: `${taskId}_out`,
    name: 'response',
    parts: [{ text: t, mediaType: 'text/plain' }],
  });
  const streaming = body.method !== 'SendMessage';
  const frame = (r: unknown) => res.write(`data: ${rpc(body.id, r)}\n\n`);
  if (streaming) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    frame({
      statusUpdate: { taskId, contextId, status: { state: 'TASK_STATE_WORKING' } },
    });
  }
  // Tool calls become `trace.mcp.start` sideband artifacts, the way a real wrapper reports them.
  const trace: Trace = (tool) => {
    if (!streaming) return;
    frame({
      artifactUpdate: {
        taskId,
        contextId,
        artifact: {
          artifactId: `${taskId}_trace_${Math.random().toString(36).slice(2, 6)}`,
          name: 'trace.mcp.start',
          parts: [{ data: { toolName: tool }, mediaType: 'application/json' }],
        },
        lastChunk: true,
      },
    });
  };
  let out: Reply;
  try {
    out = await reply(text, trace);
  } catch (e) {
    const status = {
      state: 'TASK_STATE_FAILED',
      message: {
        messageId: `${taskId}_err`,
        role: 'ROLE_AGENT',
        parts: [{ text: (e as Error).message, mediaType: 'text/plain' }],
      },
    };
    if (streaming) {
      frame({ statusUpdate: { taskId, contextId, status } });
      return void res.end();
    }
    return json(200, JSON.parse(rpc(body.id, { task: { id: taskId, contextId, status } })));
  }

  if (!streaming)
    return json(
      200,
      JSON.parse(
        rpc(body.id, {
          task: {
            id: taskId,
            contextId,
            status: { state: 'TASK_STATE_COMPLETED' },
            artifacts: [artifact(out.text)],
            metadata: usage(out.tokens),
          },
        }),
      ),
    );

  frame({
    artifactUpdate: { taskId, contextId, artifact: artifact(out.text), lastChunk: true },
  });
  frame({
    statusUpdate: {
      taskId,
      contextId,
      status: { state: 'TASK_STATE_COMPLETED' },
      metadata: usage(out.tokens),
    },
  });
  res.end();
}

createServer((req, res) => {
  handle(req, res).catch((e: unknown) => {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(e));
  });
}).listen(port, host, () => console.log(`demo agent "${script}" listening on ${host}:${port}`));
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => process.exit(0));
