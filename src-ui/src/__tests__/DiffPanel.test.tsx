/**
 * @vitest-environment jsdom
 */

import { parsePatchFiles } from '@pierre/diffs';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

// jsdom does not implement ResizeObserver, which @pierre/diffs CodeView relies
// on for its virtualizer. Stub it so the component can mount under test.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

let diffQueryResult: {
  data?: string;
  isLoading: boolean;
  error: { message: string } | null;
} = { data: '', isLoading: false, error: null };

/**
 * Mutable stand-in for the SDK's `useDiffCommentsQuery` return value. Tests
 * that reproduce archive#3159's comment paths mutate this between renders to
 * simulate a query refetch pushing fresh comment data into DiffPanel, the
 * same way TanStack Query would after a cache invalidation.
 */
let commentsQueryData: Array<{
  id: string;
  filePath: string;
  side: 'deletions' | 'additions';
  lineNumber: number;
  body: string;
  createdAt: string;
}> = [];

/** Records what `useCreateDiffCommentMutation`'s `mutate` was called with. */
let createCommentCalls: Array<{
  input: { filePath: string; side: string; lineNumber: number; body: string };
  onSuccess?: () => void;
}> = [];

vi.mock('@kontourai/station-sdk', () => ({
  useCodingDiffQuery: () => diffQueryResult,
  useDiffCommentsQuery: () => ({ data: commentsQueryData }),
  useCreateDiffCommentMutation: () => ({
    mutate: (
      input: {
        filePath: string;
        side: string;
        lineNumber: number;
        body: string;
      },
      opts?: { onSuccess?: () => void },
    ) => {
      createCommentCalls.push({ input, onSuccess: opts?.onSuccess });
      opts?.onSuccess?.();
    },
    isPending: false,
  }),
  useDeleteDiffCommentMutation: () => ({ mutate: vi.fn() }),
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:0' }),
}));

import {
  binaryFileNames,
  DiffPanel,
  diffFileChangeCounts,
  diffFileKind,
  diffTotalChangeCounts,
  LARGE_DIFF_COLLAPSE_THRESHOLD,
} from '../components/coding-layout/DiffPanel';
import { subscribeInteractiveWorkspacePerformanceMarks } from '../performance/interactive-workspace-performance-hooks';

const SAMPLE_PATCH = `diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
`;

// A second file with a different, independently-verifiable shape of changes
// (2 additions, 1 deletion) so multi-file total/per-file assertions aren't
// coincidentally right for the wrong reason.
const SECOND_FILE_PATCH = `diff --git a/bar.ts b/bar.ts
--- a/bar.ts
+++ b/bar.ts
@@ -1,2 +1,3 @@
-const x = 1;
+const x = 2;
+const y = 3;
 const z = 4;
`;

const MULTI_FILE_PATCH = `${SAMPLE_PATCH}${SECOND_FILE_PATCH}`;

// archive#3170 fixtures — real git diff shapes with zero hunks.
const PURE_RENAME_PATCH = `diff --git a/old-name.ts b/new-name.ts
similarity index 100%
rename from old-name.ts
rename to new-name.ts
`;

const BINARY_PATCH = `diff --git a/image.png b/image.png
index 1234567..89abcde 100644
Binary files a/image.png and b/image.png differ
`;

/**
 * Builds a valid unified-diff hunk that replaces `lineCount` old lines with
 * `lineCount` new lines (no context), so the file's total changed lines
 * (additions + deletions) is exactly `2 * lineCount` — used to exercise the
 * default-collapse-above-threshold behavior deterministically.
 */
function buildLargeFilePatch(path: string, lineCount: number): string {
  const deletions = Array.from(
    { length: lineCount },
    (_, i) => `-old line ${i}`,
  ).join('\n');
  const additions = Array.from(
    { length: lineCount },
    (_, i) => `+new line ${i}`,
  ).join('\n');
  return `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1,${lineCount} +1,${lineCount} @@
${deletions}
${additions}
`;
}

afterEach(() => {
  diffQueryResult = { data: '', isLoading: false, error: null };
  commentsQueryData = [];
  createCommentCalls = [];
});

describe('DiffPanel', () => {
  test('renders the panel header', () => {
    render(<DiffPanel workingDir="/repo" />);
    expect(screen.getByText('Git Diff')).toBeTruthy();
  });

  test('shows loading state', () => {
    diffQueryResult = { data: '', isLoading: true, error: null };
    render(<DiffPanel workingDir="/repo" />);
    expect(screen.getByLabelText('Loading diff')).toBeTruthy();
  });

  test('shows query errors', () => {
    diffQueryResult = {
      data: '',
      isLoading: false,
      error: { message: 'boom' },
    };
    render(<DiffPanel workingDir="/repo" />);
    expect(screen.getByText('boom')).toBeTruthy();
  });

  test('shows "No changes" for an empty patch', () => {
    render(<DiffPanel workingDir="/repo" />);
    expect(screen.getByText('No changes')).toBeTruthy();
  });

  test('renders a parsed patch via @pierre/diffs CodeView without throwing', () => {
    diffQueryResult = { data: SAMPLE_PATCH, isLoading: false, error: null };
    expect(() => render(<DiffPanel workingDir="/repo" />)).not.toThrow();
    // The @pierre/diffs CodeView mounts its <diffs-container> custom element on
    // the main thread (disableWorkerPool) rather than the hand-rolled markup.
    expect(customElements.get('diffs-container')).toBeTruthy();
  });

  test('marks the actual parsed diff layout commit without exposing patch content', async () => {
    diffQueryResult = { data: SAMPLE_PATCH, isLoading: false, error: null };
    const marks: unknown[] = [];
    const unsubscribe = subscribeInteractiveWorkspacePerformanceMarks((event) =>
      marks.push(event),
    );
    render(<DiffPanel workingDir="/repo" />);
    await waitFor(() =>
      expect(marks).toEqual(
        expect.arrayContaining([
          {
            kind: 'diff-commit',
            mark: {
              workingDir: '/repo',
              patchBytes: new TextEncoder().encode(SAMPLE_PATCH).byteLength,
              fileCount: 1,
              committedEpochMs: expect.any(Number),
            },
          },
        ]),
      ),
    );
    expect(
      document.querySelector(
        '[data-station-performance-surface="worktree-diff"]',
      ),
    ).toBeTruthy();
    expect(JSON.stringify(marks)).not.toContain('const b = 3');
    unsubscribe();
  });
});

describe('diffFileChangeCounts / diffTotalChangeCounts (pure, station#3104)', () => {
  test('counts are derived from the parsed diff, not a hardcoded fixture', () => {
    const [oneChange] = parsePatchFiles(SAMPLE_PATCH, 'test').flatMap(
      (p) => p.files,
    );
    expect(diffFileChangeCounts(oneChange)).toEqual({
      additions: 1,
      deletions: 1,
    });

    const [twoChanges] = parsePatchFiles(SECOND_FILE_PATCH, 'test').flatMap(
      (p) => p.files,
    );
    expect(diffFileChangeCounts(twoChanges)).toEqual({
      additions: 2,
      deletions: 1,
    });

    // Changing the diff text changes the derived counts — this is the load-
    // bearing assertion for "derived from the parsed diff, not a constant".
    expect(diffFileChangeCounts(oneChange)).not.toEqual(
      diffFileChangeCounts(twoChanges),
    );
  });

  test('total counts sum every file in a multi-file diff', () => {
    const files = parsePatchFiles(MULTI_FILE_PATCH, 'test').flatMap(
      (p) => p.files,
    );
    expect(files).toHaveLength(2);
    expect(diffTotalChangeCounts(files)).toEqual({
      additions: 3, // 1 (foo.ts) + 2 (bar.ts)
      deletions: 2, // 1 (foo.ts) + 1 (bar.ts)
    });
  });

  test('a file with no hunks has zero counts', () => {
    expect(diffFileChangeCounts({ hunks: [] } as never)).toEqual({
      additions: 0,
      deletions: 0,
    });
  });
});

describe('diffFileKind / binaryFileNames (pure, station#3170)', () => {
  test('a file with hunks is always "lines", regardless of type', () => {
    const [changed] = parsePatchFiles(SAMPLE_PATCH, 'test').flatMap(
      (p) => p.files,
    );
    expect(diffFileKind(changed, false)).toBe('lines');
    // Even if somehow flagged binary, real hunk content wins — a file with
    // actual +/- lines to show should never lose them to a kind label.
    expect(diffFileKind(changed, true)).toBe('lines');
  });

  test('a pure rename (no hunks) is "renamed"', () => {
    const [renamed] = parsePatchFiles(PURE_RENAME_PATCH, 'test').flatMap(
      (p) => p.files,
    );
    expect(renamed.hunks).toHaveLength(0);
    expect(renamed.type).toBe('rename-pure');
    expect(diffFileKind(renamed, false)).toBe('renamed');
  });

  test('binaryFileNames recovers the file name @pierre/diffs drops', () => {
    const names = binaryFileNames(BINARY_PATCH);
    expect(names.has('image.png')).toBe(true);
  });

  test('a binary file (no hunks, name resolved via binaryFileNames) is "binary"', () => {
    const [binary] = parsePatchFiles(BINARY_PATCH, 'test').flatMap(
      (p) => p.files,
    );
    expect(binary.hunks).toHaveLength(0);
    const isBinary = binaryFileNames(BINARY_PATCH).has(binary.name);
    expect(diffFileKind(binary, isBinary)).toBe('binary');
  });

  test('a hunkless, non-renamed, non-binary file falls back to "unknown"', () => {
    expect(diffFileKind({ hunks: [], type: 'change' } as never, false)).toBe(
      'unknown',
    );
  });
});

describe('DiffPanel change counts (rendered, station#3104)', () => {
  test('per-file and total counts render without expanding anything', () => {
    diffQueryResult = {
      data: MULTI_FILE_PATCH,
      isLoading: false,
      error: null,
    };
    render(<DiffPanel workingDir="/repo" />);

    // Panel-level total: 2 files, +3 additions, -2 deletions.
    expect(screen.getByText('2 files')).toBeTruthy();
    expect(screen.getByText('+3')).toBeTruthy();
    expect(screen.getByText('−2')).toBeTruthy();

    // Per-file counts for both files, present even though nothing was
    // clicked/expanded — foo.ts (+1/-1) and bar.ts (+2/-1).
    expect(screen.getAllByText('+1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('+2').length).toBeGreaterThan(0);
    expect(screen.getAllByText('−1').length).toBeGreaterThan(0);
  });
});

describe('DiffPanel change counts — hunkless files (station#3170)', () => {
  // Scoped to the PER-FILE header-metadata slot (`.diff-file-stat`), not the
  // panel-level total bar (`.diff-stat`) — the total legitimately sums to
  // +0/−0 across an all-rename/all-binary diff (an accurate aggregate over
  // zero changed lines), which is a different claim than the per-file
  // header's "nothing changed" the issue is about.
  function perFileStatText(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('.diff-file-stat')).map(
      (el) => el.textContent ?? '',
    );
  }

  test('a pure rename does not display +0 −0', () => {
    diffQueryResult = {
      data: PURE_RENAME_PATCH,
      isLoading: false,
      error: null,
    };
    const { container } = render(<DiffPanel workingDir="/repo" />);
    const stats = perFileStatText(container);
    expect(stats).toEqual(['renamed']);
    expect(stats.some((s) => s.includes('+0'))).toBe(false);
    expect(stats.some((s) => s.includes('−0'))).toBe(false);
  });

  test('a binary file does not display +0 −0', () => {
    diffQueryResult = { data: BINARY_PATCH, isLoading: false, error: null };
    const { container } = render(<DiffPanel workingDir="/repo" />);
    const stats = perFileStatText(container);
    expect(stats).toEqual(['binary']);
    expect(stats.some((s) => s.includes('+0'))).toBe(false);
    expect(stats.some((s) => s.includes('−0'))).toBe(false);
  });

  test('files with hunks are unchanged — still render numeric +/− counts', () => {
    diffQueryResult = {
      data: `${SAMPLE_PATCH}${PURE_RENAME_PATCH}`,
      isLoading: false,
      error: null,
    };
    render(<DiffPanel workingDir="/repo" />);
    // foo.ts (has hunks) still shows its numeric stat...
    expect(screen.getAllByText('+1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('−1').length).toBeGreaterThan(0);
    //...while the hunkless rename in the same diff shows its kind, not 0/0.
    expect(screen.getByText('renamed')).toBeTruthy();
  });
});

describe('DiffPanel collapse/expand (station#3104)', () => {
  test('collapse-all and expand-all work, and per-file state survives a re-render', () => {
    diffQueryResult = {
      data: MULTI_FILE_PATCH,
      isLoading: false,
      error: null,
    };
    const { rerender } = render(<DiffPanel workingDir="/repo" />);

    // Per-file toggles are named after the file ("Collapse foo.ts"), distinct
    // from the "Collapse all files"/"Expand all files" toolbar buttons.
    const perFileToggleName = /^(Collapse|Expand) \S+\.ts$/;
    const toggles = screen.getAllByRole('button', { name: perFileToggleName });
    // Two per-file collapse toggles, both start expanded (small diffs, under
    // the default-collapse threshold).
    expect(toggles).toHaveLength(2);
    for (const toggle of toggles) {
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
    }

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all files' }));
    for (const toggle of screen.getAllByRole('button', {
      name: perFileToggleName,
    })) {
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    }

    // Re-render with the same props (no state reset) — per-file collapse
    // state must survive, not fall back to the size-based default.
    rerender(<DiffPanel workingDir="/repo" />);
    for (const toggle of screen.getAllByRole('button', {
      name: perFileToggleName,
    })) {
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    }

    fireEvent.click(screen.getByRole('button', { name: 'Expand all files' }));
    for (const toggle of screen.getAllByRole('button', {
      name: perFileToggleName,
    })) {
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
    }
  });

  test('toggling a single file collapse is keyboard-reachable and exposes aria-expanded', () => {
    diffQueryResult = { data: SAMPLE_PATCH, isLoading: false, error: null };
    render(<DiffPanel workingDir="/repo" />);

    const toggle = screen.getByRole('button', {
      name: 'Collapse foo.ts',
    }) as HTMLButtonElement;
    expect(toggle.type).toBe('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    fireEvent.keyDown(toggle, { key: 'Enter' });
    // Browsers dispatch click for Enter/Space on native buttons; jsdom does
    // not, so simulate the resulting click directly (matches the pattern
    // used for ToolCallDisplay's disclosure toggle).
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: 'Expand foo.ts' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Expand foo.ts' }));
    expect(
      screen
        .getByRole('button', { name: 'Collapse foo.ts' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
  });

  test('a file above the size threshold collapses by default and still shows its counts', () => {
    // Comfortably over LARGE_DIFF_COLLAPSE_THRESHOLD (2 * lineCount changed
    // lines) so this isn't a boundary-fragile fixture.
    const lineCount = Math.ceil(LARGE_DIFF_COLLAPSE_THRESHOLD / 2) + 50;
    const bigPatch = buildLargeFilePatch('big.ts', lineCount);
    diffQueryResult = {
      data: `${bigPatch}${SECOND_FILE_PATCH}`,
      isLoading: false,
      error: null,
    };
    render(<DiffPanel workingDir="/repo" />);

    const bigToggle = screen.getByRole('button', { name: 'Expand big.ts' });
    expect(bigToggle.getAttribute('aria-expanded')).toBe('false');
    // The small file (well under threshold) stays expanded by default.
    expect(
      screen
        .getByRole('button', { name: 'Collapse bar.ts' })
        .getAttribute('aria-expanded'),
    ).toBe('true');

    // Collapsed does not mean invisible: its counts are still on screen.
    const bigHeader = bigToggle.closest('diffs-container') ?? document.body;
    expect(
      within(bigHeader as HTMLElement).getByText(`+${lineCount}`),
    ).toBeTruthy();
    expect(
      within(bigHeader as HTMLElement).getByText(`−${lineCount}`),
    ).toBeTruthy();
  });
});

// archive#3159: @pierre/diffs' controlled CodeView withholds a per-item
// update entirely (annotations, header content) when `item.version` is
// unchanged (see CodeView.js's syncItemRecord, and the two further
// version-keyed dedupe checks upstream of it — areSlotSnapshotsEqual and
// areManagedSnapshotsEqual — that gate the exact same field before a
// controlled update ever reaches React). #3104 introduced a shared
// `itemsRevisionRef` bumped on every genuine `items` recompute; since
// `commentsByFile` and `composer` are both dependencies of that same
// `items` useMemo, any comment-path state change already recomputes
// `items` and gets a fresh version. These tests drive that seam
// end-to-end through the real @pierre/diffs CodeView (not a mock) to
// prove each comment path actually re-renders, rather than reasoning
// from the library source.
describe('DiffPanel inline comments after first render (station#3159)', () => {
  test('a comment that arrives from a refetch after first render is rendered', async () => {
    diffQueryResult = { data: SAMPLE_PATCH, isLoading: false, error: null };
    commentsQueryData = [];
    const { rerender } = render(
      <DiffPanel workingDir="/repo" projectSlug="proj" />,
    );

    await waitFor(() =>
      expect(customElements.get('diffs-container')).toBeTruthy(),
    );
    expect(screen.queryByText('Hello from refetch')).toBeNull();

    // Simulate a TanStack Query refetch landing new data — same props,
    // only the (mocked) query's returned data changed, exactly like a real
    // cache update would re-render DiffPanel with a new `comments` array.
    commentsQueryData = [
      {
        id: 'c1',
        filePath: 'foo.ts',
        side: 'additions',
        lineNumber: 2,
        body: 'Hello from refetch',
        createdAt: new Date().toISOString(),
      },
    ];
    rerender(<DiffPanel workingDir="/repo" projectSlug="proj" />);

    await waitFor(() =>
      expect(screen.getByText('Hello from refetch')).toBeTruthy(),
    );
  });

  test('opening the composer after initial render shows the composer form', async () => {
    diffQueryResult = { data: SAMPLE_PATCH, isLoading: false, error: null };
    commentsQueryData = [
      {
        id: 'c1',
        filePath: 'foo.ts',
        side: 'additions',
        lineNumber: 2,
        body: 'Existing comment',
        createdAt: new Date().toISOString(),
      },
    ];
    render(<DiffPanel workingDir="/repo" projectSlug="proj" />);

    const replyButton = await waitFor(() =>
      screen.getByRole('button', { name: 'Reply' }),
    );
    expect(screen.queryByRole('textbox', { name: 'Comment' })).toBeNull();

    fireEvent.click(replyButton);

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Comment' })).toBeTruthy(),
    );
  });

  test('closing the composer after opening it hides the composer form again', async () => {
    diffQueryResult = { data: SAMPLE_PATCH, isLoading: false, error: null };
    commentsQueryData = [
      {
        id: 'c1',
        filePath: 'foo.ts',
        side: 'additions',
        lineNumber: 2,
        body: 'Existing comment',
        createdAt: new Date().toISOString(),
      },
    ];
    render(<DiffPanel workingDir="/repo" projectSlug="proj" />);

    const replyButton = await waitFor(() =>
      screen.getByRole('button', { name: 'Reply' }),
    );
    fireEvent.click(replyButton);
    const textarea = await waitFor(() =>
      screen.getByRole('textbox', { name: 'Comment' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reply' })).toBeTruthy(),
    );
    expect(textarea.isConnected).toBe(false);
  });

  test('posting a comment closes the composer, and the synced comment renders once the query updates', async () => {
    diffQueryResult = { data: SAMPLE_PATCH, isLoading: false, error: null };
    commentsQueryData = [
      {
        id: 'c1',
        filePath: 'foo.ts',
        side: 'additions',
        lineNumber: 2,
        body: 'Existing comment',
        createdAt: new Date().toISOString(),
      },
    ];
    const { rerender } = render(
      <DiffPanel workingDir="/repo" projectSlug="proj" />,
    );

    const replyButton = await waitFor(() =>
      screen.getByRole('button', { name: 'Reply' }),
    );
    fireEvent.click(replyButton);
    const textarea = await waitFor(() =>
      screen.getByRole('textbox', { name: 'Comment' }),
    );
    fireEvent.change(textarea, { target: { value: 'A brand new reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    // The mutation's onSuccess fires synchronously in this mock (matching
    // DiffPanel's real onSuccess:  => setComposer(null)) — the composer
    // must close even though the comments list hasn't "synced" yet.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reply' })).toBeTruthy(),
    );
    expect(screen.queryByRole('textbox', { name: 'Comment' })).toBeNull();
    expect(createCommentCalls).toHaveLength(1);
    expect(createCommentCalls[0]?.input).toEqual({
      filePath: 'foo.ts',
      side: 'additions',
      lineNumber: 2,
      body: 'A brand new reply',
    });

    // Now simulate the query cache actually syncing the newly-created
    // comment in (a real invalidateQueries refetch) — composer state and
    // comment data both changed since first render, exercising both
    // `items` dependencies (`composer`, `commentsByFile`) through the same
    // version bump at once.
    commentsQueryData = [
      ...commentsQueryData,
      {
        id: 'c2',
        filePath: 'foo.ts',
        side: 'additions',
        lineNumber: 2,
        body: 'A brand new reply',
        createdAt: new Date().toISOString(),
      },
    ];
    rerender(<DiffPanel workingDir="/repo" projectSlug="proj" />);

    await waitFor(() =>
      expect(screen.getByText('A brand new reply')).toBeTruthy(),
    );
  });
});
