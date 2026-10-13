import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/index.js';
import { priya, setup, authorReviewerPack } from './helpers.js';

const pack = () => ({
  ...authorReviewerPack(),
  inputsSchema: {
    type: 'object',
    required: ['audience'],
    properties: { audience: { type: 'string' }, count: { type: 'number' } },
  },
});

const create = (params?: Record<string, unknown>) => {
  const { engine } = setup(pack());
  return engine.runs.create(
    { packId: 'pack_demo', input: { text: 'write it', ...(params ? { params } : {}) } },
    priya,
  );
};

describe('a run is created only with the input its pack asks for (#40)', () => {
  it('rejects a run that omits a required parameter, naming the field', async () => {
    const err = await create().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).problemCode).toBe('validation_failed');
    expect((err as DomainError).details?.errors).toEqual([
      { field: 'input.params.audience', message: expect.stringContaining('audience') },
    ]);
  });

  it('rejects a value of the wrong type, and reports every problem at once', async () => {
    const err = (await create({ count: 'many' }).catch((e: unknown) => e)) as DomainError;
    expect((err.details?.errors as { field: string }[]).map((e) => e.field).sort()).toEqual([
      'input.params.audience',
      'input.params.count',
    ]);
  });

  it('accepts valid input and leaves it exactly as given', async () => {
    const run = await create({ audience: 'engineers', extra: 1 });
    expect(run.input.params).toEqual({ audience: 'engineers', extra: 1 });
  });

  it('does not touch a pack that asks for nothing', async () => {
    const { engine } = setup();
    await expect(
      engine.runs.create({ packId: 'pack_demo', input: { text: 'x' } }, priya),
    ).resolves.toMatchObject({ status: 'planning' });
  });

  it('refuses a pack whose schema cannot be applied rather than skipping the check', async () => {
    const { engine } = setup({
      ...authorReviewerPack(),
      inputsSchema: { type: 'object', properties: { w: { type: 'string', format: 'nope' } } },
    });
    await expect(
      engine.runs.create({ packId: 'pack_demo', input: { text: 'x' } }, priya),
    ).rejects.toMatchObject({ code: 'input_required' });
  });
});
