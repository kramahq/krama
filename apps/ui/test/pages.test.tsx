import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@kramahq/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiMock, events, resetApi } from './api-mock';
import { capabilities, decision, me, projects, run } from './fixtures';
import { renderApp } from './render';

vi.mock('@/api/client', async () => {
  const m = await import('./api-mock');
  return { api: m.apiMock, API_BASE: '/api/v1' };
});

type Spies = Record<string, ReturnType<typeof vi.fn>>;
const runs = () => apiMock.runs as Spies;
const decisions = () => apiMock.decisions as Spies;
const page = <T,>(items: T[]) => ({ items, total: items.length });

beforeEach(() => {
  resetApi();
  localStorage.clear();
});

describe('Inbox', () => {
  const pending = [
    decision({
      id: 'dec_a',
      title: 'Older question',
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    }),
    decision({
      id: 'dec_b',
      kind: 'access',
      title: 'Agent wants a folder',
      runId: 'run_1',
      access: { path: '~/Downloads/spec.pdf', agent: 'dev-2', mode: 'read' },
      options: [
        { id: 'allow_once', label: 'Allow once', effect: 'One read' },
        { id: 'allow_project', label: 'Allow for project', effect: 'Remembered' },
        { id: 'deny', label: 'Deny', style: 'danger', effect: 'Carries on without it' },
      ],
    } as never),
    decision({ id: 'dec_c', kind: 'consent', title: 'Install a pack', runId: undefined as never }),
  ];
  beforeEach(() => {
    decisions().list!.mockResolvedValue(page(pending));
    runs().list!.mockResolvedValue(page([run({ status: 'awaiting_decision' })]));
  });

  it('lists what is waiting, says what is holding a run up, and filters by kind', async () => {
    const user = userEvent.setup();
    renderApp('/inbox');
    expect(await screen.findByText('3 waiting · 2 are holding a run up')).toBeTruthy();
    const list = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    // The two that belong to the stopped run come before the one that belongs to none.
    expect(list.findIndex((t) => t.includes('Install a pack'))).toBe(2);
    expect(screen.getAllByText('Blocks run')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: /^Access/ }));
    await waitFor(() => expect(screen.queryByText('Older question')).toBeNull());
    expect(screen.getByText('Agent wants a folder')).toBeTruthy();
  });

  it('asks for a note when the chosen answer needs one, and sends the answer', async () => {
    const user = userEvent.setup();
    renderApp('/inbox?id=dec_a');
    const confirm = await screen.findByRole('button', { name: 'Choose an answer' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByLabelText(/Request changes/));
    const send = screen.getByRole('button', { name: /Confirm: Request changes/ });
    expect((send as HTMLButtonElement).disabled).toBe(true); // a note is required
    await user.type(screen.getByLabelText(/Your notes/), 'Tighten the scope');
    expect((send as HTMLButtonElement).disabled).toBe(false);
    await user.click(send);
    await waitFor(() =>
      expect(decisions().resolve).toHaveBeenCalledWith('dec_a', {
        optionId: 'changes',
        input: 'Tighten the scope',
      }),
    );
  });

  it('starts each decision with a clean form, not with the previous answer', async () => {
    const user = userEvent.setup();
    renderApp('/inbox?id=dec_a');
    await user.click(await screen.findByLabelText(/Request changes/));
    await user.type(screen.getByLabelText(/Your notes/), 'half-written');
    await user.click(screen.getByRole('link', { name: /Agent wants a folder/ }));
    expect(await screen.findByText('~/Downloads/spec.pdf')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose an answer' })).toBeTruthy();
    await user.click(screen.getByRole('link', { name: /Older question/ }));
    await user.click(await screen.findByLabelText(/Request changes/));
    expect((screen.getByLabelText(/Your notes/) as HTMLTextAreaElement).value).toBe('');
  });

  it('shows what an access request is about and sends the scope that was chosen', async () => {
    const user = userEvent.setup();
    renderApp('/inbox?id=dec_b');
    expect(await screen.findByText('~/Downloads/spec.pdf')).toBeTruthy();
    expect(screen.getByText('read this')).toBeTruthy();
    await user.click(screen.getByLabelText(/Allow for project/));
    await user.click(screen.getByRole('button', { name: /Confirm: Allow for project/ }));
    await waitFor(() =>
      expect(decisions().resolve).toHaveBeenCalledWith('dec_b', {
        optionId: 'allow_project',
        scope: 'project',
      }),
    );
  });

  it('does not let you answer twice when more approvers are needed', async () => {
    decisions().list!.mockResolvedValue(
      page([
        decision({
          id: 'dec_m',
          need: 2,
          approvals: [
            {
              optionId: 'approve',
              by: { type: 'user', id: me.id, name: 'Priya' },
              at: new Date().toISOString(),
            },
          ] as never,
        }),
      ]),
    );
    renderApp('/inbox?id=dec_m');
    expect(await screen.findByText('1 of 2 approvals')).toBeTruthy();
    expect(screen.getByText(/You already answered this/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Confirm/ })).toBeNull();
  });

  it('says plainly when someone else got there first', async () => {
    decisions().resolve!.mockRejectedValue(
      new ApiError('Already resolved', 409, {
        type: 'x',
        title: 'Conflict',
        status: 409,
        code: 'decision_resolved',
      }),
    );
    const user = userEvent.setup();
    renderApp('/inbox?id=dec_a');
    await user.click(await screen.findByLabelText(/^Approve/));
    await user.click(screen.getByRole('button', { name: /Confirm: Approve/ }));
    expect(await screen.findByText('Someone already resolved this')).toBeTruthy();
  });

  it('narrows to the project, but always shows what belongs to no run', async () => {
    runs().list!.mockResolvedValue(
      page([run({ id: 'run_1', projectId: 'proj_oss', status: 'running' })]),
    );
    localStorage.setItem('krama.project', 'proj_pay');
    renderApp('/inbox');
    expect(await screen.findByText('Install a pack')).toBeTruthy(); // not tied to a run
    expect(screen.queryByText('Older question')).toBeNull(); // belongs to a run in another project
  });

  it('is calm when nothing is waiting', async () => {
    decisions().list!.mockResolvedValue(page([]));
    renderApp('/inbox');
    expect(await screen.findByText('Nothing is waiting for you')).toBeTruthy();
    expect(screen.getByText('All clear')).toBeTruthy();
  });

  it('explains a failure to load instead of showing an empty inbox', async () => {
    decisions().list!.mockRejectedValue(new ApiError('Cannot reach the Krama server', 0));
    renderApp('/inbox');
    expect(await screen.findByText('Cannot reach the Krama server')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('Runs', () => {
  const several = [
    run({ id: 'run_a', title: 'Alpha run', status: 'running' }),
    run({ id: 'run_b', title: 'Bravo run', status: 'awaiting_decision' }),
    run({ id: 'run_c', title: 'Charlie run', status: 'failed' }),
    run({
      id: 'run_d',
      title: 'Delta run',
      status: 'completed',
      workItem: { source: 'jira', ref: 'PAY-9' },
    }),
    run({
      id: 'run_e',
      title: 'Echo run',
      status: 'blocked',
      budget: {
        max: { amount: 15, currency: 'USD' },
        spent: null,
        warnAtPct: 80,
        onExceed: 'pause',
      },
    }),
  ];
  beforeEach(() => runs().list!.mockResolvedValue(page(several)));

  it('filters by what a person cares about, with counts', async () => {
    const user = userEvent.setup();
    renderApp('/runs');
    expect(await screen.findByText('Alpha run')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Needs you\s*2/ })).toBeTruthy(); // awaiting a decision + blocked
    await user.click(screen.getByRole('radio', { name: /Failed/ }));
    expect(await screen.findByText('Charlie run')).toBeTruthy();
    expect(screen.queryByText('Alpha run')).toBeNull();
  });

  it('searches by title or ticket', async () => {
    const user = userEvent.setup();
    renderApp('/runs');
    await screen.findByText('Alpha run');
    await user.type(screen.getByRole('searchbox'), 'pay-9');
    await waitFor(() => expect(screen.queryByText('Alpha run')).toBeNull());
    expect(screen.getByText('Delta run')).toBeTruthy();
  });

  it('says "not reported" when a run has no reported spend, and does not draw it as zero', async () => {
    renderApp('/runs');
    const row = (await screen.findByText('Echo run')).closest('a')!;
    expect(within(row).getByText('not reported')).toBeTruthy();
  });

  it('asks the API for only the selected project', async () => {
    localStorage.setItem('krama.project', 'proj_oss');
    renderApp('/runs');
    await screen.findByText('Alpha run');
    expect(runs().list).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'proj_oss' }),
      expect.anything(),
    );
  });
});

describe('Run detail', () => {
  it('shows an interrupted run with one Resume, and does not claim the phase is still working', async () => {
    const user = userEvent.setup();
    runs().get!.mockResolvedValue(
      run({ status: 'interrupted', statusReason: 'Server restarted mid-phase' }),
    );
    renderApp('/runs/run_1');
    expect(await screen.findByText('This run was interrupted')).toBeTruthy();
    expect(
      screen.getByText(/Server restarted mid-phase\. Nothing already done is repeated/),
    ).toBeTruthy(); // ended properly
    expect(screen.getAllByRole('button', { name: /Resume/ })).toHaveLength(1);
    expect(screen.getByLabelText('Interrupted here')).toBeTruthy();
    expect(screen.queryByLabelText('Working')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Resume/ }));
    await waitFor(() => expect(runs().resume).toHaveBeenCalledWith('run_1'));
  });

  it('shows the cost of a phase that spent nothing yet as blank, not "not reported"', async () => {
    renderApp('/runs/run_1');
    await screen.findByText('Construction');
    const operations = screen.getByText('Operations').closest('li')!;
    expect(within(operations).queryByText('not reported')).toBeNull();
    const construction = screen.getByText('Construction').closest('li')!;
    expect(within(construction).getByText('not reported')).toBeTruthy(); // started, provider reported nothing
  });

  it('lists only the backends the platform allows', async () => {
    renderApp('/runs/run_1');
    expect(await screen.findByText('Allowed backends: claude')).toBeTruthy();
    expect(screen.queryByText(/copilot/)).toBeNull();
  });

  it('shows a failed run with its reason', async () => {
    runs().get!.mockResolvedValue(
      run({ status: 'failed', statusReason: 'Render timed out after 3 retries' }),
    );
    renderApp('/runs/run_1');
    expect(await screen.findByText('This run failed')).toBeTruthy();
    expect(screen.getByText('Render timed out after 3 retries.')).toBeTruthy();
  });

  it('points at what is waiting for a person', async () => {
    runs().decisions!.mockResolvedValue(
      page([decision({ id: 'dec_z', title: 'Approve the plan' })]),
    );
    renderApp('/runs/run_1');
    expect(await screen.findByText('This run is waiting for you')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Approve the plan' }).getAttribute('href')).toContain(
      '/inbox?id=dec_z',
    );
  });

  it('opens Activity from the tab and keeps it in the address', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/runs/run_1');
    await user.click(await screen.findByRole('tab', { name: 'Activity' }));
    expect(await screen.findByText('No activity yet')).toBeTruthy();
    expect(router.state.location.search).toEqual({ tab: 'activity' });
  });

  it('explains a run that does not exist', async () => {
    runs().get!.mockRejectedValue(
      new ApiError('Run not found', 404, {
        type: 'x',
        title: 'Not found',
        status: 404,
        code: 'not_found',
      }),
    );
    renderApp('/runs/run_missing');
    expect(await screen.findByText('Not found')).toBeTruthy();
  });
});

describe('the shell', () => {
  it('hides what the server does not offer', async () => {
    (apiMock.capabilities as ReturnType<typeof vi.fn>).mockResolvedValue(
      capabilities({
        builder: false,
        schedules: { enabled: false, triggers: [] } as never,
        memory: { enabled: false, scopes: [], export: [], gitSync: false } as never,
      }),
    );
    renderApp('/runs');
    await screen.findByRole('link', { name: /Runs/ });
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Studio' })).toBeNull());
    expect(screen.queryByRole('link', { name: 'Schedules' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Memory' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Packs' })).toBeTruthy();
  });

  it('remembers the project you chose, and drops the switcher for a single-project server', async () => {
    const user = userEvent.setup();
    renderApp('/runs');
    await user.click(await screen.findByRole('button', { name: 'Switch project' }));
    await user.click(screen.getByRole('menuitemradio', { name: /a2a-wrapper/ }));
    expect(localStorage.getItem('krama.project')).toBe('proj_oss');
    expect(screen.getByRole('button', { name: 'Switch project' }).textContent).toContain(
      'a2a-wrapper',
    );
  });

  it('does not offer a switcher when the server has one project', async () => {
    (apiMock.capabilities as ReturnType<typeof vi.fn>).mockResolvedValue(
      capabilities({ multiProject: false }),
    );
    renderApp('/runs');
    await screen.findByRole('link', { name: /Runs/ });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Switch project' })).toBeNull(),
    );
  });

  it('forgets a remembered project that no longer exists', async () => {
    localStorage.setItem('krama.project', 'proj_gone');
    renderApp('/runs');
    expect((await screen.findByRole('button', { name: 'Switch project' })).textContent).toContain(
      'All projects',
    );
  });

  it('says when the live connection drops, and when it is back', async () => {
    renderApp('/runs');
    expect(await screen.findByText('Live')).toBeTruthy();
    events.last!.onStatus!('reconnecting');
    expect(await screen.findByText('Reconnecting…')).toBeTruthy();
    events.last!.onStatus!('live');
    expect(await screen.findByText('Live')).toBeTruthy();
  });

  it('shows the pending count on Inbox', async () => {
    renderApp('/runs');
    expect(await screen.findByLabelText('1 waiting for you')).toBeTruthy();
  });

  it('closes the phone menu when you go somewhere', async () => {
    const user = userEvent.setup();
    renderApp('/runs');
    await user.click(await screen.findByRole('button', { name: 'Open menu' }));
    const menu = screen.getByRole('dialog', { name: 'Menu' });
    await user.click(within(menu).getByRole('link', { name: 'Packs' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull());
  });

  it('has a page for an address that does not exist', async () => {
    renderApp('/nothing-here');
    expect(await screen.findByText('That page does not exist')).toBeTruthy();
  });
});

describe('New run', () => {
  it('suggests the project’s default pack, starts disabled, and creates the run you described', async () => {
    const user = userEvent.setup();
    localStorage.setItem('krama.project', 'proj_oss');
    const { router } = renderApp('/runs/new');
    const start = await screen.findByRole('button', { name: 'Start run' });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/suggested as the default for a2a-wrapper/)).toBeTruthy();
    expect((screen.getByLabelText(/Explainer/) as HTMLInputElement).checked).toBe(true);

    await user.type(screen.getByLabelText('What should the team do?'), 'Ship the retry fix');
    await user.click(screen.getByLabelText(/AI-DLC/));
    await user.click(screen.getByRole('radio', { name: 'Autopilot' }));
    await user.type(screen.getByLabelText(/Budget cap/), '25');
    expect((start as HTMLButtonElement).disabled).toBe(false);
    await user.click(start);
    await waitFor(() =>
      expect(runs().create).toHaveBeenCalledWith({
        packId: 'pack_a',
        input: { text: 'Ship the retry fix' },
        title: 'Ship the retry fix',
        mode: 'autopilot',
        projectId: 'proj_oss',
        budget: { max: 25 },
      }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/runs/run_new'));
  });

  it('follows the project chosen in the sidebar until you pick another here', async () => {
    const user = userEvent.setup();
    renderApp('/runs/new');
    const select = (await screen.findByLabelText('Project')) as HTMLSelectElement;
    expect(select.value).toBe('');
    await user.click(screen.getByRole('button', { name: 'Switch project' }));
    await user.click(screen.getByRole('menuitemradio', { name: /payments/ }));
    await waitFor(() =>
      expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('proj_pay'),
    );
    await user.selectOptions(screen.getByLabelText('Project'), 'proj_oss');
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('proj_oss');
  });

  it('shows "typical" only from history, and nothing when there is none', async () => {
    const user = userEvent.setup();
    renderApp('/runs/new');
    expect(await screen.findByText('$21.40 per run, across 4 runs')).toBeTruthy();
    await user.click(screen.getByLabelText(/Explainer/));
    expect(await screen.findByText('No history yet, so nothing to compare with.')).toBeTruthy();
  });

  it('rejects a budget that is not a positive number', async () => {
    const user = userEvent.setup();
    renderApp('/runs/new');
    await user.type(await screen.findByLabelText('What should the team do?'), 'x');
    await user.type(screen.getByLabelText(/Budget cap/), 'lots');
    expect((screen.getByRole('button', { name: 'Start run' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

void projects;
