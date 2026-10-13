---
'@kramahq/contract': minor
'@kramahq/engine': minor
'@kramahq/orchestrator-mcp': minor
'@kramahq/sdk': patch
---

Run a pack with no methodology. `methodology` and `roster` are now optional (deprecated). A run of such a pack has one implicit phase until the orchestrator declares phases with the new `set_plan` tool (it may revise phases that have not started). Loop-backs are capped by platform policy, and in review mode the engine raises one final approval before the run can complete. A graph pack now also runs with relay (`krama`) delegation: the orchestrator delegates to its direct agents by name.
