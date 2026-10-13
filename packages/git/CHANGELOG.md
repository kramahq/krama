# @kramahq/git

## 0.1.0

### Minor Changes

- 56526e6: New package: git for authored packs and agents. A safe `git` runner (no shell, no prompts, the person's own configuration, credentials removed from messages) and `Repo`: every save is a commit by the person on a draft branch with its own work tree, a revision is an immutable annotated tag `rev/<n>`, production is `main` and only moves forward to a revision, and rollback adds a commit and a new revision instead of rewriting history. A save that contains a credential is refused with the file and line named. Remote and installed sources come next.
- 2883451: Installed sources and the remote side. `Sources` keeps a bare mirror per remote, a read-only work tree per pinned commit and `lock.json` saying which commit each `repo@ref#dir` resolved to, so a pinned source works offline; an update is previewed as a diff and moves the pin only when asked. Tags are held to the commit they first named: a tag the remote moves is refused and reported. An allow-list of remotes and an optional signed-commit check apply before anything is pinned, and credentials in a URL never reach an error or an event. `resolveGit` gives the pack loader the agent directory and commit. `Repo.setRemote` and `Repo.push` send production, drafts and revisions with the person's own credentials, never forced, and report each ref git refuses.
- 90f521c: Install packs from git. The pack package turns a loaded pack into the catalogue entry (`toPack`), lists what it asks a person to allow (`permissionSurface`: MCP servers, hosts, secrets, scripts, loosened sandboxes, memory) and what an update would change (`diffLoads`). `Sources` can look at a source without pinning it (`peek`), load an exact commit (`at`), and snapshot and restore pins. The server gets a pack manager: preview, install against the previewed digest, update with a diff, rollback that puts every pinned agent back, enable, disable and uninstall, kept in a registry that survives a restart.

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
