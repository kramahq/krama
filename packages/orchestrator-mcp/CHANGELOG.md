# @kramahq/orchestrator-mcp

## 0.1.0

### Minor Changes

- c8f636f: One flow for what agents report. Activity and usage from the A2A stream and from the new always-on event sink (`POST /agent-events`, loopback, bearer token, size cap) go through the same ingest and the same normaliser, so an agent's activity looks identical whichever way it was reported. Agents that Krama does not call itself (native-mode workers) get the sink in their derived config, which is the only way to see their own tool calls and usage; agents Krama calls directly stay on the A2A stream, so nothing is counted twice. Events are attributed by their own correlation context, then by the token's claims; an event that cannot be attributed, or contradicts its token, is counted and parked, never guessed. A retried event counts once. Krama's gateway now sends the correlation context (`trace_id`, `parent_agent_id`, `propagated_metadata.run_id`) with every request, and `cost.updated` events name the agent that reported.
- 41efae5: Run an agent graph. A pack may now declare an `orchestrator` and an `agents` catalogue wired by `subAgents` (with hints). In `native` delegation the runner starts every reachable agent leaf first, waits for each to answer, and configures each parent with exactly its children's live addresses; an agent shared by two parents is one instance per run, external agents are referenced but never started, and everything is stopped with the run. An agent's own wrapper config is kept as it is: Krama derives a per-run copy (port, workspace, `subAgents`, prompt hints) with owner-only permissions and removes it on stop. A roster-only pack runs as a one-level graph, so existing packs behave as before. The prompt lists each agent with its description and when to use it.
- a473487: Agents keep their address. A restarted agent (after a crash, a failed health check, or an explicit restart) comes back on the same port, so agents that were given its address keep working. At every orchestrator turn the runner checks the graph: an agent that died is brought back in place, and if its address could not be kept, everything that was given the old address is stopped and started again with the new one, leaf first. A replaced orchestrator is told the run was interrupted and resumed.
- 31058b0: Add delegation modes. A run's orchestrator reaches its workers either through its own A2A sub-agent tools (`native`, the default) or through Krama's `delegate_to_agent` relay (`krama`). The mode is set by platform policy (`defaultDelegation`) or per run (`orchestrator.delegation`). In `native` mode the runner starts every rostered worker, generates the orchestrator's `subAgents` config from exactly that roster, withholds the relay tools, and uses a mode-specific prompt. Runs created before this change keep relaying.
- d3bbcb3: Add the orchestrator MCP server (Streamable HTTP, scoped tokens) exposing get_run, query_agents, delegate_to_agent, record_phase_outcome, request_decision, store_artifact, get_artifact and get_budget, with every call checked by engine invariants and failures returned as typed errors. Adds `SpawnSpec.env` and an in-memory `FakeAgentRuntime`.
- 08c9997: Add the orchestrator runner: a neutral prompt template plus the pack's methodology, an orchestrator agent started per run with a scoped MCP token, questions turned into Decisions, answers relayed back, pause/resume/stop handling, nudging, and restart recovery without duplicating completed delegations (step idempotency keys). Adds `Methodology.guidance`, `Step.key`, `RunService.block/fail` and `StepService.failOrphaned`.

### Patch Changes

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
