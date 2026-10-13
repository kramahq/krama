---
'@kramahq/engine': minor
'@kramahq/orchestrator-mcp': minor
---

Work out what a graph pack will really run before accepting its run: the run now records the backend and model its orchestrator will start with, and the backend policy is checked for every agent Krama starts for it. A caller's orchestrator backend, model or definition override on a graph pack is refused with a clear error instead of being recorded and ignored.
