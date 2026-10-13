---
'@kramahq/git': minor
---

Installed sources and the remote side. `Sources` keeps a bare mirror per remote, a read-only work tree per pinned commit and `lock.json` saying which commit each `repo@ref#dir` resolved to, so a pinned source works offline; an update is previewed as a diff and moves the pin only when asked. Tags are held to the commit they first named: a tag the remote moves is refused and reported. An allow-list of remotes and an optional signed-commit check apply before anything is pinned, and credentials in a URL never reach an error or an event. `resolveGit` gives the pack loader the agent directory and commit. `Repo.setRemote` and `Repo.push` send production, drafts and revisions with the person's own credentials, never forced, and report each ref git refuses.
