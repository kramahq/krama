---
'@kramahq/engine': minor
'@kramahq/agents': minor
'@kramahq/orchestrator-mcp': minor
---

One flow for what agents report. Activity and usage from the A2A stream and from the new always-on event sink (`POST /agent-events`, loopback, bearer token, size cap) go through the same ingest and the same normaliser, so an agent's activity looks identical whichever way it was reported. Agents that Krama does not call itself (native-mode workers) get the sink in their derived config, which is the only way to see their own tool calls and usage; agents Krama calls directly stay on the A2A stream, so nothing is counted twice. Events are attributed by their own correlation context, then by the token's claims; an event that cannot be attributed, or contradicts its token, is counted and parked, never guessed. A retried event counts once. Krama's gateway now sends the correlation context (`trace_id`, `parent_agent_id`, `propagated_metadata.run_id`) with every request, and `cost.updated` events name the agent that reported.
