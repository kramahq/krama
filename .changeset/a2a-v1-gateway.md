---
'@kramahq/agents': minor
'@kramahq/engine': patch
---

The agent gateway now speaks A2A v1.0 through the official `@a2a-js/sdk` client. It reads each agent's card (`supportedInterfaces`), sends `A2A-Version: 1.0`, and uses the JSON-RPC or HTTP+JSON interface the card advertises; agents that only speak 0.3 are reached through the SDK's compatibility layer. Calls to external agents are hardened: public addresses only, no redirects, a response size cap, an origin allow-list, and credentials sent only to the origin they were issued for. `AgentRef` gains an optional `external` flag, `A2AGateway.inspect()` returns an advisory card report, and the `jsonRpcPath` and `fetch` options are gone (the card says where to call).
