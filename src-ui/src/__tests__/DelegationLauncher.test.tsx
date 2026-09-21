// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DelegationLauncher } from '../components/chat-dock/DelegationLauncher';

const mutateAsync = vi.fn();
const reset = vi.fn();
const retryDiscovery = vi.fn();
let discoveryFailure: Error | null = null;
let mutationError: Error | null = null;
let projectDefaultEnvironment: { kind: 'saved'; id: string } | undefined;
let environmentsFailure = false;
let environmentsLoading = false;
let projectLoading = false;
let projectFailure = false;
let staleDiscoveryEnvironment: string | undefined;
const retryProject = vi.fn();
const retryIdentity = vi.fn();
const discoveryInputs = vi.fn();
interface MockIdentityRepo {
  kind: 'git';
  id: string;
  canonicalRemote: string;
  label?: string;
}
let projectIdentity:
  | {
      identity: {
        id: string;
        repos: MockIdentityRepo[];
        executionRoot?: { repoId: string; path: string };
      };
      association: {
        portableProjectId: string;
        localProjectId: string;
        localProjectSlug: string;
      };
    }
  | undefined;
let identityLoading = false;
let identityFailure = false;
let identityError: unknown = Object.assign(
  new Error(
    'Project identity was not found. An existing Project may need explicit identity preparation.',
  ),
  { status: 404 },
);
let scopeStale = false;

// Per-invocation authority the launcher must freeze into every dispatch:
// the mocked `useHostRequestAuthorityScope` above always reports Home
// `http://station.test` under this key.
const INVOCATION_API_BASE = 'http://station.test';
const INVOCATION_SCOPE = {
  apiBase: 'http://station.test',
  authorityKey: 'ui-scope-test-authority',
};

function singleRepoIdentity() {
  return {
    identity: {
      id: 'portable:station',
      repos: [
        {
          kind: 'git' as const,
          id: 'https://git.example.test/station.git',
          canonicalRemote: 'https://git.example.test/station.git',
          label: 'station',
        },
      ],
      executionRoot: {
        repoId: 'https://git.example.test/station.git',
        path: '.',
      },
    },
    association: {
      portableProjectId: 'portable:station',
      localProjectId: 'project:station',
      localProjectSlug: 'station',
    },
  };
}
let peerCredentials:
  | Array<{
      environmentId: string;
      apiBase: string;
      scope: string;
      label: string | null;
      createdAt: number;
      updatedAt: number;
    }>
  | undefined;

vi.mock('../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'ui-scope-test-authority',
    isCurrent: () => !scopeStale,
  }),
}));

vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  // Bind the REAL failure classifier and scope guard: the states under test
  // are the production branching, not a re-implementation of it.
  const real = await importOriginal<typeof import('@kontourai/station-sdk')>();
  return {
    isApiRequestScope: real.isApiRequestScope,
    projectIdentityReadFailure: real.projectIdentityReadFailure,
    useProjectQuery: () => ({
      data: projectLoading
        ? undefined
        : projectDefaultEnvironment
          ? { defaultEnvironment: projectDefaultEnvironment }
          : {},
      isSuccess: !projectLoading && !projectFailure,
      isError: projectFailure,
      refetch: retryProject,
    }),
    useProjectIdentityQuery: () => ({
      data: identityLoading ? undefined : projectIdentity,
      isSuccess:
        !identityLoading && !identityFailure && projectIdentity !== undefined,
      isError: identityFailure,
      error: identityFailure ? identityError : null,
      refetch: retryIdentity,
    }),
    useDelegationOptionsQuery: (
      input: { environmentId?: string },
      _apiBase: string,
      options: { enabled: boolean },
    ) => {
      if (options.enabled) discoveryInputs(input);
      const error =
        discoveryFailure ??
        (input.environmentId === 'deleted-environment'
          ? new Error('Selected environment is missing')
          : null);
      return {
        data: error
          ? undefined
          : {
              environment: input.environmentId
                ? {
                    id: staleDiscoveryEnvironment ?? input.environmentId,
                    name: 'Brian Media',
                    kind: 'ssh',
                  }
                : {
                    id: 'env-current',
                    name: 'Current environment',
                    kind: 'current',
                  },
              targets: [
                {
                  id: 'codex',
                  kind: 'agent',
                  name: input.environmentId ? 'Remote Codex' : 'Codex',
                  ready: true,
                  defaultModel: 'gpt-5.6-sol',
                  models: [
                    {
                      id: 'gpt-5.6-sol',
                      name: 'GPT-5.6 Sol',
                      originalId: 'gpt-5.6-sol',
                    },
                  ],
                  capabilities: {
                    resume: true,
                    interrupt: true,
                    approvals: true,
                    modelSelection: true,
                  },
                },
                {
                  id: 'reviewer',
                  kind: 'agent',
                  name: 'Reviewer',
                  ready: true,
                  models: [],
                  capabilities: {
                    resume: true,
                    interrupt: true,
                    approvals: false,
                    modelSelection: false,
                  },
                },
                ...(input.environmentId
                  ? [
                      {
                        id: 'claude',
                        kind: 'agent',
                        name: 'Claude Code',
                        ready: false,
                        unavailableReason:
                          'Install the required runtime first.',
                        models: [],
                        capabilities: {
                          resume: false,
                          interrupt: false,
                          approvals: false,
                          modelSelection: false,
                        },
                      },
                    ]
                  : []),
              ],
            },
        error,
        isFetching: false,
        refetch: retryDiscovery,
      };
    },
    useSshEnvironmentsQuery: () => ({
      data:
        environmentsFailure || environmentsLoading
          ? undefined
          : [
              {
                profile: {
                  id: 'media',
                  name: 'Brian Media',
                  environmentId: 'env-media',
                  verifiedProjectPath:
                    '/home/brian/dev/github/kontourai/station',
                },
                state: { phase: 'disconnected' },
              },
            ],
      isSuccess: !environmentsFailure && !environmentsLoading,
      isError: environmentsFailure,
    }),
    // #790: an `access:manage`-gated read — undefined data models the 403 a
    // non-operator browser session receives.
    usePeerCredentialsQuery: () => ({
      data: peerCredentials,
      isSuccess: peerCredentials !== undefined,
      isError: peerCredentials === undefined,
    }),
    useDelegateOrchestrationTaskMutation: () => ({
      mutateAsync,
      reset,
      isPending: false,
      error: mutationError,
    }),
  };
});

describe('DelegationLauncher', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    reset.mockReset();
    retryDiscovery.mockReset();
    discoveryFailure = null;
    mutationError = null;
    environmentsFailure = false;
    environmentsLoading = false;
    projectLoading = false;
    projectFailure = false;
    staleDiscoveryEnvironment = undefined;
    retryProject.mockReset();
    retryIdentity.mockReset();
    discoveryInputs.mockReset();
    projectDefaultEnvironment = undefined;
    projectIdentity = singleRepoIdentity();
    identityLoading = false;
    identityFailure = false;
    identityError = Object.assign(
      new Error(
        'Project identity was not found. An existing Project may need explicit identity preparation.',
      ),
      { status: 404 },
    );
    scopeStale = false;
    peerCredentials = undefined;
    mutateAsync.mockResolvedValue({
      taskId: 'task:1',
      sessionId: 'task:1',
      status: 'dispatched',
      environment: { id: 'env-media', name: 'Brian Media', kind: 'ssh' },
      target: { kind: 'agent', id: 'codex' },
      resumable: true,
    });
  });

  test('keeps the common path task-first and summarizes resolved routing', () => {
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        projectName="Station"
        currentAgentId="codex"
        currentModel="gpt-5.6-sol"
        initialPrompt="Run the bounded task"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );

    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText(/GPT-5.6 Sol/)).toBeTruthy();
    expect(screen.getAllByText(/This Station/).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Run with')).toBeNull();
    expect(screen.queryByLabelText('Run on')).toBeNull();
    expect(screen.queryByText('Default Model')).toBeNull();
    expect(
      screen
        .getByRole('button', { name: 'Change routing' })
        .getAttribute('aria-expanded'),
    ).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));

    expect(screen.getByLabelText('Worker')).toBeTruthy();
    expect(screen.getByLabelText('Station')).toBeTruthy();
    expect(screen.getByLabelText('Model')).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Hide routing' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
  });

  test('shows Agent-only targets and delegates to a saved SSH environment without a Project', async () => {
    const onDelegated = vi.fn();
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        currentAgentId="codex"
        currentModel="gpt-5.6-sol"
        parentTaskId="codex:1721355900000"
        parentTaskLabel="Fix delegation controls"
        initialPrompt="Fix the mobile task controls"
        onClose={vi.fn()}
        onDelegated={onDelegated}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    expect(screen.getByRole('option', { name: 'Codex — Agent' })).toBeTruthy();
    expect(
      screen.getByRole('option', {
        name: 'Reviewer — Agent',
      }),
    ).toBeTruthy();
    expect((screen.getByLabelText('Worker') as HTMLSelectElement).value).toBe(
      'agent:codex',
    );
    expect(screen.getByText('Child worker of')).toBeTruthy();
    expect(screen.getByText('Fix delegation controls')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Station'), {
      target: { value: 'env-media' },
    });
    await waitFor(() =>
      expect((screen.getByLabelText('Worker') as HTMLSelectElement).value).toBe(
        'agent:codex',
      ),
    );
    expect(
      (
        screen.getByRole('option', {
          name: 'Claude Code — Agent (unavailable)',
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByText('1 unavailable on Brian Media'));
    expect(screen.getByText(/Install the required runtime first/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'gpt-5.6-sol' },
    });
    expect(screen.getAllByText(/GPT-5.6 Sol/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));

    // No-Project SSH delegation keeps its explicit semantics: no workspace,
    // no Project substitution — and no SSH repair notice either.
    expect(
      screen.queryByText(/can\u2019t be placed on an SSH Station/),
    ).toBeNull();
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        input: {
          prompt: 'Fix the mobile task controls',
          target: {
            environment: { kind: 'saved', id: 'env-media' },
            agent: 'codex',
            model: { override: 'gpt-5.6-sol' },
          },
          parentTaskId: 'codex:1721355900000',
        },
        apiBase: INVOCATION_API_BASE,
        requestScope: INVOCATION_SCOPE,
      }),
    );
    expect(onDelegated).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task:1' }),
      'Remote Codex',
    );
  });

  test('preselects the project default while an explicit choice still wins', async () => {
    projectDefaultEnvironment = { kind: 'saved', id: 'env-media' };
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        initialPrompt="Use the project environment"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    expect((screen.getByLabelText('Station') as HTMLSelectElement).value).toBe(
      'env-media',
    );
    fireEvent.change(screen.getByLabelText('Station'), {
      target: { value: 'current' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            target: expect.objectContaining({
              environment: { kind: 'current' },
            }),
          }),
          apiBase: INVOCATION_API_BASE,
          requestScope: INVOCATION_SCOPE,
        }),
      ),
    );
  });

  test('preserves a missing project environment and never delegates locally without an explicit choice', async () => {
    projectDefaultEnvironment = { kind: 'saved', id: 'deleted-environment' };
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        initialPrompt="Do not hide the missing environment"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    expect(screen.getByLabelText('Station')).toHaveProperty(
      'value',
      'deleted-environment',
    );
    expect(screen.getByRole('button', { name: 'Delegate' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.change(screen.getByLabelText('Station'), {
      target: { value: 'current' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          target: expect.objectContaining({
            environment: { kind: 'current' },
          }),
        }),
        apiBase: INVOCATION_API_BASE,
        requestScope: INVOCATION_SCOPE,
      }),
    );
  });

  test('keeps the configured remote while inventory loads', async () => {
    projectDefaultEnvironment = { kind: 'saved', id: 'env-media' };
    environmentsLoading = true;
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        initialPrompt="Keep the selected machine"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    expect(screen.getByLabelText('Station')).toHaveProperty(
      'value',
      'env-media',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          target: expect.objectContaining({
            environment: { kind: 'saved', id: 'env-media' },
          }),
        }),
        apiBase: INVOCATION_API_BASE,
        requestScope: INVOCATION_SCOPE,
      }),
    );
    expect(discoveryInputs).toHaveBeenCalledWith({
      environmentId: 'env-media',
    });
    expect(
      discoveryInputs.mock.calls.every(
        ([input]) => input.environmentId === 'env-media',
      ),
    ).toBe(true);
  });

  test('waits for Project defaults before discovery or submission', async () => {
    projectLoading = true;
    const props = {
      isOpen: true,
      apiBase: 'http://station.test',
      projectSlug: 'station',
      initialPrompt: 'Wait for the actual default',
      onClose: vi.fn(),
      onDelegated: vi.fn(),
    };
    const { rerender } = render(<DelegationLauncher {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(discoveryInputs).not.toHaveBeenCalled();
    projectLoading = false;
    // The default resolves to This Station: local Project execution keeps
    // its explicit local semantics (an SSH default would now refuse, below).
    projectDefaultEnvironment = undefined;
    rerender(<DelegationLauncher {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          target: expect.objectContaining({
            environment: { kind: 'current' },
          }),
        }),
        apiBase: INVOCATION_API_BASE,
        requestScope: INVOCATION_SCOPE,
      }),
    );
  });

  test('reports unavailable inventory without claiming the project environment was deleted', () => {
    projectDefaultEnvironment = { kind: 'saved', id: 'env-unchecked' };
    environmentsFailure = true;
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        initialPrompt="Preserve the environment reference"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert').textContent).toContain(
      'Saved environments are unavailable',
    );
    expect(screen.queryByText(/no longer exists/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    expect((screen.getByLabelText('Station') as HTMLSelectElement).value).toBe(
      'env-unchecked',
    );
  });

  test('offers retry and blocks default dispatch when Project loading fails', () => {
    projectFailure = true;
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        initialPrompt="Keep the draft"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(discoveryInputs).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain(
      'Project execution defaults could not be loaded',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry Project' }));
    expect(retryProject).toHaveBeenCalledOnce();
  });

  test('rejects worker discovery from a different environment', () => {
    projectDefaultEnvironment = { kind: 'saved', id: 'env-media' };
    staleDiscoveryEnvironment = 'env-other';
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        initialPrompt="Use only the selected machine"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Delegate' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  test('keeps an explicit choice when Project defaults arrive later', () => {
    projectLoading = true;
    const props = {
      isOpen: true,
      apiBase: 'http://station.test',
      projectSlug: 'station',
      initialPrompt: 'Use my explicit choice',
      onClose: vi.fn(),
      onDelegated: vi.fn(),
    };
    const { rerender } = render(<DelegationLauncher {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    fireEvent.change(screen.getByLabelText('Station'), {
      target: { value: 'current' },
    });
    projectLoading = false;
    projectDefaultEnvironment = { kind: 'saved', id: 'env-media' };
    rerender(<DelegationLauncher {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          target: expect.objectContaining({
            environment: { kind: 'current' },
          }),
        }),
        apiBase: INVOCATION_API_BASE,
        requestScope: INVOCATION_SCOPE,
      }),
    );
  });

  test('keeps the draft and offers retry when capability discovery fails', () => {
    discoveryFailure = new Error('Brian Media could not be reached');
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        projectName="Station"
        initialPrompt="Keep this task draft"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert').textContent).toContain(
      'Brian Media could not be reached',
    );
    expect((screen.getByLabelText('Task') as HTMLTextAreaElement).value).toBe(
      'Keep this task draft',
    );
    expect(
      (screen.getByRole('button', { name: 'Delegate' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retryDiscovery).toHaveBeenCalledOnce();
  });

  test('contains keyboard focus and closes on Escape for every caller', () => {
    const onClose = vi.fn();
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        initialPrompt="Run the bounded task"
        onClose={onClose}
        onDelegated={vi.fn()}
      />,
    );

    const close = screen.getByRole('button', { name: 'Close delegation' });
    const delegate = screen.getByRole('button', { name: 'Delegate' });
    expect(delegate).toHaveProperty('disabled', false);
    const dialog = screen.getByRole('dialog');
    const controls = dialog.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]',
    );
    expect(controls[0]).toBe(close);
    expect(controls[controls.length - 1]).toBe(delegate);
    delegate.focus();
    fireEvent.keyDown(delegate, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(delegate);

    fireEvent.keyDown(delegate, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('dismisses only an actual pointer press on the presentational backdrop', () => {
    const onClose = vi.fn();
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        initialPrompt="Run the bounded task"
        onClose={onClose}
        onDelegated={vi.fn()}
      />,
    );

    // #1180: portalled to `document.body` (out of any inert route frame), so
    // it is no longer a descendant of RTL's own render container.
    const overlay = document.body.querySelector(
      '.delegation-launcher__overlay',
    );
    const dialog = screen.getByRole('dialog');
    expect(overlay?.getAttribute('role')).toBe('presentation');

    fireEvent.pointerDown(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(overlay!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('lists a paired peer Station and delegates to it as a saved environment (#790)', async () => {
    peerCredentials = [
      {
        environmentId: 'env-peer-b',
        apiBase: 'https://box-b.example.test',
        scope: 'orchestration:read orchestration:operate',
        label: 'box-b',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        projectName="Station"
        initialPrompt="Run on the peer"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    expect(
      screen.getByRole('option', { name: 'box-b — Paired Station' }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Station'), {
      target: { value: 'env-peer-b' },
    });
    // The routing summary names the peer, not a generic placeholder.
    expect(screen.getAllByText(/box-b/).length).toBeGreaterThan(0);
    await waitFor(() =>
      expect((screen.getByLabelText('Worker') as HTMLSelectElement).value).toBe(
        'agent:codex',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        input: {
          prompt: 'Run on the peer',
          target: {
            environment: { kind: 'saved', id: 'env-peer-b' },
            agent: 'codex',
            workspace: {
              kind: 'project-portable',
              portableProjectId: 'portable:station',
              resourceId: 'https://git.example.test/station.git',
            },
          },
        },
        apiBase: INVOCATION_API_BASE,
        requestScope: INVOCATION_SCOPE,
      }),
    );
    // Same local/remote slug mismatch still sends the portable id/resource —
    // never a receiver-local slug — and the public body carries no client
    // scope or functions.
    const sent = mutateAsync.mock.calls[0][0] as {
      input: { target: { workspace: Record<string, unknown> } };
    };
    expect(sent.input.target.workspace).not.toHaveProperty('projectSlug');
    expect(sent.input).not.toHaveProperty('requestScope');
    expect(sent.input).not.toHaveProperty('apiBase');
    expect(screen.getByText(/Offer not verified from here/)).toBeTruthy();
  });

  test('an unlabeled peer falls back to its endpoint for a name', () => {
    peerCredentials = [
      {
        environmentId: 'env-peer-b',
        apiBase: 'https://box-b.example.test',
        scope: 'orchestration:read',
        label: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        initialPrompt="Run on the peer"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    expect(
      screen.getByRole('option', {
        name: 'https://box-b.example.test — Paired Station',
      }),
    ).toBeTruthy();
  });

  test('a peer sharing an SSH environmentId is listed once, as its SSH entry', () => {
    // Server-side, `resolveTarget` tries SSH first and rides the peer
    // credential over that tunnel — a second option would dispatch
    // identically, so listing both would present one computer as two.
    peerCredentials = [
      {
        environmentId: 'env-media',
        apiBase: 'https://media.example.test',
        scope: 'orchestration:read orchestration:operate',
        label: 'Brian Media (peer)',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        initialPrompt="Run somewhere"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    expect(
      screen.queryByRole('option', {
        name: 'Brian Media (peer) — Paired Station',
      }),
    ).toBeNull();
    expect(screen.getAllByRole('option', { name: /Brian Media/ }).length).toBe(
      1,
    );
  });

  test('offers only This Station when the peer read is unavailable (403)', () => {
    peerCredentials = undefined;
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        initialPrompt="Run locally"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    expect(screen.queryByRole('option', { name: /Paired Station/ })).toBeNull();
    expect(screen.getByRole('option', { name: 'This Station' })).toBeTruthy();
  });

  test('a linked Project on an SSH Station is refused with no slug workspace dispatch', async () => {
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        projectName="Station"
        initialPrompt="Run over SSH"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    fireEvent.change(screen.getByLabelText('Station'), {
      target: { value: 'env-media' },
    });
    // Named repair state: choosing SSH is not consent to substitute a
    // different same-named Project — nothing may dispatch.
    expect(
      screen.getByText(/can\u2019t be placed on an SSH Station/),
    ).toBeTruthy();
    expect(screen.getByText(/Choose a paired Station/)).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByLabelText('Worker') as HTMLSelectElement).value).toBe(
        'agent:codex',
      ),
    );
    expect(screen.getByRole('button', { name: 'Delegate' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(mutateAsync).not.toHaveBeenCalled();
    // Draft and Station choice survive the refusal.
    expect((screen.getByLabelText('Task') as HTMLTextAreaElement).value).toBe(
      'Run over SSH',
    );
    expect((screen.getByLabelText('Station') as HTMLSelectElement).value).toBe(
      'env-media',
    );
  });

  test('multiple resources require an explicit choice and never guess', async () => {
    projectIdentity = {
      identity: {
        id: 'portable:station',
        repos: [
          {
            kind: 'git',
            id: 'https://git.example.test/station.git',
            canonicalRemote: 'https://git.example.test/station.git',
            label: 'station',
          },
          {
            kind: 'git',
            id: 'https://git.example.test/docs.git',
            canonicalRemote: 'https://git.example.test/docs.git',
            label: 'docs',
          },
        ],
      },
      association: {
        portableProjectId: 'portable:station',
        localProjectId: 'project:station',
        localProjectSlug: 'station',
      },
    };
    peerCredentials = [
      {
        environmentId: 'env-peer-b',
        apiBase: 'https://box-b.example.test',
        scope: 'orchestration:read orchestration:operate',
        label: 'box-b',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        projectName="Station"
        initialPrompt="Place on the peer"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    fireEvent.change(screen.getByLabelText('Station'), {
      target: { value: 'env-peer-b' },
    });
    expect(screen.getByLabelText('Project resource')).toBeTruthy();
    expect(screen.getByText(/Choose which Project resource/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delegate' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(mutateAsync).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Project resource'), {
      target: { value: 'https://git.example.test/docs.git' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            target: expect.objectContaining({
              workspace: {
                kind: 'project-portable',
                portableProjectId: 'portable:station',
                resourceId: 'https://git.example.test/docs.git',
              },
            }),
          }),
          apiBase: INVOCATION_API_BASE,
          requestScope: INVOCATION_SCOPE,
        }),
      ),
    );
  });

  test('a declared execution-root resource is preselected for a peer', async () => {
    projectIdentity = {
      ...singleRepoIdentity(),
      identity: {
        ...singleRepoIdentity().identity,
        repos: [
          ...singleRepoIdentity().identity.repos,
          {
            kind: 'git',
            id: 'https://git.example.test/docs.git',
            canonicalRemote: 'https://git.example.test/docs.git',
            label: 'docs',
          },
        ],
      },
    };
    peerCredentials = [
      {
        environmentId: 'env-peer-b',
        apiBase: 'https://box-b.example.test',
        scope: 'orchestration:read orchestration:operate',
        label: 'box-b',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        projectName="Station"
        initialPrompt="Place the default resource"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    fireEvent.change(screen.getByLabelText('Station'), {
      target: { value: 'env-peer-b' },
    });
    // Declared default wins: no explicit choice required.
    expect(
      (screen.getByLabelText('Project resource') as HTMLSelectElement).value,
    ).toBe('https://git.example.test/station.git');
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            target: expect.objectContaining({
              workspace: {
                kind: 'project-portable',
                portableProjectId: 'portable:station',
                resourceId: 'https://git.example.test/station.git',
              },
            }),
          }),
          apiBase: INVOCATION_API_BASE,
          requestScope: INVOCATION_SCOPE,
        }),
      ),
    );
  });

  test('a verified missing identity blocks peer placement with prepare guidance', () => {
    identityFailure = true;
    // Genuine missing: 404 WITH the discriminated wire code. The message is
    // deliberately unrelated — branching is by status+code, never by text.
    identityError = Object.assign(new Error('unrelated server sentence'), {
      status: 404,
      code: 'project_identity_not_prepared',
    });
    projectIdentity = undefined;
    peerCredentials = [
      {
        environmentId: 'env-peer-b',
        apiBase: 'https://box-b.example.test',
        scope: 'orchestration:read orchestration:operate',
        label: 'box-b',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        projectName="Station"
        initialPrompt="Keep this peer draft"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    fireEvent.change(screen.getByLabelText('Station'), {
      target: { value: 'env-peer-b' },
    });
    // Only the verified 404 missing state gets prepare guidance.
    expect(screen.getByText(/has no portable identity/)).toBeTruthy();
    expect(screen.getByText(/prepare-identity/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delegate' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(mutateAsync).not.toHaveBeenCalled();
    // Selection and draft survive the refusal.
    expect((screen.getByLabelText('Station') as HTMLSelectElement).value).toBe(
      'env-peer-b',
    );
    expect((screen.getByLabelText('Task') as HTMLTextAreaElement).value).toBe(
      'Keep this peer draft',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry Project identity' }),
    );
    expect(retryIdentity).toHaveBeenCalledOnce();
  });

  test('a removed Project 404 stays unavailable with conditional help, never an absence claim', () => {
    identityFailure = true;
    // Removed Project: a 404 carrying the GENERIC storage code — the same
    // status as genuine missing, a different verified fact. The absence
    // sentence is deliberately present: branching is by code, never by text.
    identityError = Object.assign(
      new Error('Project identity was not found.'),
      { status: 404, code: 'file_storage_not_found' },
    );
    projectIdentity = undefined;
    peerCredentials = [
      {
        environmentId: 'env-peer-b',
        apiBase: 'https://box-b.example.test',
        scope: 'orchestration:read orchestration:operate',
        label: 'box-b',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        projectName="Station"
        initialPrompt="Keep this removed draft"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    fireEvent.change(screen.getByLabelText('Station'), {
      target: { value: 'env-peer-b' },
    });
    expect(screen.getByText(/couldn\u2019t be loaded/)).toBeTruthy();
    // No absence claim...
    expect(screen.queryByText(/has no portable identity/)).toBeNull();
    // ...but conditional setup help as a stated possibility.
    expect(screen.getByText(/never had an identity prepared/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delegate' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Task') as HTMLTextAreaElement).value).toBe(
      'Keep this removed draft',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry Project identity' }),
    );
    expect(retryIdentity).toHaveBeenCalledOnce();
  });

  test('an unknown-endpoint 404 stays unavailable with conditional help', () => {
    identityFailure = true;
    // Old Station without the identity endpoint, or a proxy 404 page: a 404
    // with no machine code at all.
    identityError = Object.assign(new Error('Request failed with HTTP 404'), {
      status: 404,
    });
    projectIdentity = undefined;
    peerCredentials = [
      {
        environmentId: 'env-peer-b',
        apiBase: 'https://box-b.example.test',
        scope: 'orchestration:read orchestration:operate',
        label: 'box-b',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        projectName="Station"
        initialPrompt="Keep this old-server draft"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    fireEvent.change(screen.getByLabelText('Station'), {
      target: { value: 'env-peer-b' },
    });
    expect(screen.getByText(/couldn\u2019t be loaded/)).toBeTruthy();
    expect(screen.queryByText(/has no portable identity/)).toBeNull();
    expect(screen.getByText(/never had an identity prepared/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delegate' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Task') as HTMLTextAreaElement).value).toBe(
      'Keep this old-server draft',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry Project identity' }),
    );
    expect(retryIdentity).toHaveBeenCalledOnce();
  });

  test('an authorization denial names access without inventing absence', () => {
    identityFailure = true;
    identityError = Object.assign(new Error('Forbidden'), { status: 403 });
    projectIdentity = undefined;
    peerCredentials = [
      {
        environmentId: 'env-peer-b',
        apiBase: 'https://box-b.example.test',
        scope: 'orchestration:read orchestration:operate',
        label: 'box-b',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        projectName="Station"
        initialPrompt="Denied peer draft"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    fireEvent.change(screen.getByLabelText('Station'), {
      target: { value: 'env-peer-b' },
    });
    expect(screen.getByText(/refused to share/)).toBeTruthy();
    // A denial is not absence: no prepare guidance, no readiness claim.
    expect(screen.queryByText(/prepare-identity/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Delegate' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Task') as HTMLTextAreaElement).value).toBe(
      'Denied peer draft',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry Project identity' }),
    );
    expect(retryIdentity).toHaveBeenCalledOnce();
  });

  test('a failed identity read names the outage without inventing absence', () => {
    identityFailure = true;
    identityError = new TypeError('fetch failed');
    projectIdentity = undefined;
    peerCredentials = [
      {
        environmentId: 'env-peer-b',
        apiBase: 'https://box-b.example.test',
        scope: 'orchestration:read orchestration:operate',
        label: 'box-b',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        projectName="Station"
        initialPrompt="Failed-read peer draft"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    fireEvent.change(screen.getByLabelText('Station'), {
      target: { value: 'env-peer-b' },
    });
    expect(screen.getByText(/couldn\u2019t be loaded/)).toBeTruthy();
    // A transport failure is not absence: no prepare guidance, not even the
    // conditional hint (nothing about a 404 was observed).
    expect(screen.queryByText(/prepare-identity/)).toBeNull();
    expect(screen.queryByText(/has no portable identity/)).toBeNull();
    expect(screen.queryByText(/never had an identity prepared/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Delegate' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Task') as HTMLTextAreaElement).value).toBe(
      'Failed-read peer draft',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry Project identity' }),
    );
    expect(retryIdentity).toHaveBeenCalledOnce();
  });

  test('a loading identity blocks peer dispatch until it resolves', () => {
    identityLoading = true;
    projectIdentity = undefined;
    peerCredentials = [
      {
        environmentId: 'env-peer-b',
        apiBase: 'https://box-b.example.test',
        scope: 'orchestration:read orchestration:operate',
        label: 'box-b',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        initialPrompt="Wait for identity"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    fireEvent.change(screen.getByLabelText('Station'), {
      target: { value: 'env-peer-b' },
    });
    expect(screen.getByText(/portable identity before placing/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delegate' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  test('a stale Home/authority before dispatch refuses without dispatching', () => {
    scopeStale = true;
    peerCredentials = [
      {
        environmentId: 'env-peer-b',
        apiBase: 'https://box-b.example.test',
        scope: 'orchestration:read orchestration:operate',
        label: 'box-b',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        initialPrompt="Do not send stale"
        onClose={vi.fn()}
        onDelegated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    fireEvent.change(screen.getByLabelText('Station'), {
      target: { value: 'env-peer-b' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText(/Station access changed/)).toBeTruthy();
    expect((screen.getByLabelText('Task') as HTMLTextAreaElement).value).toBe(
      'Do not send stale',
    );
  });

  test('authority going stale across the await keeps the draft and skips the result', async () => {
    const onDelegated = vi.fn();
    mutateAsync.mockImplementation(async () => {
      scopeStale = true;
      return {
        taskId: 'task:1',
        sessionId: 'task:1',
        status: 'dispatched',
        environment: { id: 'env-media', name: 'Brian Media', kind: 'ssh' },
        target: { kind: 'agent', id: 'codex' },
        resumable: true,
      };
    });
    peerCredentials = [
      {
        environmentId: 'env-peer-b',
        apiBase: 'https://box-b.example.test',
        scope: 'orchestration:read orchestration:operate',
        label: 'box-b',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        initialPrompt="Keep the late result out"
        onClose={vi.fn()}
        onDelegated={onDelegated}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change routing' }));
    fireEvent.change(screen.getByLabelText('Station'), {
      target: { value: 'env-peer-b' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByText(/Station access changed/)).toBeTruthy(),
    );
    expect(onDelegated).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Task') as HTMLTextAreaElement).value).toBe(
      'Keep the late result out',
    );
    expect((screen.getByLabelText('Station') as HTMLSelectElement).value).toBe(
      'env-peer-b',
    );
  });

  test('a receiver refusal keeps the draft and machine choice with no redispatch', async () => {
    const props = {
      isOpen: true,
      apiBase: 'http://station.test',
      projectSlug: 'station',
      projectName: 'Station',
      initialPrompt: 'Keep this refused draft',
      onClose: vi.fn(),
      onDelegated: vi.fn(),
    };
    const { rerender } = render(<DelegationLauncher {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledOnce());
    mutationError = new Error(
      'This Station does not currently offer execution for the requested Project resource.',
    );
    rerender(<DelegationLauncher {...props} />);
    expect(screen.getByRole('alert').textContent).toContain(
      'does not currently offer execution',
    );
    expect((screen.getByLabelText('Task') as HTMLTextAreaElement).value).toBe(
      'Keep this refused draft',
    );
    // Explicit retry dispatches exactly once more — never automatically.
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
  });
});
