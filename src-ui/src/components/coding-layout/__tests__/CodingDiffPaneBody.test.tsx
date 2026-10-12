/** @vitest-environment jsdom */

/**
 * The Diff pane body shows ONE view at full width: the working tree's
 * changes or the pull requests, never both as columns. Reverting the
 * switch to render both fails the first test; dropping the jump fails the
 * third.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../BranchToolbar', () => ({
  BranchToolbar: ({
    leading,
    onActiveRepoChange,
    showCommit,
  }: {
    leading: React.ReactNode;
    onActiveRepoChange?: (root: string) => void;
    showCommit?: boolean;
  }) => (
    <div data-testid="git-rows" data-show-commit={String(showCommit)}>
      {leading}
      <button type="button" onClick={() => onActiveRepoChange?.('/nested')}>
        pin nested
      </button>
    </div>
  ),
}));
vi.mock('../DiffPanel', () => ({
  DiffPanel: ({ workingDir }: { workingDir: string }) => (
    <p data-testid="diff" data-working-dir={workingDir} />
  ),
}));
vi.mock('../PullRequestsPanel', () => ({
  PullRequestsPanel: ({
    activeRepoRoot,
    initialSelected,
  }: {
    activeRepoRoot: string;
    initialSelected: { ref: string } | null;
  }) => (
    <section
      aria-label="Pull requests"
      data-testid="prs"
      data-repo-root={activeRepoRoot}
    >
      {initialSelected ? `review #${initialSelected.ref}` : 'list'}
    </section>
  ),
  CurrentBranchPullRequestLine: ({
    onOpen,
  }: {
    onOpen: (pr: { ref: string }) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onOpen({
          provider: 'github',
          host: 'github.com',
          repository: { owner: 'o', name: 'r' },
          ref: '42',
        } as never)
      }
    >
      PR #42
    </button>
  ),
}));

import { CodingDiffPaneBody } from '../CodingDiffPaneBody';

afterEach(() => cleanup());

const mount = () =>
  render(<CodingDiffPaneBody projectSlug="repo" workingDir="/repo" />);

describe('CodingDiffPaneBody', () => {
  test('starts on Changes: the diff alone, at the full width, with the switch pressed', () => {
    mount();
    expect(screen.getByTestId('diff').dataset.workingDir).toBe('/repo');
    expect(screen.queryByTestId('prs')).toBeNull();
    const group = screen.getByRole('group', { name: 'Diff view' });
    const [changes, pulls] = Array.from(group.querySelectorAll('button'));
    expect(changes.textContent).toBe('Changes');
    expect(changes.getAttribute('aria-pressed')).toBe('true');
    expect(pulls.textContent).toBe('Pull requests');
    expect(pulls.getAttribute('aria-pressed')).toBe('false');
    // The switch is a choice, not two actions: no plain unlabelled rows of
    // buttons, and the old two-column wrapper is gone.
    expect(
      document.querySelector('.workspace-coding-review-panels'),
    ).toBeNull();
  });

  test('Pull requests replaces the diff and the commit row; the view follows the active repository', () => {
    mount();
    // The commit row belongs to the Changes view alone; the first git row
    // (switch, branch chip, push) stays at pane scope.
    expect(screen.getByTestId('git-rows').dataset.showCommit).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'pin nested' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pull requests' }));
    expect(screen.queryByTestId('diff')).toBeNull();
    const prs = screen.getByTestId('prs');
    expect(prs.textContent).toBe('list');
    expect(prs.dataset.repoRoot).toBe('/nested');
    expect(screen.getByTestId('git-rows').dataset.showCommit).toBe('false');
    expect(
      screen
        .getByRole('button', { name: 'Pull requests' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen
        .getByRole('button', { name: 'Changes' })
        .getAttribute('aria-pressed'),
    ).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Changes' }));
    expect(screen.getByTestId('diff').dataset.workingDir).toBe('/nested');
  });

  test('the branch line jumps to that review; choosing Pull requests afresh shows the list', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'PR #42' }));
    expect(screen.getByTestId('prs').textContent).toBe('review #42');
    expect(
      screen
        .getByRole('button', { name: 'Pull requests' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pull requests' }));
    expect(screen.getByTestId('prs').textContent).toBe('list');
  });
});
