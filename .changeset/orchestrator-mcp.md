---
'@kramahq/orchestrator-mcp': minor
'@kramahq/engine': minor
'@kramahq/agents': patch
---

Add the orchestrator MCP server (Streamable HTTP, scoped tokens) exposing get_run, query_agents, delegate_to_agent, record_phase_outcome, request_decision, store_artifact, get_artifact and get_budget, with every call checked by engine invariants and failures returned as typed errors. Adds `SpawnSpec.env` and an in-memory `FakeAgentRuntime`.
