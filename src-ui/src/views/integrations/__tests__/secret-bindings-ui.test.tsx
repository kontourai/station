/** @vitest-environment jsdom */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { navigationStore } from '../../../contexts/navigation-store';

const mocks = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue(undefined),
  replace: vi.fn().mockResolvedValue(undefined),
  revoke: vi.fn().mockResolvedValue(undefined),
  bind: vi.fn(),
  unbind: vi.fn(),
  bindingRefetch: vi.fn().mockResolvedValue(undefined),
  integrationRefetch: vi.fn().mockResolvedValue(undefined),
  refreshBindingState: vi.fn().mockResolvedValue(undefined),
  integrationBindingData: {
    integrationId: 'github',
    secretEnvBindingIds: {} as Record<string, string>,
  },
  integrationBindingsLoading: false,
  integrationBindingsError: null as Error | null,
  bindingData: [] as Array<Record<string, unknown>>,
}));

vi.mock('@kontourai/station-sdk/secret-bindings-query', () => ({
  useSecretBindingsQuery: () => ({
    data: mocks.bindingData,
    isLoading: false,
    error: null,
    refetch: mocks.bindingRefetch,
  }),
  useCreateSecretBindingMutation: () => ({
    mutateAsync: mocks.create,
    isPending: false,
  }),
  useReplaceSecretBindingMutation: () => ({
    mutateAsync: mocks.replace,
    isPending: false,
  }),
  useRevokeSecretBindingMutation: () => ({
    mutateAsync: mocks.revoke,
    isPending: false,
  }),
  useBindSecretBindingMutation: () => ({
    mutateAsync: mocks.bind,
    isPending: false,
  }),
  useUnbindSecretBindingMutation: () => ({
    mutateAsync: mocks.unbind,
    isPending: false,
  }),
  useIntegrationSecretBindingQuery: () => ({
    data: mocks.integrationBindingData,
    isLoading: mocks.integrationBindingsLoading,
    error: mocks.integrationBindingsError,
    refetch: mocks.integrationRefetch,
  }),
  useRefreshSecretBindingState: () => mocks.refreshBindingState,
}));

import { SecretBindingPicker } from '../SecretBindingPicker';
import { SecretBindingsSection } from '../SecretBindingsSection';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.integrationBindingData = {
    integrationId: 'github',
    secretEnvBindingIds: {},
  };
  mocks.integrationBindingsLoading = false;
  mocks.integrationBindingsError = null;
  mocks.bindingData = [
    {
      id: 'github-token',
      name: 'GitHub token',
      revision: 4,
      authRef: { keychain: { service: 'github', account: 'work' } },
      availability: { backend: 'keychain', available: true },
      grants: [{ integrationId: 'github', envName: 'GITHUB_TOKEN' }],
    },
  ];
  navigationStore.navigate('/');
});

describe('secret binding operator UI', () => {
  test('keeps advanced secret-binding management collapsed by default', () => {
    render(<SecretBindingsSection />);

    const heading = screen.getByText('Advanced: Secret bindings');
    const disclosure = heading.closest('details');
    expect(disclosure).toBeInstanceOf(HTMLDetailsElement);
    expect((disclosure as HTMLDetailsElement).open).toBe(false);
  });

  test('creates a structured keychain reference, then returns the form to a clean state', async () => {
    render(<SecretBindingsSection />);
    fireEvent.change(screen.getByLabelText('ID'), {
      target: { value: 'linear' },
    });
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Linear' },
    });
    fireEvent.change(screen.getByLabelText('Backend'), {
      target: { value: 'keychain' },
    });
    fireEvent.change(screen.getByLabelText('Reference'), {
      target: { value: 'linear-service' },
    });
    fireEvent.change(screen.getByLabelText('Account (optional)'), {
      target: { value: 'operator' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create binding' }));
    expect(mocks.create).toHaveBeenCalledWith({
      id: 'linear',
      name: 'Linear',
      authRef: { keychain: { service: 'linear-service', account: 'operator' } },
    });
    await waitFor(() =>
      expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe(''),
    );
    expect(screen.getByText(/keychain github \/ work/)).toBeTruthy();
    expect(screen.queryByDisplayValue('secret-value')).toBeNull();
    const beforeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(false);
  });

  test('populates a structured edit and confirms terminal revoke', () => {
    render(<SecretBindingsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByDisplayValue('GitHub token')).toBeTruthy();
    expect(screen.getByDisplayValue('github')).toBeTruthy();
    expect(screen.getByDisplayValue('work')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(screen.getByRole('alertdialog').textContent).toContain(
      'Existing MCP consumers',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Revoke binding' }));
    expect(mocks.revoke).toHaveBeenCalledWith({
      id: 'github-token',
      expectedRevision: 4,
    });
  });

  test('guards dirty create form on in-app navigation and retains it when discard is canceled', () => {
    render(<SecretBindingsSection />);
    fireEvent.change(screen.getByLabelText('ID'), {
      target: { value: 'linear' },
    });
    const beforeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    act(() => navigationStore.navigate('/secret-binding-guard-target'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe(
      'linear',
    );
  });

  test('guards dirty edit cancellation and discards only after explicit confirmation', () => {
    render(<SecretBindingsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Changed GitHub token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe('');
  });

  test('cancels a clean edit immediately without a discard prompt', () => {
    render(<SecretBindingsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe('');
  });

  test('shows exact grant rows and allows a locked picker while blocking unsaved edits', () => {
    const { rerender } = render(<SecretBindingsSection />);
    expect(screen.getByText('github · GITHUB_TOKEN')).toBeTruthy();
    rerender(
      <SecretBindingPicker
        integrationId="github"
        envNames={['OTHER_TOKEN']}
        requireSave={false}
      />,
    );
    expect(screen.getByRole('button', { name: 'Bind' })).toBeTruthy();
    rerender(
      <SecretBindingPicker
        integrationId="github"
        envNames={['OTHER_TOKEN']}
        requireSave
      />,
    );
    expect(
      screen.getByText(
        'Save or discard unsaved integration edits before changing a secret binding.',
      ),
    ).toBeTruthy();
  });

  test('uses the authoritative integration config rather than inferring a binding from grants', () => {
    mocks.integrationBindingData = {
      integrationId: 'github',
      secretEnvBindingIds: { OTHER_TOKEN: 'github-token' },
    };
    render(
      <SecretBindingPicker
        integrationId="github"
        envNames={['OTHER_TOKEN']}
        requireSave={false}
      />,
    );
    expect(screen.getByText('Configured binding: GitHub token')).toBeTruthy();
    // The fixture grants GITHUB_TOKEN, not OTHER_TOKEN. Configuration remains
    // authoritative, so this must be an unbind rather than a guessed bind.
    expect(screen.getByRole('button', { name: 'Unbind' })).toBeTruthy();
  });

  test('surfaces safe-partial state and keeps an explicit retry action', async () => {
    mocks.bind.mockResolvedValue({
      outcome: 'safe-partial',
      binding: {
        id: 'github-token',
        name: 'GitHub token',
        revision: 5,
      },
      integrationId: 'github',
      envName: 'OTHER_TOKEN',
      configurationError: 'The config update needs a retry.',
    });
    render(
      <SecretBindingPicker
        integrationId="github"
        envNames={['OTHER_TOKEN']}
        requireSave={false}
      />,
    );
    fireEvent.change(screen.getByLabelText('Binding'), {
      target: { value: 'github-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Bind' }));
    await waitFor(() =>
      expect(screen.getByText('The config update needs a retry.')).toBeTruthy(),
    );
    expect(mocks.refreshBindingState).toHaveBeenCalledOnce();
    expect(mocks.bindingRefetch).toHaveBeenCalledOnce();
    expect(mocks.integrationRefetch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Retry bind' }));
    await waitFor(() => expect(mocks.bind).toHaveBeenCalledTimes(2));
    expect(mocks.bind).toHaveBeenLastCalledWith({
      id: 'github-token',
      integrationId: 'github',
      envName: 'OTHER_TOKEN',
      expectedRevision: 5,
    });
  });

  test('refreshes binding and authoritative integration projections after complete bind and unbind', async () => {
    mocks.bind.mockResolvedValue({
      outcome: 'complete',
      binding: { id: 'github-token', name: 'GitHub token', revision: 4 },
      integrationId: 'github',
      envName: 'OTHER_TOKEN',
    });
    const { rerender } = render(
      <SecretBindingPicker
        integrationId="github"
        envNames={['OTHER_TOKEN']}
        requireSave={false}
      />,
    );
    fireEvent.change(screen.getByLabelText('Binding'), {
      target: { value: 'github-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Bind' }));
    await waitFor(() => expect(mocks.bindingRefetch).toHaveBeenCalledOnce());
    expect(mocks.refreshBindingState).toHaveBeenCalledOnce();
    expect(mocks.integrationRefetch).toHaveBeenCalledOnce();

    mocks.integrationBindingData = {
      integrationId: 'github',
      secretEnvBindingIds: { OTHER_TOKEN: 'github-token' },
    };
    mocks.unbind.mockResolvedValue({
      outcome: 'complete',
      binding: { id: 'github-token', name: 'GitHub token', revision: 5 },
      integrationId: 'github',
      envName: 'OTHER_TOKEN',
    });
    rerender(
      <SecretBindingPicker
        integrationId="github"
        envNames={['OTHER_TOKEN']}
        requireSave={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Unbind' }));
    await waitFor(() => expect(mocks.unbind).toHaveBeenCalledOnce());
    expect(mocks.refreshBindingState).toHaveBeenCalledTimes(2);
    expect(mocks.bindingRefetch).toHaveBeenCalledTimes(2);
    expect(mocks.integrationRefetch).toHaveBeenCalledTimes(2);
  });

  test('keeps a revoked configured binding actionable for unbind, then permits a replacement after refresh', async () => {
    mocks.bindingData = [
      {
        id: 'github-token',
        name: 'Revoked GitHub token',
        revision: 4,
        authRef: { env: 'GITHUB_TOKEN' },
        availability: { backend: 'env', available: false },
        grants: [],
        revokedAt: '2026-08-24T00:00:00.000Z',
      },
      {
        id: 'replacement-token',
        name: 'Replacement token',
        revision: 1,
        authRef: { env: 'REPLACEMENT_TOKEN' },
        availability: { backend: 'env', available: true },
        grants: [],
      },
    ];
    mocks.integrationBindingData = {
      integrationId: 'github',
      secretEnvBindingIds: { OTHER_TOKEN: 'github-token' },
    };
    mocks.unbind.mockImplementation(async () => {
      mocks.integrationBindingData = {
        integrationId: 'github',
        secretEnvBindingIds: {},
      };
      return {
        outcome: 'complete',
        binding: {
          id: 'github-token',
          name: 'Revoked GitHub token',
          revision: 5,
        },
        integrationId: 'github',
        envName: 'OTHER_TOKEN',
      };
    });
    mocks.bind.mockResolvedValue({
      outcome: 'complete',
      binding: {
        id: 'replacement-token',
        name: 'Replacement token',
        revision: 1,
      },
      integrationId: 'github',
      envName: 'OTHER_TOKEN',
    });
    const { rerender } = render(
      <SecretBindingPicker
        integrationId="github"
        envNames={['OTHER_TOKEN']}
        requireSave={false}
      />,
    );
    expect(
      screen.getByText('Configured binding: Revoked GitHub token'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Unbind' }));
    await waitFor(() => expect(mocks.unbind).toHaveBeenCalledOnce());

    rerender(
      <SecretBindingPicker
        integrationId="github"
        envNames={['OTHER_TOKEN']}
        requireSave={false}
      />,
    );
    fireEvent.change(screen.getByLabelText('Binding'), {
      target: { value: 'replacement-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Bind' }));
    await waitFor(() => expect(mocks.bind).toHaveBeenCalledOnce());
  });

  test('renders authoritative projection loading and an explicit retry on failure', () => {
    mocks.integrationBindingsLoading = true;
    const { rerender } = render(
      <SecretBindingPicker
        integrationId="github"
        envNames={['OTHER_TOKEN']}
        requireSave={false}
      />,
    );
    expect(
      screen.getByRole('status', { name: 'Loading binding configuration' }),
    ).toBeTruthy();

    mocks.integrationBindingsLoading = false;
    mocks.integrationBindingsError = new Error('projection unavailable');
    rerender(
      <SecretBindingPicker
        integrationId="github"
        envNames={['OTHER_TOKEN']}
        requireSave={false}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'projection unavailable',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry binding configuration' }),
    );
    expect(mocks.bindingRefetch).toHaveBeenCalledOnce();
    expect(mocks.integrationRefetch).toHaveBeenCalledOnce();
  });
});
