import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentDefinition, AgentPreview, Pack, PackPreview } from '@kramahq/contract';
import { ApiError } from '@kramahq/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiMock, resetApi } from './api-mock';
import { me, packs } from './fixtures';
import { renderApp } from './render';

vi.mock('@/api/client', async () => {
  const m = await import('./api-mock');
  return { api: m.apiMock, API_BASE: '/api/v1' };
});
type Spies = Record<string, ReturnType<typeof vi.fn>>;
const calls = () => apiMock.api as Spies;
const pack: Pack = {
  ...packs[0]!,
  name: 'Release notes',
  description: 'Write and review release notes.',
  source: {
    type: 'git',
    url: 'https://example.com/packs.git',
    ref: 'main',
    sha: 'a'.repeat(40),
    path: 'notes',
  },
  tags: ['writing'],
  trust: 'untrusted',
  permissions: [
    {
      id: 'tool:repo',
      kind: 'mcp_server',
      subject: 'repository',
      access: 'runs repo-tool',
      risk: 'high',
      requestedBy: 'reviewer',
    },
  ],
  requirements: { mcpServers: ['repository'], secrets: [], workItemSources: [] },
  artifactTypes: [],
  memoryScopes: [],
  tests: { suites: 0 },
  ui: {},
  links: { update: { href: '/update', method: 'POST' } },
};
const agent: AgentDefinition = {
  id: 'reviewer/default',
  role: 'reviewer',
  variant: 'default',
  name: 'Careful reviewer',
  description: 'Reviews before release.',
  backend: { wrapper: 'a2a-codex', model: 'test-model', secrets: { SERVICE_TOKEN: 'service-ref' } },
  skills: [],
  mcpServers: ['repository'],
  permissions: { tools: {} },
  memory: { enabled: false, scopes: [] },
  capabilities: ['review'],
  source: {
    type: 'git',
    url: 'https://example.com/agents.git',
    ref: 'main',
    path: 'reviewer',
    sha: 'b'.repeat(40),
    digest: 'digest',
  },
  links: {},
};
const ppreview = (over: Partial<PackPreview> = {}): PackPreview => ({
  previewId: 'prev_test',
  manifestDigest: 'review-digest',
  sha: pack.source.sha,
  manifest: pack,
  trust: 'untrusted',
  engineCompatible: true,
  issues: [],
  permissions: pack.permissions,
  secretsToBind: [],
  skills: [],
  definitions: [],
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  ...over,
});
const apreview = (): AgentPreview => ({
  ...ppreview(),
  definition: agent,
  declaredSubAgents: [{ name: 'helper', agentCardUrl: 'https://helper.example/card' }],
});
const operation = (result: object, status = 'succeeded') => ({
  id: 'op_preview',
  status,
  links: {},
  result,
});
const versions = {
  items: [
    {
      sha: 'a'.repeat(40),
      version: '0.3.0',
      digest: 'current',
      at: new Date().toISOString(),
      action: 'update',
      current: true,
    },
    {
      sha: 'c'.repeat(40),
      version: '0.2.0',
      digest: 'older',
      at: new Date().toISOString(),
      action: 'install',
      current: false,
    },
  ],
};
beforeEach(() => {
  resetApi();
  localStorage.clear();
  (apiMock.packs as Spies).list!.mockResolvedValue({ items: [pack] });
  (apiMock.packs as Spies).get!.mockResolvedValue(pack);
  calls().listAgentDefinitions!.mockResolvedValue({ items: [agent] });
  calls().getAgentDefinition!.mockResolvedValue(agent);
  calls().listPackVersions!.mockResolvedValue(versions);
  calls().listAgentDefinitionVersions!.mockResolvedValue(versions);
  calls().installPack!.mockResolvedValue(pack);
  calls().installAgentDefinition!.mockResolvedValue(agent);
  calls().updatePack!.mockResolvedValue(pack);
  calls().rollbackPack!.mockResolvedValue(pack);
  calls().rollbackAgentDefinition!.mockResolvedValue(agent);
});

async function openPreview() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Add pack' }));
  await user.type(screen.getByLabelText('Repository URL'), 'https://example.com/packs.git');
  await user.click(screen.getByRole('button', { name: 'Preview pack' }));
  await screen.findByText('Review access');
  return user;
}

describe('Packs library', () => {
  it('lists and searches the catalogue, with source/version detail and installed filtering', async () => {
    const user = userEvent.setup();
    (apiMock.packs as Spies).list!.mockResolvedValue({ items: [{ ...pack, status: 'disabled' }] });
    renderApp('/packs?filter=installed');
    expect(await screen.findByRole('heading', { name: 'Release notes' })).toBeTruthy();
    await user.type(screen.getByRole('searchbox', { name: 'Search packs' }), 'missing');
    expect(await screen.findByText('No packs match')).toBeTruthy();
    await user.clear(screen.getByRole('searchbox'));
    await user.click(screen.getByRole('link', { name: /Release notes/ }));
    expect(await screen.findByText('Pinned source')).toBeTruthy();
    expect(screen.getByText('https://example.com/packs.git')).toBeTruthy();
    expect(screen.getByText('Declared access')).toBeTruthy();
  });
  it('requires explicit consent and submits exactly the reviewed preview and permission IDs', async () => {
    calls().previewPack!.mockResolvedValue(operation(ppreview()));
    renderApp('/packs');
    const user = await openPreview();
    const install = screen.getByRole('button', { name: 'Install pack' });
    expect((install as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: 'Allow repository (mcp_server)' }));
    expect((install as HTMLButtonElement).disabled).toBe(false);
    await user.click(install);
    await waitFor(() =>
      expect(calls().installPack).toHaveBeenCalledWith({
        body: {
          previewId: 'prev_test',
          manifestDigest: 'review-digest',
          consent: { granted: ['tool:repo'], declined: [] },
        },
      }),
    );
    expect(await screen.findByText('Pinned source')).toBeTruthy();
  });
  it('polls a running preview until complete', async () => {
    calls().previewPack!.mockResolvedValue(operation({}, 'running'));
    calls().getOperation!.mockResolvedValue(operation(ppreview()));
    renderApp('/packs');
    await openPreview();
    expect(calls().getOperation).toHaveBeenCalledWith(
      expect.objectContaining({ params: { id: 'op_preview' } }),
    );
  });
  it('prevents installation of invalid, incompatible or expired previews', async () => {
    calls().previewPack!.mockResolvedValue(
      operation(
        ppreview({
          expiresAt: new Date(Date.now() - 10_000).toISOString(),
          engineCompatible: false,
          issues: [{ severity: 'error', path: 'agents', message: 'Cycle detected' }],
        }),
      ),
    );
    renderApp('/packs');
    const user = await openPreview();
    await user.click(screen.getByRole('checkbox'));
    expect(
      (screen.getByRole('button', { name: 'Install pack' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText('Cycle detected')).toBeTruthy();
    expect(screen.getByText('This preview has expired. Preview the source again.')).toBeTruthy();
  });
  it('clears consent when editing the source and forces a fresh preview after a conflict', async () => {
    calls().previewPack!.mockResolvedValue(operation(ppreview()));
    calls().installPack!.mockRejectedValue(new ApiError('The source changed after preview', 409));
    renderApp('/packs');
    const user = await openPreview();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Install pack' }));
    expect(await screen.findByText('The source changed after preview')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Install pack' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Preview again' }));
    await user.click(screen.getByRole('button', { name: 'Preview pack' }));
    expect(await screen.findByRole('checkbox')).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });
  it('shows new permissions in update review and applies only after they are allowed', async () => {
    calls().previewPackUpdate!.mockResolvedValue(
      operation(
        ppreview({
          diff: {
            added: [],
            removed: [],
            changed: [{ path: 'version', summary: '0.3.0 to 0.4.0' }],
            permissionChanges: pack.permissions,
          },
        }),
      ),
    );
    renderApp(`/packs/${pack.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Check for updates' }));
    await user.click(screen.getByRole('button', { name: 'Preview update' }));
    expect(await screen.findByText('version: 0.3.0 to 0.4.0')).toBeTruthy();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Apply reviewed update' }));
    await waitFor(() =>
      expect(calls().updatePack).toHaveBeenCalledWith(
        expect.objectContaining({ params: { id: pack.id } }),
      ),
    );
  });
  it('confirms rollback and preserves active-run refusal errors', async () => {
    calls().rollbackPack!.mockRejectedValue(new ApiError('1 run is still using this pack', 409));
    renderApp(`/packs/${pack.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Restore 0.2.0' }));
    expect(calls().rollbackPack).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm restore' }));
    expect(await screen.findByText('1 run is still using this pack')).toBeTruthy();
  });
  it('disables a pack and asks before removing it', async () => {
    calls().disablePack!.mockResolvedValue({ ...pack, status: 'disabled' });
    calls().uninstallPack!.mockResolvedValue(undefined);
    renderApp(`/packs/${pack.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Disable pack' }));
    await waitFor(() => expect(calls().disablePack).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Remove pack' }));
    expect(calls().uninstallPack).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm removal' }));
    await waitFor(() =>
      expect(calls().uninstallPack).toHaveBeenCalledWith({ params: { id: pack.id } }),
    );
  });
  it('keeps viewer actions read-only and hides management for server-provided packs', async () => {
    (apiMock.me as ReturnType<typeof vi.fn>).mockResolvedValue({ ...me, roles: ['viewer'] });
    (apiMock.packs as Spies).get!.mockResolvedValue({ ...pack, links: {} });
    renderApp(`/packs/${pack.id}`);
    expect(await screen.findByText(/This pack is provided by the server/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull();
  });
  it('shows a load failure with retry', async () => {
    (apiMock.packs as Spies).list!.mockRejectedValue(new ApiError('Offline', 0));
    renderApp('/packs');
    expect(await screen.findByText('Cannot reach the Krama server')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
describe('Agent pool library', () => {
  it('lists Git definitions and opens encoded role/variant ids', async () => {
    renderApp('/agents/reviewer%2Fdefault');
    expect(await screen.findByRole('heading', { name: 'Careful reviewer' })).toBeTruthy();
    expect(screen.getByText('service-ref')).toBeTruthy();
    expect(calls().getAgentDefinition).toHaveBeenCalledWith({ params: { id: 'reviewer/default' } });
  });
  it('previews an agent with reference bindings and explicitly registers it', async () => {
    calls().previewAgentDefinition!.mockResolvedValue(operation(apreview()));
    renderApp('/agents');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add agent' }));
    await user.type(screen.getByLabelText('Repository URL'), 'https://example.com/agents.git');
    await user.type(screen.getByLabelText('Agent ID'), 'reviewer/default');
    await user.click(screen.getByRole('button', { name: 'Add binding' }));
    await user.type(screen.getByLabelText('Variable 1'), 'SERVICE_TOKEN');
    await user.type(screen.getByLabelText('Secret reference 1'), 'service-ref');
    await user.click(screen.getByRole('button', { name: 'Preview agent' }));
    expect(await screen.findByText(/Declared peers: helper/)).toBeTruthy();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Install agent' }));
    await waitFor(() =>
      expect(calls().previewAgentDefinition).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            id: 'reviewer/default',
            secrets: { SERVICE_TOKEN: 'service-ref' },
          }),
        }),
      ),
    );
    expect(await screen.findByText('Pinned source')).toBeTruthy();
  });
  it('restores the exact agent digest from history', async () => {
    renderApp('/agents/reviewer%2Fdefault');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Restore 0.2.0' }));
    await user.click(screen.getByRole('button', { name: 'Confirm restore' }));
    await waitFor(() =>
      expect(calls().rollbackAgentDefinition).toHaveBeenCalledWith({
        params: { id: agent.id },
        body: { sha: 'c'.repeat(40), digest: 'older' },
      }),
    );
  });
});
