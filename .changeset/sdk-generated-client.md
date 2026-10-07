---
'@kramahq/sdk': minor
---

Add a client generated from the contract route table: `client.api.<operationId>(...)` for every operation (typed path parameters, query, body and response, an automatic `Idempotency-Key` on creates, `If-Match` where the route needs it) and `client.call(id, args)`. A `@kramahq/sdk/conformance` entry runs the same checks against the mock and the server.
