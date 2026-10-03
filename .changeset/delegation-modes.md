---
'@kramahq/contract': minor
'@kramahq/engine': minor
'@kramahq/orchestrator-mcp': minor
---

Add delegation modes. A run's orchestrator reaches its workers either through its own A2A sub-agent tools (`native`, the default) or through Krama's `delegate_to_agent` relay (`krama`). The mode is set by platform policy (`defaultDelegation`) or per run (`orchestrator.delegation`). In `native` mode the runner starts every rostered worker, generates the orchestrator's `subAgents` config from exactly that roster, withholds the relay tools, and uses a mode-specific prompt. Runs created before this change keep relaying.
