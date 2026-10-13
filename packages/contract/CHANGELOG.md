# @kramahq/contract

## 0.3.0

### Minor Changes

- 720b872: `GET /audit` now serves the hash-chained control record: who did what, newest first, filtered by actor, action (and the actions under it) and a time range, with a cursor that pages backwards. Entries carry their chain position and hash. The ledger's `read` gained `order`, `beforeSeq`, `actor` and `kind`.
- 25ea47f: Record who did what on the hash-chained control record. Every audited command (run created, changed, paused, stopped, decision resolved, plan set) now writes a control record naming the principal, with their highest role (`ActorRef.role`, new and optional), in the same database transaction as the change: if the change rolls back so does the record, and subscribers hear of it only after the commit. A command whose record cannot be written does not happen.
- 1a4d17f: Run a pack with no methodology. `methodology` and `roster` are now optional (deprecated). A run of such a pack has one implicit phase until the orchestrator declares phases with the new `set_plan` tool (it may revise phases that have not started). Loop-backs are capped by platform policy, and in review mode the engine raises one final approval before the run can complete. A graph pack now also runs with relay (`krama`) delegation: the orchestrator delegates to its direct agents by name.
- 4bf5632: Add the transcript routes: `GET /runs/{id}/transcript` (a run's lossless record, paged and filtered), `GET /runs/{id}/transcript/blobs/{sha256}` and `GET /runs/{id}/transcript/verify`. They need the `operator` role. The event stream also serves the topic `run:<id>:transcript`, resumable with `Last-Event-ID`.

### Patch Changes

- 5591c50: The pack routes work: `POST /packs/preview` and `POST /packs/{id}/update/preview` are operations; `POST /packs` installs against a previewed digest (idempotent); update, rollback, enable, disable and uninstall; versions, the installed manifest and a read-only browser of an installed pack's files that cannot leave the pack. A source that is not allowed, a pack that does not validate and a pack that needs a newer Krama each have their own problem. An update preview may name a ref. Also: a route that lets "the owner" through (such as reading an operation you started) no longer demands an administrator.

## 0.2.0

### Minor Changes

- 55fa219: A delegation is now a durable send. The step records its A2A `messageId` and a delivery state (`pending`, `sent`, `uncertain`) before anything is sent, and the gateway uses that id on the wire. A failure before the request left (the gateway marks it `dispatched: false`) is retried with backoff under the same id; a failure after it may have left, or a restart that finds a send never confirmed, is reported as `uncertain` and is never sent again, and a repeat of the same idempotency key reports it instead of repeating it. A stream that drops after the agent answered is followed again with `SubscribeToTask` and settled with `GetTask`, artifacts the agent repeats are stored once, and a state that arrives after the task has finished is ignored. After a restart `failOrphaned` asks the agent what it holds: a finished task is taken over, a running one is canceled, and nothing is resent.

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
