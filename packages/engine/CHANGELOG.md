# @kramahq/engine

## 0.1.0

### Minor Changes

- 28c8667: Add the access decision flow: a wrapper's permission request for a path outside the workspace raises an `access` Decision (allow once, allow for project, deny), the same delegation continues with the answer, and project grants are remembered. The gateway reads a provisional `x-access-request` marker (wrapper task W3).
- c8f636f: One flow for what agents report. Activity and usage from the A2A stream and from the new always-on event sink (`POST /agent-events`, loopback, bearer token, size cap) go through the same ingest and the same normaliser, so an agent's activity looks identical whichever way it was reported. Agents that Krama does not call itself (native-mode workers) get the sink in their derived config, which is the only way to see their own tool calls and usage; agents Krama calls directly stay on the A2A stream, so nothing is counted twice. Events are attributed by their own correlation context, then by the token's claims; an event that cannot be attributed, or contradicts its token, is counted and parked, never guessed. A retried event counts once. Krama's gateway now sends the correlation context (`trace_id`, `parent_agent_id`, `propagated_metadata.run_id`) with every request, and `cost.updated` events name the agent that reported.
- 41efae5: Run an agent graph. A pack may now declare an `orchestrator` and an `agents` catalogue wired by `subAgents` (with hints). In `native` delegation the runner starts every reachable agent leaf first, waits for each to answer, and configures each parent with exactly its children's live addresses; an agent shared by two parents is one instance per run, external agents are referenced but never started, and everything is stopped with the run. An agent's own wrapper config is kept as it is: Krama derives a per-run copy (port, workspace, `subAgents`, prompt hints) with owner-only permissions and removes it on stop. A roster-only pack runs as a one-level graph, so existing packs behave as before. The prompt lists each agent with its description and when to use it.
- d3b87dd: Agent graph resolution: `resolveAgentGraph` and `validateAgentGraph` work out which agents an orchestrator can reach, a leaf-first start order, shared agents, and path-level errors for cycles, unknown references, external leaves and invalid ids.
- a473487: Agents keep their address. A restarted agent (after a crash, a failed health check, or an explicit restart) comes back on the same port, so agents that were given its address keep working. At every orchestrator turn the runner checks the graph: an agent that died is brought back in place, and if its address could not be kept, everything that was given the old address is stopped and started again with the new one, leaf first. A replaced orchestrator is told the run was interrupted and resumed.
- 4a894c6: Add the backend registry: a declarative descriptor per A2A wrapper (claude, codex, copilot, opencode, antigravity), option validation, launch/config builder that maps common settings to each provider's keys, prerequisite checks, a scaffold command, and `AgentDefinition.backend.options/common/secrets`.
- 4d0036f: Add agent definition loading and validation (role/variant folders with agent.yaml, prompt.md and context.md, checked against the backend registry), capability matching ranked by coverage, backend and cost hint, and roster resolution with `roster_unsatisfied`.
- 31058b0: Add delegation modes. A run's orchestrator reaches its workers either through its own A2A sub-agent tools (`native`, the default) or through Krama's `delegate_to_agent` relay (`krama`). The mode is set by platform policy (`defaultDelegation`) or per run (`orchestrator.delegation`). In `native` mode the runner starts every rostered worker, generates the orchestrator's `subAgents` config from exactly that roster, withholds the relay tools, and uses a mode-specific prompt. Runs created before this change keep relaying.
- 4b47415: Add the pure engine domain: run and phase state machines, decisions with multi-approver rule, evaluator loop with cap, budget/gate/backend invariants and nullable cost aggregation.
- 1d5902a: Add the engine ports (Store, EventLog, ArtifactStore, AgentGateway, PackRepository, Clock, IdGenerator, SecretResolver, Notifier, MemoryStore, WorkItemSource), the Run/Decision/Budget use cases, in-memory fakes and reusable port contract suites under `@kramahq/engine/testing`.
- d3bbcb3: Add the orchestrator MCP server (Streamable HTTP, scoped tokens) exposing get_run, query_agents, delegate_to_agent, record_phase_outcome, request_decision, store_artifact, get_artifact and get_budget, with every call checked by engine invariants and failures returned as typed errors. Adds `SpawnSpec.env` and an in-memory `FakeAgentRuntime`.
- 08c9997: Add the orchestrator runner: a neutral prompt template plus the pack's methodology, an orchestrator agent started per run with a scoped MCP token, questions turned into Decisions, answers relayed back, pause/resume/stop handling, nudging, and restart recovery without duplicating completed delegations (step idempotency keys). Adds `Methodology.guidance`, `Step.key`, `RunService.block/fail` and `StepService.failOrphaned`.
- 171a192: Add the agent process runtime: dynamic ports, cross-platform process-tree termination, workspaces, health checks with restart policy, idle reaper, orphan cleanup after a crash, and the `AgentRuntime` port.
- 0c9b7b2: Add `StepService.delegate`: runs one delegation through the AgentGateway, turns sideband into `activity.*` events, stores artifacts, accounts usage per step, phase, run and project (provider-reported or null), and enforces run state, phase state, allowed backends and the budget cap.
- 195e3b8: Add the PGlite/Postgres store (Drizzle schema, embedded migrations, optimistic versions) and an artifact catalog to the `Store` port.

### Patch Changes

- 8301655: Publish `run.created` after the transaction commits. It was published inside the transaction, which deadlocks on a single-connection database such as PGlite and could announce a run that then rolled back.
- Updated dependencies [3d8d119]
- Updated dependencies [41efae5]
- Updated dependencies [4a894c6]
- Updated dependencies [eadcf8e]
- Updated dependencies [31058b0]
- Updated dependencies [4b47415]
- Updated dependencies [f87c1bb]
- Updated dependencies [08c9997]
  - @kramahq/contract@0.1.0
