/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { navigationStore } from '../contexts/navigation-store';

let rootsQueryResult: {
  data?: Array<{
    id: string;
    scope: { kind: 'personal' } | { kind: 'project'; projectSlug: string };
    adapterId: string;
    storeRoot: string;
    displayName: string;
    createdAt: string;
  }>;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  refetch: () => void;
};

const createRootMutate = vi.fn();
const validateRootMutateAsync = vi.fn();
let createRootIsPending = false;
let createRootIsError = false;
let createRootError: unknown;
let validateRootIsPending = false;

vi.mock('@kontourai/station-connect', () => ({
  RejectingCredentialStorage: class RejectingCredentialStorage {},
  useConnections: () => ({
    apiBase: 'http://localhost:3141',
    setApiBase: vi.fn(),
    resetToDefault: vi.fn(),
    isCustom: false,
  }),
}));

const navigateMock = vi.fn(
  (...args: Parameters<typeof navigationStore.navigate>) =>
    navigationStore.navigate(...args),
);
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: navigateMock }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useKnowledgeRootsQuery: () => rootsQueryResult,
  useKnowledgeAdaptersQuery: () => ({
    data: [
      { id: 'kit-default-store', displayName: 'Default store' },
      { id: 'kit-obsidian-store', displayName: 'Obsidian vault' },
    ],
  }),
  useCreateKnowledgeRootMutation: () => ({
    mutate: createRootMutate,
    isPending: createRootIsPending,
    isError: createRootIsError,
    error: createRootError,
  }),
  useValidateKnowledgeRootMutation: () => ({
    mutateAsync: validateRootMutateAsync,
    isPending: validateRootIsPending,
  }),
}));

vi.mock('../components/PathAutocomplete', () => ({
  PathAutocomplete: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
  }) => (
    <input
      aria-label="Obsidian vault path"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { KnowledgeStoreSection } from '../views/settings/KnowledgeStoreSection';

/** The parent registers its dirty state with the real navigation store. */
function GuardedHarness({ dirty }: { dirty: boolean }) {
  const { DiscardModal } = useUnsavedGuard(dirty);
  return (
    <>
      <KnowledgeStoreSection />
      <DiscardModal />
    </>
  );
}

describe('KnowledgeStoreSection', () => {
  beforeEach(() => {
    createRootMutate.mockReset();
    validateRootMutateAsync.mockReset();
    createRootIsPending = false;
    createRootIsError = false;
    createRootError = undefined;
    validateRootIsPending = false;
    rootsQueryResult = {
      data: [],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  });

  test('shows a loading skeleton while roots are fetching', () => {
    rootsQueryResult = {
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    };
    const { container } = render(<KnowledgeStoreSection />);
    expect(
      container.querySelector('.knowledge-store-section__skeleton'),
    ).toBeTruthy();
  });

  test('shows an error state with retry when the roots query fails', () => {
    const refetch = vi.fn();
    rootsQueryResult = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('network down'),
      refetch,
    };
    render(<KnowledgeStoreSection />);

    expect(screen.getByText("Couldn't load your knowledge store")).toBeTruthy();
    expect(screen.getByText('network down')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
  });

  test('empty state: creates the default personal knowledge store on click', () => {
    render(<KnowledgeStoreSection />);

    expect(screen.getByText('Personal knowledge is off')).toBeTruthy();
    expect(screen.getByText(/^Optional\./)).toBeTruthy();
    expect(screen.getByText(/Nothing is imported automatically/)).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: 'Create recommended store' }),
    );

    expect(createRootMutate).toHaveBeenCalledWith({
      scope: { kind: 'personal' },
      adapterId: 'kit-default-store',
    });
  });

  test('loaded state: shows the existing personal root details', () => {
    rootsQueryResult = {
      data: [
        {
          id: 'root:personal',
          scope: { kind: 'personal' },
          adapterId: 'kit-default-store',
          storeRoot: '/home/user/.station/knowledge/personal',
          displayName: 'Personal knowledge store',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    render(<KnowledgeStoreSection />);

    expect(
      screen.getByText('/home/user/.station/knowledge/personal'),
    ).toBeTruthy();
    expect(screen.getByText('Default store')).toBeTruthy();
    expect(screen.getByText(/Personal knowledge is on/)).toBeTruthy();
    expect(screen.queryByText('Personal knowledge is off')).toBeNull();
  });

  test('Obsidian connect flow: renders the adapter reason verbatim on validation failure and never enables Connect', async () => {
    validateRootMutateAsync.mockResolvedValue({
      ok: false,
      reason: 'storeRoot is an empty directory with no .obsidian/ vault marker',
    });

    render(<KnowledgeStoreSection />);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Connect an existing Obsidian vault instead',
      }),
    );

    fireEvent.change(screen.getByLabelText('Obsidian vault path'), {
      target: { value: '/tmp/empty-dir' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));

    await waitFor(() => {
      expect(
        screen.getByText(
          'storeRoot is an empty directory with no .obsidian/ vault marker',
        ),
      ).toBeTruthy();
    });

    expect(validateRootMutateAsync).toHaveBeenCalledWith({
      adapterId: 'kit-obsidian-store',
      storeRoot: '/tmp/empty-dir',
    });
    expect(
      (screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(createRootMutate).not.toHaveBeenCalled();
  });

  test('Obsidian connect flow: enables Connect only after a successful validation of the current path', async () => {
    validateRootMutateAsync.mockResolvedValue({ ok: true });

    render(<KnowledgeStoreSection />);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Connect an existing Obsidian vault instead',
      }),
    );
    fireEvent.change(screen.getByLabelText('Obsidian vault path'), {
      target: { value: '/home/user/vaults/notes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));

    await waitFor(() => {
      expect(
        (screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(createRootMutate).toHaveBeenCalledWith({
      scope: { kind: 'personal' },
      adapterId: 'kit-obsidian-store',
      storeRoot: '/home/user/vaults/notes',
    });
  });

  // archive#settings-revamp 1.
  describe('unsaved-guard wiring for the "Open Knowledge infrastructure" cross-link', () => {
    test('navigates to /connections/knowledge when the page is not dirty', () => {
      navigationStore.navigate('/guard-origin');
      navigateMock.mockClear();
      render(<GuardedHarness dirty={false} />);

      fireEvent.click(
        screen.getByRole('button', { name: 'Open Knowledge infrastructure' }),
      );

      expect(navigateMock).toHaveBeenCalledWith('/connections/knowledge');
      expect(window.location.pathname).toBe('/connections/knowledge');
      expect(screen.queryByText('Unsaved Changes')).toBeNull();
    });

    test('a dirty page intercepts navigation with the discard-confirmation modal instead of silently navigating away', () => {
      navigationStore.navigate('/guard-origin');
      navigateMock.mockClear();
      render(<GuardedHarness dirty />);

      fireEvent.click(
        screen.getByRole('button', { name: 'Open Knowledge infrastructure' }),
      );

      expect(window.location.pathname).toBe('/guard-origin');
      expect(screen.getByText('Unsaved Changes')).toBeTruthy();
    });

    test('confirming discard from a dirty page completes the deferred navigation', () => {
      navigationStore.navigate('/guard-origin');
      navigateMock.mockClear();
      render(<GuardedHarness dirty />);

      fireEvent.click(
        screen.getByRole('button', { name: 'Open Knowledge infrastructure' }),
      );
      expect(window.location.pathname).toBe('/guard-origin');

      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      expect(navigateMock).toHaveBeenCalledWith('/connections/knowledge');
      expect(window.location.pathname).toBe('/connections/knowledge');
    });
  });
});
