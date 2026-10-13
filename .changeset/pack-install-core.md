---
'@kramahq/pack': minor
'@kramahq/git': minor
---

Install packs from git. The pack package turns a loaded pack into the catalogue entry (`toPack`), lists what it asks a person to allow (`permissionSurface`: MCP servers, hosts, secrets, scripts, loosened sandboxes, memory) and what an update would change (`diffLoads`). `Sources` can look at a source without pinning it (`peek`), load an exact commit (`at`), and snapshot and restore pins. The server gets a pack manager: preview, install against the previewed digest, update with a diff, rollback that puts every pinned agent back, enable, disable and uninstall, kept in a registry that survives a restart.
