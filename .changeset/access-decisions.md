---
'@kramahq/engine': minor
'@kramahq/agents': minor
---

Add the access decision flow: a wrapper's permission request for a path outside the workspace raises an `access` Decision (allow once, allow for project, deny), the same delegation continues with the answer, and project grants are remembered. The gateway reads a provisional `x-access-request` marker (wrapper task W3).
