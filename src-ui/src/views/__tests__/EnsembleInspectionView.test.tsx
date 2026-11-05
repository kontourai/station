/** @vitest-environment jsdom */

import type { CliSessionGroupView } from '@kontourai/station-contracts/delegation-group';
import type { EnsembleInspection } from '@kontourai/station-contracts/ensemble';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { type ReactNode, Suspense } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AppViewContent } from '../../app-shell/AppViewContent';
import { resolveViewFromPath } from '../../app-shell/routing';
import {
  NavigationProvider,
  navigationStore,
  useNavigation,
} from '../../contexts/NavigationContext';
import { EnsembleInspectionResult } from '../EnsembleInspectionResult';

const owner = vi.hoisted(() => ({
  current: true,
  key: 'operator-a',
  editorReads: 0,
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'https://station.test',
    authorityKey: owner.key,
    isCurrent: () => owner.current,
  }),
}));
vi.mock('@kontourai/station-sdk', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk')>()),
  useAgentsQuery: () => ({ isLoading: false, isError: false }),
}));
vi.mock('../agent-editor/useAgentsViewModel', () => ({
  useAgentsViewModel: () => {
    owner.editorReads++;
    if (window.location.search.includes('ensembles'))
      throw new Error('Inspector mounted editor queries');
    return {
      DiscardModal: () => null,
      listItems: [],
      selectedAgent: undefined,
    };
  },
}));
vi.mock('../agent-editor/AgentsViewEditorPane', () => ({
  AgentsViewEditorPane: () => null,
}));
vi.mock('../../components/SplitPaneLayout', () => ({
  SplitPaneLayout: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock('../../app-shell/RouteViewBoundary', () => ({
  RouteViewBoundary: ({ children }: { children: ReactNode }) => (
    <Suspense fallback="Loading">{children}</Suspense>
  ),
}));

const result: EnsembleInspection = {
  version: 'station.ensemble.inspection/v1',
  source: {
    sha256: `sha256:${'a'.repeat(64)}`,
    presetId: 'team',
    name: 'Review team',
    stationmaster: 'lead',
  },
  environmentId: 'local',
  observedAt: '2026-10-21T00:00:00Z',
  resolutions: [],
  facts: [
    {
      id: 'member:lead',
      memberId: 'lead',
      category: 'members/models',
      label: 'Lead',
      value: 'codex / selected-model',
      origin: 'authored',
      state: 'configured',
      owner: { label: 'Agent settings', href: '/agents/reviewer' },
    },
    ...(
      [
        'routing/triggers',
        'tools/services',
        'workspace',
        'memory',
        'schedules/webhooks',
        'output destinations',
      ] as const
    ).map((category) => ({
      id: category,
      category,
      label: category,
      value: 'Owner facts unavailable',
      origin: 'unknown' as const,
      state: 'unavailable' as const,
      owner: { label: 'Preset source' },
    })),
  ],
  limits:
    'Authentication, entitlement, execution limits and live group bindings are unverified.',
};

function Harness() {
  const nav = useNavigation();
  return (
    <AppViewContent
      currentView={resolveViewFromPath(
        `${nav.pathname}${window.location.search}`,
      )}
      agents={[]}
      availableModels={[]}
      apiBase="https://station.test"
      onNavigate={() => {}}
      onShowHome={() => {}}
      onReturnToOutlet={() => {}}
      onSettingsSaved={() => {}}
    />
  );
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <NavigationProvider>
        <Harness />
      </NavigationProvider>
    </QueryClientProvider>,
  );
  return client;
}
beforeEach(() => {
  setClientCredentialResolver(() => ({
    origin: 'https://station.test',
    credential: 'test-only',
    requestAuthority: {
      apiBase: 'https://station.test',
      authorityKey: owner.key,
      isCurrent: () => owner.current,
    },
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
  owner.current = true;
  owner.key = 'operator-a';
  owner.editorReads = 0;
});

test('declared prerequisite arrows link to their own configuration facts across inspector instances', () => {
  const inspected: EnsembleInspection = {
    ...result,
    facts: [
      ...result.facts,
      {
        id: 'member:peer',
        memberId: 'peer',
        category: 'members/models',
        label: 'Peer',
        value: 'codex / selected-model',
        origin: 'authored',
        state: 'configured',
        owner: { label: 'Peer settings', href: '/agents/peer' },
      },
      {
        id: 'needs:peer',
        memberId: 'peer',
        needs: ['lead'],
        category: 'routing/triggers',
        label: 'Declared prerequisites',
        value: 'lead → peer',
        origin: 'authored',
        state: 'configured',
        owner: { label: 'Group dependency draft' },
      },
      ...['lead', 'peer'].map((memberId) => ({
        id: `workspace:${memberId}`,
        memberId,
        category: 'workspace' as const,
        label: 'Workspace',
        value: 'Selected directory',
        origin: 'authored' as const,
        state: 'configured' as const,
        owner: { label: 'Group workspace draft' },
      })),
    ],
  };
  render(
    <NavigationProvider>
      <EnsembleInspectionResult result={inspected} />
      <EnsembleInspectionResult result={inspected} />
    </NavigationProvider>,
  );
  for (const memberId of ['lead', 'peer']) {
    const nodes = screen.getAllByRole('link', {
      name: `Inspect ${memberId}: Workspace`,
    });
    expect(nodes).toHaveLength(2);
    for (const node of nodes) {
      const factId = node.getAttribute('href')?.slice(1);
      expect(document.getElementById(factId ?? '')?.textContent).toContain(
        `${memberId}: Workspace`,
      );
    }
  }
  const links = screen.getAllByRole('link', {
    name: 'Inspect declared prerequisite lead → peer',
  });
  expect(links).toHaveLength(2);
  const targets = links.map((link) => link.getAttribute('href')?.slice(1));
  expect(new Set(targets).size).toBe(2);
  for (const factId of targets)
    expect(document.getElementById(factId ?? '')?.textContent).toContain(
      'lead → peer',
    );
  const diagrams = screen.getAllByRole('group', {
    name: /Member configuration relationships/,
  });
  for (const diagram of diagrams) {
    const arrows = diagram.querySelectorAll('path[marker-end]');
    expect(arrows).toHaveLength(1);
    expect(arrows[0].textContent?.trim()).toBe(
      'Declared prerequisite lead → peer',
    );
  }
});

test('the visible Agents action reaches the real SDK inspector without editor queries or URL path disclosure', async () => {
  navigationStore.navigate('/agents');
  const fetch = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ success: true, data: result })),
  );
  vi.stubGlobal('fetch', fetch);
  const client = mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Inspect an Ensemble' }),
  );
  expect(window.location.search).toBe('?tab=ensembles');
  await screen.findByRole('heading', { name: 'Inspect an Ensemble' });
  expect(owner.editorReads).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Preset path on This Station'), {
    target: { value: '/private/team.json' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Inspect configuration' }),
  );
  await screen.findByRole('table', {
    name: 'Ensemble configuration and provenance',
  });
  expect(fetch.mock.calls).toHaveLength(1);
  expect(window.location.href).not.toContain('private');
  expect(
    JSON.stringify(
      client
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.options.mutationKey),
    ),
  ).not.toContain('private');
  for (const category of [
    'routing/triggers',
    'tools/services',
    'workspace',
    'memory',
    'schedules/webhooks',
    'output destinations',
  ])
    expect(screen.getAllByText(category).length).toBeGreaterThan(0);
  expect(
    screen.getByRole('group', { name: /Member configuration relationships/ }),
  ).toBeDefined();
  const agent = screen.getByLabelText('Agent ID');
  fireEvent.change(agent, { target: { value: 'reviewer' } });
  fireEvent.change(screen.getByLabelText('Project ID'), {
    target: { value: 'project' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Inspect configuration' }),
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  const secondRequest = fetch.mock.calls[1];
  expect(JSON.parse(String(secondRequest[1]?.body))).toEqual({
    path: '/private/team.json',
    expectedPresetHash: result.source.sha256,
    bindings: { lead: { agent: 'reviewer', projectSlug: 'project' } },
  });
  await screen.findByRole('table', {
    name: 'Ensemble configuration and provenance',
  });
  fireEvent.click(screen.getByRole('link', { name: 'Agent settings' }));
  expect(window.location.pathname).toBe('/agents/reviewer');
});

test('the inspector withholds a pending result when current authority is lost', async () => {
  navigationStore.navigate('/agents?tab=ensembles');
  let settle: ((response: Response) => void) | undefined;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        settle = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetch);
  mount();
  fireEvent.change(
    await screen.findByLabelText('Preset path on This Station'),
    { target: { value: '/private/team.json' } },
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Inspect configuration' }),
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  owner.current = false;
  if (!settle) throw new Error('Transport did not receive inspection');
  settle(new Response(JSON.stringify({ success: true, data: result })));
  await screen.findByRole('alert');
  expect(screen.queryByRole('table')).toBeNull();
});

test.each([403, 409])(
  'a %s response shows denied/stale guidance and no earlier facts',
  async (status) => {
    navigationStore.navigate('/agents?tab=ensembles');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: result })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: false,
            code:
              status === 403
                ? 'ensemble_inspection_authority_required'
                : 'ensemble_inspection_stale',
          }),
          { status },
        ),
      );
    vi.stubGlobal('fetch', fetch);
    mount();
    fireEvent.change(
      await screen.findByLabelText('Preset path on This Station'),
      { target: { value: '/private/team.json' } },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect configuration' }),
    );
    await screen.findByRole('table', {
      name: 'Ensemble configuration and provenance',
    });
    expect(screen.getByRole('heading', { name: 'Review team' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Agent settings' })).toBeDefined();
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect configuration' }),
    );
    expect((await screen.findByRole('alert')).textContent).toContain(
      status === 403 ? 'Inspection denied' : 'Inspection is stale',
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Review team' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Agent settings' })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(owner.editorReads).toBe(0);
  },
);

const savedGroup: CliSessionGroupView = {
  version: 'station.cli-session-group/v1',
  groupId: 'cli-saved',
  revision: 0,
  supervision: 'not-running',
  cancelled: false,
  deadlineAt: Date.now() + 60_000,
  maxConcurrent: 1,
  dispatchCount: 0,
  guarantees: {
    authority: 'station-session',
    portableFlowLineage: 'unbound',
    dollarCap: 'unavailable',
    tokenCap: 'unavailable',
    physicalAttemptCap: 'unavailable',
    deadline: 'stop-admission-and-request-interruption',
  },
  flow: {
    runId: 'cli-saved',
    definition: { id: 'cli-saved', version: '1', digest: 'definition' },
    status: 'active',
  },
  acceptance: 'unassessed',
  members: [{ seatId: 'lead', needs: [], state: 'pending' }],
};

async function draftGroup() {
  fireEvent.change(
    await screen.findByLabelText('Preset path on This Station'),
    { target: { value: '/private/team.json' } },
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Inspect configuration' }),
  );
  await screen.findByRole('button', { name: 'Create a CLI session group' });
  fireEvent.click(
    screen.getByRole('button', { name: 'Create a CLI session group' }),
  );
  for (const [label, value] of [
    ['Shared brief', 'Review this work.'],
    ['Agent ID for lead', 'reviewer'],
    ['Engine connection ID for lead', 'opencode'],
    ['Working directory on This Station for lead', '/work'],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

test('preset creation saves exact scoped bindings without starting engines; explicit run and cancellation use the same group', async () => {
  navigationStore.navigate('/agents?tab=ensembles');
  let finishRun: ((response: Response) => void) | undefined;
  const fetch = vi.fn(async (url: unknown, _init?: RequestInit) => {
    if (String(url).endsWith('/inspect'))
      return new Response(JSON.stringify({ success: true, data: result }));
    if (String(url).endsWith('/run'))
      return new Promise<Response>((resolve) => {
        finishRun = resolve;
      });
    return new Response(JSON.stringify({ success: true, data: savedGroup }));
  });
  vi.stubGlobal('fetch', fetch);
  mount();
  await draftGroup();
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Reload source' }));
  await screen.findByRole('dialog', { name: 'Unsaved Changes' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(
    (screen.getByLabelText('Shared brief') as HTMLTextAreaElement).value,
  ).toBe('Review this work.');
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText('Maximum reserved starts'), {
    target: { value: '0' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save session group' }));
  await screen.findByText(/Saved session group/);
  expect(fetch).toHaveBeenCalledTimes(2);
  const [url, init] = fetch.mock.calls[1];
  expect(String(url)).toBe(
    'https://station.test/api/orchestration/session-groups/from-ensemble',
  );
  const input = JSON.parse(String(init?.body));
  expect(input).toMatchObject({
    path: '/private/team.json',
    expectedPresetHash: result.source.sha256,
    brief: 'Review this work.',
    maxConcurrent: 1,
    maxDispatches: 0,
    bindings: {
      lead: {
        target: {
          agent: 'reviewer',
          expectedEngine: { kind: 'connection', connectionId: 'opencode' },
          workspace: { kind: 'directory', cwd: '/work' },
        },
        needs: [],
      },
    },
  });
  expect(input.operationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(input.deadlineAt).toBeGreaterThan(Date.now());
  expect(input.bindings.lead.target.model).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: 'Run session group' }));
  await waitFor(() => expect(finishRun).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: 'Cancel session group' }));
  await screen.findByText(
    'Cancellation requested. Engine termination is not proven.',
  );
  expect(fetch.mock.calls.map(([request]) => String(request))).toEqual([
    'https://station.test/api/orchestration/ensembles/inspect',
    'https://station.test/api/orchestration/session-groups/from-ensemble',
    'https://station.test/api/orchestration/session-groups/cli-saved/run',
    'https://station.test/api/orchestration/session-groups/cli-saved/cancel',
  ]);
  finishRun!(
    new Response(
      JSON.stringify({
        success: true,
        data: {
          ...savedGroup,
          cancelled: true,
          maxDispatches: 0,
          admissionClosed: 'dispatch-limit-exhausted',
        },
      }),
    ),
  );
  await screen.findByText('Flow: active. Work acceptance: not assessed.');
  expect(
    screen.getByText(
      'Dispatch allowance exhausted. No additional starts can be reserved.',
    ),
  ).toBeDefined();
  expect(
    screen
      .getByRole('button', { name: 'Run session group' })
      .hasAttribute('disabled'),
  ).toBe(true);
});

test('a late group-create response cannot publish or cache success after authority loss and is not resubmitted', async () => {
  navigationStore.navigate('/agents?tab=ensembles');
  let finish: ((response: Response) => void) | undefined;
  const fetch = vi.fn(async (url: unknown) =>
    String(url).endsWith('/inspect')
      ? new Response(JSON.stringify({ success: true, data: result }))
      : new Promise<Response>((resolve) => {
          finish = resolve;
        }),
  );
  vi.stubGlobal('fetch', fetch);
  const client = mount();
  await draftGroup();
  fireEvent.click(screen.getByRole('button', { name: 'Save session group' }));
  await waitFor(() => expect(finish).toBeDefined());
  owner.current = false;
  finish!(new Response(JSON.stringify({ success: true, data: savedGroup })));
  await screen.findByText(
    'Station authority changed. Reopen the inspector before creating a group.',
  );
  const mutation = client
    .getMutationCache()
    .getAll()
    .find(
      (entry) => entry.options.mutationKey?.[0] === 'ensemble-cli-group-create',
    );
  expect(mutation?.state.status).toBe('error');
  expect(mutation?.state.error).toBeDefined();
  expect(mutation?.state.data).toBeUndefined();
  expect(screen.queryByText(/Saved session group/)).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('leaving the group form aborts pending run supervision and settles the waiting mutation without a resend', async () => {
  navigationStore.navigate('/agents?tab=ensembles');
  let runSignal: AbortSignal | undefined;
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/inspect'))
      return new Response(JSON.stringify({ success: true, data: result }));
    if (String(url).endsWith('/run'))
      return new Promise<Response>((_resolve, reject) => {
        runSignal = init?.signal ?? undefined;
        runSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('Run interrupted', 'AbortError')),
          { once: true },
        );
      });
    return new Response(JSON.stringify({ success: true, data: savedGroup }));
  });
  vi.stubGlobal('fetch', fetch);
  const client = mount();
  await draftGroup();
  fireEvent.click(screen.getByRole('button', { name: 'Save session group' }));
  await screen.findByText(/Saved session group/);
  fireEvent.click(screen.getByRole('button', { name: 'Run session group' }));
  await waitFor(() => expect(runSignal).toBeDefined());
  const mutation = client
    .getMutationCache()
    .getAll()
    .find((entry) => entry.options.mutationKey?.[0] === 'cli-group-run');
  fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
  await waitFor(() => expect(runSignal?.aborted).toBe(true));
  await waitFor(() => expect(mutation?.state.status).toBe('error'));
  expect(mutation?.state.error).toBeDefined();
  expect(mutation?.state.data).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(3);
});

test('a selected local preset submits its exact bytes without a host-file inspection request', async () => {
  const { File } = await import('node:buffer');
  const { createHash, webcrypto } = await import('node:crypto');
  vi.stubGlobal('crypto', webcrypto);
  navigationStore.navigate('/agents?tab=ensembles');
  const json = `${JSON.stringify({ version: 'station.ensemble/v1', id: 'team', name: 'Uploaded team', stationmaster: 'lead', members: [{ id: 'lead', codename: 'Lead', color: '#123ABC', role: 'Review', engine: 'opencode', model: 'chosen-model', reasoning: null, options: {}, promptAppends: ['Preserve this.'] }] })}\n`;
  const fetch = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ success: true, data: savedGroup })),
  );
  vi.stubGlobal('fetch', fetch);
  mount();
  fireEvent.change(
    await screen.findByLabelText('Preset file from this device'),
    {
      target: {
        files: [new File([json], 'team.json', { type: 'application/json' })],
      },
    },
  );
  await screen.findByRole('heading', { name: 'Uploaded team' });
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Create a CLI session group' }),
  );
  for (const [label, value] of [
    ['Shared brief', 'Review'],
    ['Agent ID for lead', 'reviewer'],
    ['Engine connection ID for lead', 'opencode'],
    ['Working directory on This Station for lead', '/work'],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const replacement = json.replace('Uploaded team', 'Replacement team');
  fireEvent.change(screen.getByLabelText('Preset file from this device'), {
    target: {
      files: [
        new File([replacement], 'replacement.json', {
          type: 'application/json',
        }),
      ],
    },
  });
  await screen.findByRole('dialog', { name: 'Unsaved Changes' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await screen.findByText(
    'File selection cancelled. The current preset and draft are unchanged.',
  );
  expect(screen.getByRole('heading', { name: 'Uploaded team' })).toBeDefined();
  expect(
    screen.queryByRole('heading', { name: 'Replacement team' }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save session group' }));
  await screen.findByText(/Saved session group/);
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0];
  expect(String(url)).toBe(
    'https://station.test/api/orchestration/session-groups/from-ensemble',
  );
  const input = JSON.parse(String(init?.body));
  expect(input.presetJson).toBe(json);
  expect(input.path).toBeUndefined();
  expect(input.expectedPresetHash).toBe(
    `sha256:${createHash('sha256').update(json).digest('hex')}`,
  );
});

test.each(['Agent ID for lead', 'Engine connection ID for lead'])(
  'invalid %s keeps the draft and permits correction before any creation request',
  async (label) => {
    navigationStore.navigate('/agents?tab=ensembles');
    const fetch = vi.fn(
      async (url: unknown) =>
        new Response(
          JSON.stringify({
            success: true,
            data: String(url).endsWith('/inspect') ? result : savedGroup,
          }),
        ),
    );
    vi.stubGlobal('fetch', fetch);
    mount();
    await draftGroup();
    fireEvent.change(screen.getByLabelText(label), {
      target: { value: 'Not Clean' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save session group' }));
    await screen.findByText(
      'Check the Agent and engine connection IDs, member dependencies and group limits. Nothing was submitted.',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reload source' }));
    await screen.findByRole('dialog', { name: 'Unsaved Changes' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.change(screen.getByLabelText(label), {
      target: { value: label.startsWith('Agent') ? 'reviewer' : 'opencode' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save session group' }));
    await screen.findByText(/Saved session group/);
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

test('group inspection uses the launch draft and discards its facts when the draft changes without saving or running', async () => {
  navigationStore.navigate('/agents?tab=ensembles');
  const fetch = vi.fn(
    async (url: unknown, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          success: true,
          data: String(url).endsWith('/inspect') ? result : savedGroup,
        }),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  mount();
  await draftGroup();
  fireEvent.click(
    screen.getByRole('button', { name: 'Inspect group configuration' }),
  );
  await screen.findByText(
    'Saving and running check the current configuration again.',
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  const [url, init] = fetch.mock.calls[1];
  expect(String(url)).toBe(
    'https://station.test/api/orchestration/ensembles/inspect',
  );
  expect(JSON.parse(String(init?.body))).toEqual({
    path: '/private/team.json',
    expectedPresetHash: result.source.sha256,
    bindings: {},
    groupBindings: {
      lead: {
        target: {
          agent: 'reviewer',
          expectedEngine: { kind: 'connection', connectionId: 'opencode' },
          workspace: { kind: 'directory', cwd: '/work' },
        },
        needs: [],
      },
    },
  });
  expect(
    screen.getAllByRole('table', {
      name: 'Ensemble configuration and provenance',
    }),
  ).toHaveLength(2);
  fireEvent.change(
    screen.getByLabelText('Working directory on This Station for lead'),
    { target: { value: '/changed' } },
  );
  await waitFor(() =>
    expect(
      screen.queryByText(
        'Saving and running check the current configuration again.',
      ),
    ).toBeNull(),
  );
  expect(
    screen.getAllByRole('table', {
      name: 'Ensemble configuration and provenance',
    }),
  ).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/Saved session group/)).toBeNull();
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Use a Project binding for lead' }),
  );
  expect(
    screen.queryByLabelText('Working directory on This Station for lead'),
  ).toBeNull();
  fireEvent.change(
    screen.getByLabelText('Project ID on This Station for lead'),
    { target: { value: '7-selected-project' } },
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Inspect group configuration' }),
  );
  await screen.findByText(
    'Saving and running check the current configuration again.',
  );
  expect(fetch).toHaveBeenCalledTimes(3);
  const inspected = JSON.parse(String(fetch.mock.calls[2][1]?.body));
  expect(inspected.groupBindings.lead.target.workspace).toEqual({
    kind: 'project',
    projectSlug: '7-selected-project',
  });
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Use a Project binding for lead' }),
  );
  expect(
    (
      screen.getByLabelText(
        'Working directory on This Station for lead',
      ) as HTMLInputElement
    ).value,
  ).toBe('/changed');
  expect(
    screen.queryByLabelText('Project ID on This Station for lead'),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Use a Project binding for lead' }),
  );
  expect(
    (
      screen.getByLabelText(
        'Project ID on This Station for lead',
      ) as HTMLInputElement
    ).value,
  ).toBe('7-selected-project');
  fireEvent.click(screen.getByRole('button', { name: 'Save session group' }));
  await screen.findByText(/Saved session group/);
  expect(fetch).toHaveBeenCalledTimes(4);
  const saved = JSON.parse(String(fetch.mock.calls[3][1]?.body));
  expect(saved.bindings).toEqual(inspected.groupBindings);
});

test('engine sign-in is checked only after the current host offers it, and editing the receiver clears the offer', async () => {
  navigationStore.navigate('/agents?tab=ensembles');
  let inspections = 0;
  const fetch = vi.fn(async (url: unknown, _init?: RequestInit) => {
    expect(String(url).endsWith('/inspect')).toBe(true);
    inspections++;
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          ...result,
          ...(inspections > 1
            ? { authenticationCheck: { state: 'available' } }
            : {}),
        },
      }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  mount();
  await draftGroup();
  fireEvent.change(screen.getByLabelText('Engine connection ID for lead'), {
    target: { value: 'codex' },
  });
  expect(
    screen.queryByRole('button', { name: 'Check engine sign-in' }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'Inspect group configuration' }),
  );
  const check = await screen.findByRole('button', {
    name: 'Check engine sign-in',
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).not.toHaveProperty(
    'verifyAuthentication',
  );
  fireEvent.click(check);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(JSON.parse(String(fetch.mock.calls[2][1]?.body))).toMatchObject({
    verifyAuthentication: true,
    expectedPresetHash: result.source.sha256,
    groupBindings: {
      lead: {
        target: {
          expectedEngine: { kind: 'connection', connectionId: 'codex' },
        },
      },
    },
  });
  await screen.findByRole('button', { name: 'Check engine sign-in' });
  fireEvent.change(screen.getByLabelText('Engine connection ID for lead'), {
    target: { value: 'claude' },
  });
  expect(
    screen.queryByRole('button', { name: 'Check engine sign-in' }),
  ).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Inspect group configuration' }),
  ).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(screen.queryByText(/Saved session group/)).toBeNull();
});
