import { describe, expect, it } from 'vitest';
import {
  InMemoryArtifactStore,
  InMemoryEventLog,
  InMemoryStore,
  FakeClock,
  artifactStoreContract,
  eventLogContract,
  storeContract,
} from '../src/testing/index.js';

const h = { describe, it, expect } as never;

storeContract(h, () => new InMemoryStore());
eventLogContract(h, (o) => new InMemoryEventLog(new FakeClock(), o?.retain), {
  supportsRetention: true,
});
artifactStoreContract(h, () => new InMemoryArtifactStore());
