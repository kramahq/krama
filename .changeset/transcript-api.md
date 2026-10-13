---
'@kramahq/contract': minor
'@kramahq/sdk': patch
---

Add the transcript routes: `GET /runs/{id}/transcript` (a run's lossless record, paged and filtered), `GET /runs/{id}/transcript/blobs/{sha256}` and `GET /runs/{id}/transcript/verify`. They need the `operator` role. The event stream also serves the topic `run:<id>:transcript`, resumable with `Last-Event-ID`.
