---
'@kramahq/contract': minor
'@kramahq/engine': minor
'@kramahq/store': minor
'@kramahq/sdk': patch
---

Record who did what on the hash-chained control record. Every audited command (run created, changed, paused, stopped, decision resolved, plan set) now writes a control record naming the principal, with their highest role (`ActorRef.role`, new and optional), in the same database transaction as the change: if the change rolls back so does the record, and subscribers hear of it only after the commit. A command whose record cannot be written does not happen.
