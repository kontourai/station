// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DelegationLauncher } from '../components/chat-dock/DelegationLauncher';

const mutateAsync = vi.fn();
const reset = vi.fn();
const retryDiscovery = vi.fn();
let discoveryFailure: Error | null = null;
let projectDefaultEnvironment: { kind: 'saved'; id: string } | undefined;
let environmentsFailure = false;

vi.mock('@kontourai/station-sdk', () => ({
  useProjectQuery: () => ({
    data: projectDefaultEnvironment
      ? { defaultEnvironment: projectDefaultEnvironment }
      : undefined,
  }),
  useDelegationOptionsQuery: (input: { environmentId?: string }) => ({
    data: discoveryFailure
      ? undefined
      : {
          environment: input.environmentId
            ? { id: input.environmentId, name: 'Brian Media', kind: 'ssh' }
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
                    unavailableReason: 'Install the required runtime first.',
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
    error: discoveryFailure,
    isFetching: false,
    refetch: retryDiscovery,
  }),
  useSshEnvironmentsQuery: () => ({
    data: environmentsFailure
      ? undefined
      : [
          {
            profile: {
              id: 'media',
              name: 'Brian Media',
              environmentId: 'env-media',
              verifiedProjectPath: '/home/brian/dev/github/kontourai/station',
            },
            state: { phase: 'disconnected' },
          },
        ],
    isSuccess: !environmentsFailure,
    isError: environmentsFailure,
  }),
  useDelegateOrchestrationTaskMutation: () => ({
    mutateAsync,
    reset,
    isPending: false,
    error: null,
  }),
}));

describe('DelegationLauncher', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    reset.mockReset();
    retryDiscovery.mockReset();
    discoveryFailure = null;
    environmentsFailure = false;
    projectDefaultEnvironment = undefined;
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

  test('shows Agent-only targets and delegates to a saved SSH environment', async () => {
    const onDelegated = vi.fn();
    render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        projectName="Station"
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

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        prompt: 'Fix the mobile task controls',
        target: {
          environment: { kind: 'saved', id: 'env-media' },
          agent: 'codex',
          model: { override: 'gpt-5.6-sol' },
          workspace: { kind: 'project', projectSlug: 'station' },
        },
        parentTaskId: 'codex:1721355900000',
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
          target: expect.objectContaining({ environment: { kind: 'current' } }),
        }),
      ),
    );
  });

  test('names a dangling project environment and honestly falls back to current', () => {
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

    expect(screen.getByRole('status').textContent).toContain(
      'names a saved environment that no longer exists',
    );
    expect(screen.getAllByText(/This Station/).length).toBeGreaterThan(0);
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
    const { container } = render(
      <DelegationLauncher
        isOpen
        apiBase="http://station.test"
        projectSlug="station"
        initialPrompt="Run the bounded task"
        onClose={onClose}
        onDelegated={vi.fn()}
      />,
    );

    const overlay = container.querySelector('.delegation-launcher__overlay');
    const dialog = screen.getByRole('dialog');
    expect(overlay?.getAttribute('role')).toBe('presentation');

    fireEvent.pointerDown(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(overlay!);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
