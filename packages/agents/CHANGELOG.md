# @kramahq/agents

## 0.3.1

### Patch Changes

- 7e54834: Report the A2A versions the gateway really speaks (1.0, with the 0.3 compatibility fallback) in the capabilities response. Both read one exported list, and a test checks they agree.
- bc1d7e5: Pass the secrets a pack binds by name to the agent it starts, even when the backend does not declare that variable (for example a token in the pack's own MCP server headers). A binding that cannot be resolved is now reported. Ambient variables that are not bound still do not reach the agent.
- 80a8b0d: Pin built-in wrapper installation hints and doctor checks to the supported versions. Allow Codex's existing CLI login as an alternative to an API key, and support selecting the Codex CLI path in the gated real-wrapper smoke test.
- Updated dependencies [720b872]
- Updated dependencies [25ea47f]
- Updated dependencies [c66ef1d]
- Updated dependencies [1a4d17f]
- Updated dependencies [5591c50]
- Updated dependencies [3784a7b]
- Updated dependencies [4bf5632]
- Updated dependencies [3ffd71b]
  - @kramahq/contract@0.3.0
  - @kramahq/engine@0.4.0

## 0.3.0

### Minor Changes

- 55fa219: A delegation is now a durable send. The step records its A2A `messageId` and a delivery state (`pending`, `sent`, `uncertain`) before anything is sent, and the gateway uses that id on the wire. A failure before the request left (the gateway marks it `dispatched: false`) is retried with backoff under the same id; a failure after it may have left, or a restart that finds a send never confirmed, is reported as `uncertain` and is never sent again, and a repeat of the same idempotency key reports it instead of repeating it. A stream that drops after the agent answered is followed again with `SubscribeToTask` and settled with `GetTask`, artifacts the agent repeats are stored once, and a state that arrives after the task has finished is ignored. After a restart `failOrphaned` asks the agent what it holds: a finished task is taken over, a running one is canceled, and nothing is resent.

### Patch Changes

- Updated dependencies [55fa219]
  - @kramahq/engine@0.3.0
  - @kramahq/contract@0.2.0

## 0.2.0

### Minor Changes

- bfcfd89: The agent gateway now speaks A2A v1.0 through the official `@a2a-js/sdk` client. It reads each agent's card (`supportedInterfaces`), sends `A2A-Version: 1.0`, and uses the JSON-RPC or HTTP+JSON interface the card advertises; agents that only speak 0.3 are reached through the SDK's compatibility layer. Calls to external agents are hardened: public addresses only, no redirects, a response size cap, an origin allow-list, and credentials sent only to the origin they were issued for. `AgentRef` gains an optional `external` flag, `A2AGateway.inspect()` returns an advisory card report, and the `jsonRpcPath` and `fetch` options are gone (the card says where to call).

### Patch Changes

- Updated dependencies [bfcfd89]
- Updated dependencies [5b37459]
  - @kramahq/engine@0.2.0

## 0.1.0

### Minor Changes

- 3d8d119: Add the A2A gateway: streams `message/stream` into normalised state, sideband, artifact and usage events, resumes conversations by contextId, surfaces input-required, enforces total and inactivity timeouts and cancels the remote task. Adds the `credits` usage unit for provider billing weight.
- 28c8667: Add the access decision flow: a wrapper's permission request for a path outside the workspace raises an `access` Decision (allow once, allow for project, deny), the same delegation continues with the answer, and project grants are remembered. The gateway reads a provisional `x-access-request` marker (wrapper task W3).
- c8f636f: One flow for what agents report. Activity and usage from the A2A stream and from the new always-on event sink (`POST /agent-events`, loopback, bearer token, size cap) go through the same ingest and the same normaliser, so an agent's activity looks identical whichever way it was reported. Agents that Krama does not call itself (native-mode workers) get the sink in their derived config, which is the only way to see their own tool calls and usage; agents Krama calls directly stay on the A2A stream, so nothing is counted twice. Events are attributed by their own correlation context, then by the token's claims; an event that cannot be attributed, or contradicts its token, is counted and parked, never guessed. A retried event counts once. Krama's gateway now sends the correlation context (`trace_id`, `parent_agent_id`, `propagated_metadata.run_id`) with every request, and `cost.updated` events name the agent that reported.
- 41efae5: Run an agent graph. A pack may now declare an `orchestrator` and an `agents` catalogue wired by `subAgents` (with hints). In `native` delegation the runner starts every reachable agent leaf first, waits for each to answer, and configures each parent with exactly its children's live addresses; an agent shared by two parents is one instance per run, external agents are referenced but never started, and everything is stopped with the run. An agent's own wrapper config is kept as it is: Krama derives a per-run copy (port, workspace, `subAgents`, prompt hints) with owner-only permissions and removes it on stop. A roster-only pack runs as a one-level graph, so existing packs behave as before. The prompt lists each agent with its description and when to use it.
- a473487: Agents keep their address. A restarted agent (after a crash, a failed health check, or an explicit restart) comes back on the same port, so agents that were given its address keep working. At every orchestrator turn the runner checks the graph: an agent that died is brought back in place, and if its address could not be kept, everything that was given the old address is stopped and started again with the new one, leaf first. A replaced orchestrator is told the run was interrupted and resumed.
- 4a894c6: Add the backend registry: a declarative descriptor per A2A wrapper (claude, codex, copilot, opencode, antigravity), option validation, launch/config builder that maps common settings to each provider's keys, prerequisite checks, a scaffold command, and `AgentDefinition.backend.options/common/secrets`.
- 4d0036f: Add agent definition loading and validation (role/variant folders with agent.yaml, prompt.md and context.md, checked against the backend registry), capability matching ranked by coverage, backend and cost hint, and roster resolution with `roster_unsatisfied`.
- 171a192: Add the agent process runtime: dynamic ports, cross-platform process-tree termination, workspaces, health checks with restart policy, idle reaper, orphan cleanup after a crash, and the `AgentRuntime` port.

### Patch Changes

- d3bbcb3: Add the orchestrator MCP server (Streamable HTTP, scoped tokens) exposing get_run, query_agents, delegate_to_agent, record_phase_outcome, request_decision, store_artifact, get_artifact and get_budget, with every call checked by engine invariants and failures returned as typed errors. Adds `SpawnSpec.env` and an in-memory `FakeAgentRuntime`.
- Updated dependencies [3d8d119]
- Updated dependencies [28c8667]
- Updated dependencies [c8f636f]
- Updated dependencies [41efae5]
- Updated dependencies [d3b87dd]
- Updated dependencies [a473487]
- Updated dependencies [4a894c6]
- Updated dependencies [eadcf8e]
- Updated dependencies [4d0036f]
- Updated dependencies [31058b0]
- Updated dependencies [4b47415]
- Updated dependencies [1d5902a]
- Updated dependencies [f87c1bb]
- Updated dependencies [d3bbcb3]
- Updated dependencies [08c9997]
- Updated dependencies [171a192]
- Updated dependencies [8301655]
- Updated dependencies [0c9b7b2]
- Updated dependencies [195e3b8]
  - @kramahq/contract@0.1.0
  - @kramahq/engine@0.1.0
