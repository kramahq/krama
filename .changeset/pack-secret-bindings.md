---
'@kramahq/agents': patch
---

Pass the secrets a pack binds by name to the agent it starts, even when the backend does not declare that variable (for example a token in the pack's own MCP server headers). A binding that cannot be resolved is now reported. Ambient variables that are not bound still do not reach the agent.
