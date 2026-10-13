---
'@kramahq/pack': minor
---

Load and validate a pack. `loadPackDir` and `loadPackText` read `krama-pack.yaml` (an orchestrator and a catalogue of agents from `git`, `config` or `external` sources), check it with a path on every problem (unknown ids, cycles, an external orchestrator, secrets written into a config, unbound `${VAR}`, a referenced agent that advertises no skill, a disallowed backend, missing instructions and skill files) and return the resolved agents and a digest. Backend knowledge, the provider-config check and git fetching are passed in, so the package imports only the contract and the engine.
