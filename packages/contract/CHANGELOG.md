# @kramahq/contract

## 0.1.0

### Minor Changes

- 41efae5: Run an agent graph. A pack may now declare an `orchestrator` and an `agents` catalogue wired by `subAgents` (with hints). In `native` delegation the runner starts every reachable agent leaf first, waits for each to answer, and configures each parent with exactly its children's live addresses; an agent shared by two parents is one instance per run, external agents are referenced but never started, and everything is stopped with the run. An agent's own wrapper config is kept as it is: Krama derives a per-run copy (port, workspace, `subAgents`, prompt hints) with owner-only permissions and removes it on stop. A roster-only pack runs as a one-level graph, so existing packs behave as before. The prompt lists each agent with its description and when to use it.
- 4a894c6: Add the backend registry: a declarative descriptor per A2A wrapper (claude, codex, copilot, opencode, antigravity), option validation, launch/config builder that maps common settings to each provider's keys, prerequisite checks, a scaffold command, and `AgentDefinition.backend.options/common/secrets`.
- eadcf8e: Add zod schemas, route table, OpenAPI 3.1 generator and fixtures for the v1 API.
- 31058b0: Add delegation modes. A run's orchestrator reaches its workers either through its own A2A sub-agent tools (`native`, the default) or through Krama's `delegate_to_agent` relay (`krama`). The mode is set by platform policy (`defaultDelegation`) or per run (`orchestrator.delegation`). In `native` mode the runner starts every rostered worker, generates the orchestrator's `subAgents` config from exactly that roster, withholds the relay tools, and uses a mode-specific prompt. Runs created before this change keep relaying.
- 08c9997: Add the orchestrator runner: a neutral prompt template plus the pack's methodology, an orchestrator agent started per run with a scoped MCP token, questions turned into Decisions, answers relayed back, pause/resume/stop handling, nudging, and restart recovery without duplicating completed delegations (step idempotency keys). Adds `Methodology.guidance`, `Step.key`, `RunService.block/fail` and `StepService.failOrphaned`.

### Patch Changes

- 3d8d119: Add the A2A gateway: streams `message/stream` into normalised state, sideband, artifact and usage events, resumes conversations by contextId, surfaces input-required, enforces total and inactivity timeouts and cancels the remote task. Adds the `credits` usage unit for provider billing weight.
- 4b47415: Add the pure engine domain: run and phase state machines, decisions with multi-approver rule, evaluator loop with cap, budget/gate/backend invariants and nullable cost aggregation.
- f87c1bb: Export the package manifest so tooling can locate shipped fixtures.
