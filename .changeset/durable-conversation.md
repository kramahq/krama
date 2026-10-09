---
'@kramahq/engine': minor
'@kramahq/agents': minor
'@kramahq/contract': minor
---

A delegation is now a durable send. The step records its A2A `messageId` and a delivery state (`pending`, `sent`, `uncertain`) before anything is sent, and the gateway uses that id on the wire. A failure before the request left (the gateway marks it `dispatched: false`) is retried with backoff under the same id; a failure after it may have left, or a restart that finds a send never confirmed, is reported as `uncertain` and is never sent again, and a repeat of the same idempotency key reports it instead of repeating it. A stream that drops after the agent answered is followed again with `SubscribeToTask` and settled with `GetTask`, artifacts the agent repeats are stored once, and a state that arrives after the task has finished is ignored. After a restart `failOrphaned` asks the agent what it holds: a finished task is taken over, a running one is canceled, and nothing is resent.
