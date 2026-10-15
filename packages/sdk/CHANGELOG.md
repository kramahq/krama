# @kramahq/sdk

## 0.1.2

### Patch Changes

- 720b872: `GET /audit` now serves the hash-chained control record: who did what, newest first, filtered by actor, action (and the actions under it) and a time range, with a cursor that pages backwards. Entries carry their chain position and hash. The ledger's `read` gained `order`, `beforeSeq`, `actor` and `kind`.
- 25ea47f: Record who did what on the hash-chained control record. Every audited command (run created, changed, paused, stopped, decision resolved, plan set) now writes a control record naming the principal, with their highest role (`ActorRef.role`, new and optional), in the same database transaction as the change: if the change rolls back so does the record, and subscribers hear of it only after the commit. A command whose record cannot be written does not happen.
- 1a4d17f: Run a pack with no methodology. `methodology` and `roster` are now optional (deprecated). A run of such a pack has one implicit phase until the orchestrator declares phases with the new `set_plan` tool (it may revise phases that have not started). Loop-backs are capped by platform policy, and in review mode the engine raises one final approval before the run can complete. A graph pack now also runs with relay (`krama`) delegation: the orchestrator delegates to its direct agents by name.
- 5591c50: The pack routes work: `POST /packs/preview` and `POST /packs/{id}/update/preview` are operations; `POST /packs` installs against a previewed digest (idempotent); update, rollback, enable, disable and uninstall; versions, the installed manifest and a read-only browser of an installed pack's files that cannot leave the pack. A source that is not allowed, a pack that does not validate and a pack that needs a newer Krama each have their own problem. An update preview may name a ref. Also: a route that lets "the owner" through (such as reading an operation you started) no longer demands an administrator.
- 4bf5632: Add the transcript routes: `GET /runs/{id}/transcript` (a run's lossless record, paged and filtered), `GET /runs/{id}/transcript/blobs/{sha256}` and `GET /runs/{id}/transcript/verify`. They need the `operator` role. The event stream also serves the topic `run:<id>:transcript`, resumable with `Last-Event-ID`.
- Updated dependencies [720b872]
- Updated dependencies [25ea47f]
- Updated dependencies [1a4d17f]
- Updated dependencies [5591c50]
- Updated dependencies [4bf5632]
  - @kramahq/contract@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [55fa219]
  - @kramahq/contract@0.2.0

## 0.1.0

### Minor Changes

- 2f2ab26: A typed client for the Krama API, built on the contract's types: capabilities, projects, packs, runs (including their activity), and decisions. Errors are `ApiError` (the problem code and trace id are kept; an unreachable server is status 0). The live event stream stays open and resumes from the last event it delivered after a drop, reports `connecting`, `live`, `reconnecting` and `disconnected`, and asks for a fresh snapshot when the server no longer has events back to its position (410). This is a hand-written client for now; the generated one lands with M5.4.
- a42894c: Add a client generated from the contract route table: `client.api.<operationId>(...)` for every operation (typed path parameters, query, body and response, an automatic `Idempotency-Key` on creates, `If-Match` where the route needs it) and `client.call(id, args)`. A `@kramahq/sdk/conformance` entry runs the same checks against the mock and the server.
