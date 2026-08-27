/**
 * @vitest-environment jsdom
 */
// #242 Knowledge port — asserts the one remaining bespoke
// `knowledge-section__empty` paragraph ("No working directory configured.")
// now renders through the canonical `Empty` primitive. The sibling
// `KnowledgeStoreSubsection` (K5) already composed `Empty`/`ErrorState`/
// `Skeleton` before this port and is asserted here only to confirm its
// pre-existing behavior is untouched.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@kontourai/station-sdk', () => ({
  useCreateKnowledgeRootMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useKnowledgeBulkDeleteMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useKnowledgeDeleteMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useKnowledgeDocsQuery: () => ({ data: [] }),
  useKnowledgeRootsQuery: () => ({ data: [], isLoading: false, error: null }),
  useKnowledgeSaveMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useKnowledgeScanMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useKnowledgeStatusQuery: () => ({ data: undefined }),
  useMigratePreIndexKnowledgeMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    data: undefined,
  }),
  useProjectQuery: () => ({ data: { workingDirectory: null } }),
}));

const navigateMock = vi.fn();
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: navigateMock }),
}));

import { useUnsavedGuard } from '../../../hooks/useUnsavedGuard';
import { KnowledgeSection } from '../KnowledgeSection';

// Pass-through by default (the "not dirty" case) — the guard-intercept
// coverage below renders `GuardedHarness` instead of a bare pass-through.
const passthroughGuard = (callback: () => void) => callback();

/**
 * `ProjectSettingsView.tsx`'s real shape: `useUnsavedGuard(isDirty)`'s
 * `guard` passed straight into `KnowledgeSection` — station#settings-revamp
 * slice 5 review finding HIGH 1.
 */
function GuardedHarness({ dirty }: { dirty: boolean }) {
  const { guard, DiscardModal } = useUnsavedGuard(dirty);
  return (
    <>
      <KnowledgeSection slug="demo-project" guard={guard} />
      <DiscardModal />
    </>
  );
}

describe('project-settings/KnowledgeSection (#242 shell port)', () => {
  it('renders the no-working-directory state through the canonical Empty component, not a bespoke __empty paragraph', () => {
    const { container } = render(
      <KnowledgeSection slug="demo-project" guard={passthroughGuard} />,
    );

    expect(screen.getByText('No working directory configured.')).toBeTruthy();
    expect(container.querySelector('.knowledge-section__empty')).toBeNull();
  });

  it('leaves the pre-existing K5 KnowledgeStoreSubsection Empty usage untouched', () => {
    render(<KnowledgeSection slug="demo-project" guard={passthroughGuard} />);

    expect(
      screen.getByText("This project doesn't have its own knowledge store yet"),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Create project knowledge store/ }),
    ).toBeTruthy();
  });

  // station#settings-revamp slice 5 review finding HIGH 1.
  describe('unsaved-guard wiring for the cross-links', () => {
    it('"Open Settings → My knowledge store" navigates with the section param when the page is not dirty', () => {
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
      expect(screen.queryByText('Unsaved Changes')).toBeNull();
    });

    it('"Open Knowledge infrastructure" navigates to /connections/knowledge when the page is not dirty', () => {
      navigateMock.mockClear();
      render(<GuardedHarness dirty={false} />);

      fireEvent.click(
        screen.getByRole('button', { name: 'Open Knowledge infrastructure' }),
      );

      expect(navigateMock).toHaveBeenCalledWith('/connections/knowledge');
      expect(screen.queryByText('Unsaved Changes')).toBeNull();
    });

    it('a dirty page intercepts the My-knowledge-store link with the discard-confirmation modal instead of silently navigating away', () => {
      navigateMock.mockClear();
      render(<GuardedHarness dirty />);

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Open Settings → My knowledge store',
        }),
      );

      expect(navigateMock).not.toHaveBeenCalled();
      expect(screen.getByText('Unsaved Changes')).toBeTruthy();
    });

    it('a dirty page intercepts the Knowledge-infrastructure link with the discard-confirmation modal instead of silently navigating away', () => {
      navigateMock.mockClear();
      render(<GuardedHarness dirty />);

      fireEvent.click(
        screen.getByRole('button', { name: 'Open Knowledge infrastructure' }),
      );

      expect(navigateMock).not.toHaveBeenCalled();
      expect(screen.getByText('Unsaved Changes')).toBeTruthy();
    });

    it('confirming discard from a dirty page completes the deferred navigation', () => {
      navigateMock.mockClear();
      render(<GuardedHarness dirty />);

      fireEvent.click(
        screen.getByRole('button', { name: 'Open Knowledge infrastructure' }),
      );
      expect(navigateMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      expect(navigateMock).toHaveBeenCalledWith('/connections/knowledge');
    });
  });
});
