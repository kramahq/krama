---
'@kramahq/engine': minor
'@kramahq/agents': minor
'@kramahq/orchestrator-mcp': minor
---

Agents keep their address. A restarted agent (after a crash, a failed health check, or an explicit restart) comes back on the same port, so agents that were given its address keep working. At every orchestrator turn the runner checks the graph: an agent that died is brought back in place, and if its address could not be kept, everything that was given the old address is stopped and started again with the new one, leaf first. A replaced orchestrator is told the run was interrupted and resumed.
