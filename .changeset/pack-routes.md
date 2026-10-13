---
'@kramahq/contract': patch
'@kramahq/sdk': patch
---

The pack routes work: `POST /packs/preview` and `POST /packs/{id}/update/preview` are operations; `POST /packs` installs against a previewed digest (idempotent); update, rollback, enable, disable and uninstall; versions, the installed manifest and a read-only browser of an installed pack's files that cannot leave the pack. A source that is not allowed, a pack that does not validate and a pack that needs a newer Krama each have their own problem. An update preview may name a ref. Also: a route that lets "the owner" through (such as reading an operation you started) no longer demands an administrator.
