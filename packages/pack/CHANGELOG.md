# @kramahq/pack

## 0.1.0

### Minor Changes

- 90f521c: Install packs from git. The pack package turns a loaded pack into the catalogue entry (`toPack`), lists what it asks a person to allow (`permissionSurface`: MCP servers, hosts, secrets, scripts, loosened sandboxes, memory) and what an update would change (`diffLoads`). `Sources` can look at a source without pinning it (`peek`), load an exact commit (`at`), and snapshot and restore pins. The server gets a pack manager: preview, install against the previewed digest, update with a diff, rollback that puts every pinned agent back, enable, disable and uninstall, kept in a registry that survives a restart.
- 99fbfb3: Load and validate a pack. `loadPackDir` and `loadPackText` read `krama-pack.yaml` (an orchestrator and a catalogue of agents from `git`, `config` or `external` sources), check it with a path on every problem (unknown ids, cycles, an external orchestrator, secrets written into a config, unbound `${VAR}`, a referenced agent that advertises no skill, a disallowed backend, missing instructions and skill files) and return the resolved agents and a digest. Backend knowledge, the provider-config check and git fetching are passed in, so the package imports only the contract and the engine.

### Patch Changes

- Updated dependencies [720b872]
- Updated dependencies [25ea47f]
- Updated dependencies [c66ef1d]
- Updated dependencies [1a4d17f]
- Updated dependencies [5591c50]
- Updated dependencies [3784a7b]
- Updated dependencies [4bf5632]
- Updated dependencies [3ffd71b]
  - @kramahq/contract@0.3.0
  - @kramahq/engine@0.4.0
