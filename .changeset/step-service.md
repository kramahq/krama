---
'@kramahq/engine': minor
---

Add `StepService.delegate`: runs one delegation through the AgentGateway, turns sideband into `activity.*` events, stores artifacts, accounts usage per step, phase, run and project (provider-reported or null), and enforces run state, phase state, allowed backends and the budget cap.
