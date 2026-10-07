---
'@kramahq/sdk': minor
---

A typed client for the Krama API, built on the contract's types: capabilities, projects, packs, runs (including their activity), and decisions. Errors are `ApiError` (the problem code and trace id are kept; an unreachable server is status 0). The live event stream stays open and resumes from the last event it delivered after a drop, reports `connecting`, `live`, `reconnecting` and `disconnected`, and asks for a fresh snapshot when the server no longer has events back to its position (410). This is a hand-written client for now; the generated one lands with M5.4.
