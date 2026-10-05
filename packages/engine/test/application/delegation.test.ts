import { describe, expect, it } from 'vitest';
import { priya, setup } from './helpers.js';

const delegationOf = async (policy: object, delegation?: 'krama' | 'native') => {
  const h = setup(undefined, policy);
  const run = await h.engine.runs.create(
    {
      packId: 'pack_demo',
      input: {},
      ...(delegation ? { orchestrator: { delegation } } : {}),
    },
    priya,
  );
  return run.orchestrator.delegation;
};

describe('delegation mode of a new run', () => {
  it('is native unless policy or the request says otherwise', async () => {
    expect(await delegationOf({})).toBe('native');
  });

  it('follows the platform policy', async () => {
    expect(await delegationOf({ defaultDelegation: 'krama' })).toBe('krama');
  });

  it('lets the run request win over the policy, in both directions', async () => {
    expect(await delegationOf({ defaultDelegation: 'krama' }, 'native')).toBe('native');
    expect(await delegationOf({ defaultDelegation: 'native' }, 'krama')).toBe('krama');
  });

  it('keeps the chosen orchestrator backend and model alongside the mode', async () => {
    const h = setup();
    const run = await h.engine.runs.create(
      {
        packId: 'pack_demo',
        input: {},
        orchestrator: { backend: 'a2a-codex', model: 'm', delegation: 'krama' },
      },
      priya,
    );
    expect(run.orchestrator).toMatchObject({
      backend: 'a2a-codex',
      model: 'm',
      delegation: 'krama',
    });
  });
});
