---
'@kramahq/engine': patch
---

Publish `run.created` after the transaction commits. It was published inside the transaction, which deadlocks on a single-connection database such as PGlite and could announce a run that then rolled back.
