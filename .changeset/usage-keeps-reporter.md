---
'@kramahq/engine': patch
---

Keep which agent and backend reported each usage entry, so the run cost report groups a native worker's spend under that worker instead of the orchestrator. Entries without a reporter still count toward the orchestrator, and missing cost stays unreported, never estimated.
