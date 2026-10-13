# @kramahq/store

## 0.2.0

### Minor Changes

- 720b872: `GET /audit` now serves the hash-chained control record: who did what, newest first, filtered by actor, action (and the actions under it) and a time range, with a cursor that pages backwards. Entries carry their chain position and hash. The ledger's `read` gained `order`, `beforeSeq`, `actor` and `kind`.
- 25ea47f: Record who did what on the hash-chained control record. Every audited command (run created, changed, paused, stopped, decision resolved, plan set) now writes a control record naming the principal, with their highest role (`ActorRef.role`, new and optional), in the same database transaction as the change: if the change rolls back so does the record, and subscribers hear of it only after the commit. A command whose record cannot be written does not happen.

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

## 0.1.2

### Patch Changes

- Updated dependencies [55fa219]
  - @kramahq/engine@0.3.0
  - @kramahq/contract@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [bfcfd89]
- Updated dependencies [5b37459]
  - @kramahq/engine@0.2.0

## 0.1.0

### Minor Changes

- 5aa3c71: Add the persisted, cursor-ordered event log (`PgEventLog`) with topic filtering, replay by cursor, retention by count and age, and `CursorGoneError` for cursors older than retention.
- 195e3b8: Add the PGlite/Postgres store (Drizzle schema, embedded migrations, optimistic versions) and an artifact catalog to the `Store` port.

### Patch Changes

- Updated dependencies [3d8d119]
- Updated dependencies [28c8667]
- Updated dependencies [c8f636f]
- Updated dependencies [41efae5]
- Updated dependencies [d3b87dd]
- Updated dependencies [a473487]
- Updated dependencies [4a894c6]
- Updated dependencies [eadcf8e]
- Updated dependencies [4d0036f]
- Updated dependencies [31058b0]
- Updated dependencies [4b47415]
- Updated dependencies [1d5902a]
- Updated dependencies [f87c1bb]
- Updated dependencies [d3bbcb3]
- Updated dependencies [08c9997]
- Updated dependencies [171a192]
- Updated dependencies [8301655]
- Updated dependencies [0c9b7b2]
- Updated dependencies [195e3b8]
  - @kramahq/contract@0.1.0
  - @kramahq/engine@0.1.0
