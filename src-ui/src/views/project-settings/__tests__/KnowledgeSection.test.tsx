/**
 * @vitest-environment jsdom
 */
// archive#242 Knowledge port — asserts the one remaining bespoke
// `knowledge-section__empty` paragraph ("No working directory configured.")
// now renders through the canonical `Empty` primitive. The sibling
// `KnowledgeStoreSubsection` (K5) already composed `Empty`/`ErrorState`/
// `Skeleton` before this port and is asserted here only to confirm its
// pre-existing behavior is untouched.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { navigationStore } from '../../../contexts/navigation-store';

vi.mock('../../../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'ui-scope-test-authority',
    isCurrent: () => true,
  }),
}));

const knowledgeMocks = vi.hoisted(() => ({
  scan: vi.fn(),
  save: vi.fn(),
  refetch: vi.fn(),
  docsError: false,
  workingDirectory: null as string | null,
}));

beforeEach(() => {
  knowledgeMocks.scan.mockReset();
  knowledgeMocks.save.mockReset();
  knowledgeMocks.refetch.mockReset();
  knowledgeMocks.docsError = false;
  knowledgeMocks.workingDirectory = null;
});

vi.mock('@kontourai/station-sdk', () => ({
  useCreateKnowledgeRootMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useKnowledgeBulkDeleteMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useKnowledgeDeleteMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useKnowledgeDocsQuery: () => ({
    data: [],
    isError: knowledgeMocks.docsError,
    refetch: knowledgeMocks.refetch,
  }),
  useKnowledgeRootsQuery: () => ({ data: [], isLoading: false, error: null }),
  useKnowledgeSaveMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: knowledgeMocks.save,
    isPending: false,
  }),
  useKnowledgeScanMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: knowledgeMocks.scan,
    isPending: false,
  }),
  useKnowledgeStatusQuery: () => ({ data: undefined }),
  useMigratePreIndexKnowledgeMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    data: undefined,
  }),
  useProjectQuery: () => ({
    data: { workingDirectory: knowledgeMocks.workingDirectory },
  }),
}));

const navigateMock = vi.fn(
  (...args: Parameters<typeof navigationStore.navigate>) =>
    navigationStore.navigate(...args),
);
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: navigateMock }),
}));

import { useUnsavedGuard } from '../../../hooks/useUnsavedGuard';
import { KnowledgeSection } from '../KnowledgeSection';

/** The parent registers its dirty state with the real navigation store. */
function GuardedHarness({ dirty }: { dirty: boolean }) {
  const { DiscardModal } = useUnsavedGuard(dirty);
  return (
    <>
      <KnowledgeSection slug="demo-project" />
      <DiscardModal />
    </>
  );
}

describe('project-settings/KnowledgeSection (#242 shell port)', () => {
  it('renders the no-working-directory state through the canonical Empty component', () => {
    render(<KnowledgeSection slug="demo-project" />);

    // `.empty` is the hook the shared @kontourai/ui Empty primitive renders.
    expect(
      screen.getByText('No working directory configured.').closest('.empty'),
    ).not.toBeNull();
  });

  it('routes store management to the persistent Sources section', () => {
    navigationStore.navigate('/projects/demo-project/edit');
    render(<KnowledgeSection slug="demo-project" />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage sources' }));
    expect(new URL(window.location.href).searchParams.get('section')).toBe(
      'resources',
    );
    expect(
      screen.queryByRole('button', { name: /Create project knowledge store/ }),
    ).toBeNull();
  });

  it('reports document read failures and retries the read', () => {
    knowledgeMocks.docsError = true;
    render(<KnowledgeSection slug="demo-project" />);
    expect(screen.getByText('Could not load documents')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(knowledgeMocks.refetch).toHaveBeenCalledOnce();
  });

  it('reports a refused directory scan instead of silently dropping the error', async () => {
    knowledgeMocks.workingDirectory = '/tmp/demo';
    knowledgeMocks.scan.mockRejectedValueOnce(new Error('Index unavailable'));
    render(<KnowledgeSection slug="demo-project" />);
    fireEvent.click(screen.getByRole('button', { name: /Index directory/ }));
    await waitFor(() =>
      expect(screen.getByText('Index unavailable')).toBeTruthy(),
    );
    expect(screen.queryByText(/Indexed 0 files/)).toBeNull();
  });

  it('reports a failed upload with its filename while continuing the remaining files', async () => {
    knowledgeMocks.save.mockRejectedValueOnce(new Error('Store unavailable'));
    knowledgeMocks.save.mockResolvedValueOnce({});
    const { container } = render(<KnowledgeSection slug="demo-project" />);
    const fileInput = container.querySelector('input[type="file"]')!;
    fireEvent.change(fileInput, {
      target: {
        files: [
          { name: 'failed.md', text: async () => 'First document' },
          { name: 'saved.md', text: async () => 'Second document' },
        ],
      },
    });
    await waitFor(() => {
      expect(screen.getByText('failed.md: Store unavailable')).toBeTruthy();
    });
    expect(knowledgeMocks.save).toHaveBeenCalledTimes(2);
    expect(knowledgeMocks.save).toHaveBeenLastCalledWith({
      filename: 'saved.md',
      content: 'Second document',
    });
  });

  // archive#settings-revamp 1.
  describe('unsaved-guard wiring for the cross-links', () => {
    it('"Open Settings → My knowledge store" navigates with the section param when the page is not dirty', () => {
      navigationStore.navigate('/guard-origin');
      navigateMock.mockClear();
      render(<GuardedHarness dirty={false} />);

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Open Settings → My knowledge store',
        }),
      );

      expect(navigateMock).toHaveBeenCalledWith('/settings', {
        view: 'knowledge',
        highlight: 'personal-knowledge-store',
      });
      expect(window.location.pathname).toBe('/settings');
      expect(screen.queryByText('Unsaved Changes')).toBeNull();
    });

    it('"Open Knowledge infrastructure" navigates to /connections/knowledge when the page is not dirty', () => {
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

    // The interception is what this section wires; the resume is not. That the
    // Discard button settles the deferred navigation to its target is
    // `useUnsavedGuard`'s own contract, driven end to end in
    // `src-ui/src/__tests__/useUnsavedGuard.test.tsx` -- 'Discard on an
    // intercepted route change completes that navigation', which clicks a
    // real Discard and asserts the browser reached the target path.
    // The route this link carries is pinned by the clean-page case above.
    it('a dirty page intercepts the My-knowledge-store link with the discard-confirmation modal instead of silently navigating away', () => {
      navigationStore.navigate('/guard-origin');
      navigateMock.mockClear();
      render(<GuardedHarness dirty />);

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Open Settings → My knowledge store',
        }),
      );

      expect(window.location.pathname).toBe('/guard-origin');
      expect(screen.getByText('Unsaved Changes')).toBeTruthy();
    });

    it('a dirty page intercepts the Knowledge-infrastructure link with the discard-confirmation modal instead of silently navigating away', () => {
      navigationStore.navigate('/guard-origin');
      navigateMock.mockClear();
      render(<GuardedHarness dirty />);

      fireEvent.click(
        screen.getByRole('button', { name: 'Open Knowledge infrastructure' }),
      );

      expect(window.location.pathname).toBe('/guard-origin');
      expect(screen.getByText('Unsaved Changes')).toBeTruthy();
    });
  });
});
