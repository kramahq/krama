---
'@kramahq/orchestrator-mcp': minor
'@kramahq/engine': minor
'@kramahq/contract': minor
---

Add the orchestrator runner: a neutral prompt template plus the pack's methodology, an orchestrator agent started per run with a scoped MCP token, questions turned into Decisions, answers relayed back, pause/resume/stop handling, nudging, and restart recovery without duplicating completed delegations (step idempotency keys). Adds `Methodology.guidance`, `Step.key`, `RunService.block/fail` and `StepService.failOrphaned`.
