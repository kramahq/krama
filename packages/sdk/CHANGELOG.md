# @kramahq/sdk

## 0.1.0

### Minor Changes

- 2f2ab26: A typed client for the Krama API, built on the contract's types: capabilities, projects, packs, runs (including their activity), and decisions. Errors are `ApiError` (the problem code and trace id are kept; an unreachable server is status 0). The live event stream stays open and resumes from the last event it delivered after a drop, reports `connecting`, `live`, `reconnecting` and `disconnected`, and asks for a fresh snapshot when the server no longer has events back to its position (410). This is a hand-written client for now; the generated one lands with M5.4.
- a42894c: Add a client generated from the contract route table: `client.api.<operationId>(...)` for every operation (typed path parameters, query, body and response, an automatic `Idempotency-Key` on creates, `If-Match` where the route needs it) and `client.call(id, args)`. A `@kramahq/sdk/conformance` entry runs the same checks against the mock and the server.
