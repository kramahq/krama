---
'@kramahq/engine': minor
---

Check a new run's `input.params` against its pack's `inputsSchema` when the run is created, so a missing or wrongly typed required value is refused with a field-level error for every caller, not only the New Run form. A pack whose schema cannot be applied refuses to start a run instead of skipping the check.
