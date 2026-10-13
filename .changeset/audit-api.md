---
'@kramahq/contract': minor
'@kramahq/engine': minor
'@kramahq/store': minor
'@kramahq/sdk': patch
---

`GET /audit` now serves the hash-chained control record: who did what, newest first, filtered by actor, action (and the actions under it) and a time range, with a cursor that pages backwards. Entries carry their chain position and hash. The ledger's `read` gained `order`, `beforeSeq`, `actor` and `kind`.
