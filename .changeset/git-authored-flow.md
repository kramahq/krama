---
'@kramahq/git': minor
---

New package: git for authored packs and agents. A safe `git` runner (no shell, no prompts, the person's own configuration, credentials removed from messages) and `Repo`: every save is a commit by the person on a draft branch with its own work tree, a revision is an immutable annotated tag `rev/<n>`, production is `main` and only moves forward to a revision, and rollback adds a commit and a new revision instead of rewriting history. A save that contains a credential is refused with the file and line named. Remote and installed sources come next.
