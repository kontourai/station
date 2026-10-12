/** @vitest-environment jsdom */

import { useApiQuery } from '@kontourai/station-sdk';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ComponentProps } from 'react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from 'vitest';

afterEach(() => vi.unstubAllGlobals());

const previewQuery = vi.hoisted(() => vi.fn());
const changesQuery = vi.hoisted(() => vi.fn());
const addFileMock = vi.hoisted(() => vi.fn(() => true));
const hasFileMock = vi.hoisted(() => vi.fn(() => false));
const removeFileMock = vi.hoisted(() => vi.fn());
const downloadFilePreviewMock = vi.hoisted(() => vi.fn());

vi.mock('@kontourai/station-sdk/workspace-file-preview', () => ({
  useProjectWorkspaceFilePreviewQuery: previewQuery,
  useProjectWorkspaceFileChangesQuery: changesQuery,
  // The SDK's classifier branches on the envelope's `code`; so does this.
  isRepositoryBusyError: (error: unknown) =>
    (error as { code?: string } | undefined)?.code === 'repository-busy',
  WORKSPACE_FILE_PREVIEW_MAX_BYTES: 512 * 1024,
  isWorkspaceFilePreviewImageDataUrl: (value: unknown, mimeType: unknown) =>
    typeof value === 'string' &&
    mimeType === 'image/png' &&
    /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value),
  downloadProjectWorkspaceFilePreview: downloadFilePreviewMock,
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn(), selectedProjectLayout: 'coding' }),
}));
vi.mock('../../providers/context/CodingFilesContextProvider', () => ({
  useCodingFilesContext: () => ({
    addFile: addFileMock,
    has: hasFileMock,
    removeFile: removeFileMock,
  }),
}));
vi.mock('../resolvedWorkspacePaneCatalog', () => ({
  useResolvedWorkspacePaneCatalog: () => ({ entries: [] }),
}));
// The real highlight client (jsdom has no Worker, so it tokenizes with the
// real Shiki on the main thread). A test may replace one answer to exercise
// the pane's refusal path; nothing else is stubbed.
const tokenizeOverride = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | ((code: string, lang: string) => Promise<unknown>),
}));
vi.mock('../../highlight/highlight-client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../highlight/highlight-client')>();
  return {
    ...actual,
    tokenizeCode: (code: string, lang: string) =>
      tokenizeOverride.current
        ? tokenizeOverride.current(code, lang)
        : actual.tokenizeCode(code, lang),
  };
});
afterEach(() => {
  tokenizeOverride.current = undefined;
});
beforeEach(() => {
  // The Changes toggle's pip reads this on every textual preview; a test that
  // is not about changes sees "no answer yet".
  changesQuery.mockReturnValue({
    isLoading: true,
    isError: false,
    data: undefined,
    refetch: vi.fn(),
  });
});

/** Choose one row of the header's ⋯ menu, by its role and name. */
function chooseMenuAction(
  name: string | RegExp,
  role: 'menuitem' | 'menuitemcheckbox' = 'menuitem',
) {
  fireEvent.click(screen.getByRole('button', { name: 'More file actions' }));
  fireEvent.click(screen.getByRole(role, { name }));
}

/** Shiki is real and cold on first use; allow its first grammar load. */
const HIGHLIGHT_TIMEOUT_MS = 10_000;
async function highlightedTokens(container: HTMLElement) {
  await waitFor(
    () =>
      expect(
        container
          .querySelector('[data-file-preview-syntax]')
          ?.getAttribute('data-file-preview-syntax'),
      ).toBe('ready'),
    { timeout: HIGHLIGHT_TIMEOUT_MS },
  );
  return [
    ...container.querySelectorAll<HTMLElement>('[data-file-preview-token]'),
  ];
}

import {
  INTERACTIVE_WORKSPACE_FILE_PREVIEW_REFRESH_EVENT,
  subscribeInteractiveWorkspacePerformanceMarks,
} from '../../performance/interactive-workspace-performance-hooks';
import {
  FilePreviewPane,
  MAX_SOURCE_HIGHLIGHT_TOKENS,
} from '../FilePreviewPane';
import { PaneHeadSlotsContext } from '../PaneHeadSlots';

// Receipt 3ea2e798 recorded the first real lazy Markdown chunk taking longer
// than Testing Library's default 1 s polling budget under full-lane load. Keep
// that extra headroom on the one cold-boundary assertion only: a chunk that
// does not settle still fails this test rather than being pre-imported or
// mocked away.
const COLD_RENDERED_MARKDOWN_QUERY_TIMEOUT_MS = 5_000;
const COLD_RENDERED_MARKDOWN_TEST_TIMEOUT_MS = 7_500;

function pane(props: ComponentProps<typeof FilePreviewPane>) {
  return <FilePreviewPane {...props} />;
}

function renderPaneAt(path: string) {
  return render(
    pane({
      projectSlug: 'demo',
      stateKey: 'file-preview:test',
      state: {
        version: '1.0',
        projectSlug: 'demo',
        path,
        wrap: true,
      },
    }),
  );
}

function renderPane() {
  return renderPaneAt('src/example.ts');
}

describe('FilePreviewPane', () => {
  test('marks the real decoded corpus layout and scroll surface without copying content', async () => {
    const marks: unknown[] = [];
    const unsubscribe = subscribeInteractiveWorkspacePerformanceMarks((event) =>
      marks.push(event),
    );
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'plain-text-100k-lines-v1.txt',
        status: 'ready',
        renderKind: 'text',
        sizeBytes: 199_999,
        lineCount: 100_000,
        content: Array.from({ length: 2_001 }, () => 'x').join('\n'),
      },
    });
    renderPaneAt('plain-text-100k-lines-v1.txt');
    const surface = document.querySelector<HTMLElement>(
      '[data-station-performance-surface="workspace-file-preview"]',
    );
    expect(surface).toBeTruthy();
    fireEvent.scroll(surface!, { target: { scrollTop: 100 } });
    await waitFor(() =>
      expect(marks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'file-preview-commit',
            mark: expect.objectContaining({
              path: 'plain-text-100k-lines-v1.txt',
              lineCount: 100_000,
              renderedLineCount: 2_000,
            }),
          }),
          expect.objectContaining({
            kind: 'file-preview-scroll',
            mark: expect.objectContaining({
              path: 'plain-text-100k-lines-v1.txt',
            }),
          }),
        ]),
      ),
    );
    expect(JSON.stringify(marks)).not.toContain('\nx\nx');
    unsubscribe();
  });

  test('a failed refresh never attests retained preview data, including after recovery', async () => {
    vi.stubEnv('VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE', '1');
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const data = {
      path: 'file.txt',
      status: 'ready' as const,
      renderKind: 'text' as const,
      sizeBytes: 1,
      lineCount: 1,
      content: 'x',
    };
    const read = vi.fn().mockRejectedValue(new Error('preview request failed'));
    const key = ['projects', 'demo', 'file-preview', { path: 'file.txt' }];
    client.setQueryData(key, data);
    previewQuery.mockImplementation(function usePreviewQuery(
      projectSlug: string,
      request: object,
    ) {
      return useQuery({
        queryKey: ['projects', projectSlug, 'file-preview', request],
        queryFn: read,
        staleTime: Infinity,
      });
    });
    const marks: unknown[] = [];
    const unsubscribe = subscribeInteractiveWorkspacePerformanceMarks((mark) =>
      marks.push(mark),
    );
    const view = render(
      <QueryClientProvider client={client}>
        <FilePreviewPane
          projectSlug="demo"
          stateKey="failed-refresh-test"
          state={{
            version: '1.0',
            projectSlug: 'demo',
            path: 'file.txt',
            wrap: true,
          }}
        />
      </QueryClientProvider>,
    );
    const failedCommit = expect.objectContaining({
      kind: 'file-preview-commit',
      mark: expect.objectContaining({ refreshNonce: 'fp-failed-1' }),
    });
    try {
      act(() =>
        window.dispatchEvent(
          new CustomEvent(INTERACTIVE_WORKSPACE_FILE_PREVIEW_REFRESH_EVENT, {
            detail: {
              projectSlug: 'demo',
              path: 'file.txt',
              nonce: 'fp-failed-1',
            },
          }),
        ),
      );
      await screen.findByText('Unable to load this Project file preview.');
      expect(marks).not.toContainEqual(failedCommit);
      read.mockResolvedValue(data);
      fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }));
      await waitFor(() =>
        expect(
          screen.queryByText('Unable to load this Project file preview.'),
        ).toBeNull(),
      );
      expect(marks).not.toContainEqual(failedCommit);
    } finally {
      view.unmount();
      unsubscribe();
      client.clear();
    }
  });

  test('reopening a cached preview cannot let its retired owner cancel the new refresh', async () => {
    vi.stubEnv('VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE', '1');
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const data = {
      path: 'file.txt',
      status: 'ready' as const,
      renderKind: 'text' as const,
      sizeBytes: 1,
      lineCount: 1,
      content: 'x',
    };
    client.setQueryData(
      ['projects', 'demo', 'file-preview', { path: 'file.txt' }],
      data,
    );
    let signal: AbortSignal | undefined;
    let finish: ((value: typeof data) => void) | undefined;
    previewQuery.mockImplementation(function usePreviewQuery(
      projectSlug: string,
      request: object,
    ) {
      return useApiQuery(
        ['projects', projectSlug, 'file-preview', request],
        (inputSignal) => {
          signal = inputSignal;
          return new Promise<typeof data>((resolve) => {
            finish = resolve;
          });
        },
        { staleTime: Infinity, cancelWhenInactive: true },
      );
    });
    let reopened = false;
    let dispatched = false;
    const unsubscribe = subscribeInteractiveWorkspacePerformanceMarks(
      (mark) => {
        if (!reopened || dispatched || mark.kind !== 'file-preview-commit')
          return;
        dispatched = true;
        window.dispatchEvent(
          new CustomEvent(INTERACTIVE_WORKSPACE_FILE_PREVIEW_REFRESH_EVENT, {
            detail: {
              projectSlug: 'demo',
              path: 'file.txt',
              nonce: 'fp-reopened',
            },
          }),
        );
      },
    );
    const pane = (key: string) => (
      <QueryClientProvider client={client}>
        <FilePreviewPane
          key={key}
          projectSlug="demo"
          stateKey="reopen-test"
          state={{
            version: '1.0',
            projectSlug: 'demo',
            path: 'file.txt',
            wrap: true,
          }}
        />
      </QueryClientProvider>
    );
    const view = render(pane('first'));
    try {
      reopened = true;
      view.rerender(pane('second'));
      await waitFor(() => expect(signal).toBeDefined());
      expect(signal!.aborted).toBe(false);
      view.unmount();
      expect(signal!.aborted).toBe(true);
    } finally {
      view.unmount();
      finish?.(data);
      unsubscribe();
      client.clear();
    }
  });

  test.each([false, true])(
    'a reference refresh performs one query read and commits its exact nonce (cached: %s)',
    async (cached) => {
      vi.stubEnv('VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE', '1');
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const read = vi.fn(async () => ({
        path: 'file.txt',
        status: 'ready' as const,
        renderKind: 'text' as const,
        sizeBytes: 1,
        lineCount: 1,
        content: 'x',
      }));
      previewQuery.mockImplementation(function usePreviewQuery(
        projectSlug: string,
        request: object,
      ) {
        return useQuery({
          queryKey: ['projects', projectSlug, 'file-preview', request],
          queryFn: read,
          staleTime: Infinity,
        });
      });
      if (cached)
        client.setQueryData(
          ['projects', 'demo', 'file-preview', { path: 'file.txt' }],
          {
            path: 'file.txt',
            status: 'ready',
            renderKind: 'text',
            sizeBytes: 1,
            lineCount: 1,
            content: 'x',
          },
        );
      const refresh = () =>
        window.dispatchEvent(
          new CustomEvent(INTERACTIVE_WORKSPACE_FILE_PREVIEW_REFRESH_EVENT, {
            detail: {
              projectSlug: 'demo',
              path: 'file.txt',
              nonce: 'fp-0-cold',
            },
          }),
        );
      let dispatched = false;
      const marks: unknown[] = [];
      const unsubscribe = subscribeInteractiveWorkspacePerformanceMarks(
        (mark) => {
          marks.push(mark);
          if (cached && !dispatched && mark.kind === 'file-preview-commit') {
            dispatched = true;
            refresh();
          }
        },
      );
      const view = render(
        <QueryClientProvider client={client}>
          <FilePreviewPane
            projectSlug="demo"
            stateKey="refresh-test"
            state={{
              version: '1.0',
              projectSlug: 'demo',
              path: 'file.txt',
              wrap: true,
            }}
          />
        </QueryClientProvider>,
      );
      try {
        await waitFor(() =>
          expect(marks).toContainEqual(
            expect.objectContaining({ kind: 'file-preview-commit' }),
          ),
        );
        if (!cached) {
          expect(read).toHaveBeenCalledTimes(1);
          act(refresh);
        }
        await waitFor(() =>
          expect(marks).toContainEqual(
            expect.objectContaining({
              kind: 'file-preview-commit',
              mark: expect.objectContaining({ refreshNonce: 'fp-0-cold' }),
            }),
          ),
        );
        expect(read).toHaveBeenCalledTimes(cached ? 1 : 2);
      } finally {
        view.unmount();
        unsubscribe();
        client.clear();
        previewQuery.mockReset();
        vi.unstubAllEnvs();
      }
    },
  );

  test.each(['relative', 'epoch'] as const)(
    'scroll marks preserve the %s event timestamp rather than its later handler time',
    async (clock) => {
      const marks: unknown[] = [];
      const unsubscribe = subscribeInteractiveWorkspacePerformanceMarks(
        (mark) => marks.push(mark),
      );
      previewQuery.mockReturnValue({
        isLoading: false,
        isError: false,
        data: {
          path: 'file.txt',
          status: 'ready',
          renderKind: 'text',
          sizeBytes: 1,
          lineCount: 1,
          content: 'x',
        },
      });
      const view = renderPaneAt('file.txt');
      try {
        const surface = document.querySelector(
          '[data-station-performance-surface="workspace-file-preview"]',
        )!;
        const event = new Event('scroll');
        Object.defineProperty(event, 'timeStamp', {
          value: clock === 'relative' ? 12 : performance.timeOrigin + 12,
        });
        fireEvent(surface, event);
        await waitFor(() =>
          expect(marks).toContainEqual(
            expect.objectContaining({
              kind: 'file-preview-scroll',
              mark: expect.objectContaining({
                scrolledEpochMs: performance.timeOrigin + 12,
              }),
            }),
          ),
        );
      } finally {
        view.unmount();
        unsubscribe();
      }
    },
  );

  test('a retired preview cannot publish a pending scroll frame', () => {
    const marks: unknown[] = [];
    const unsubscribe = subscribeInteractiveWorkspacePerformanceMarks((mark) =>
      marks.push(mark),
    );
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => {
      frames.push(frame);
      return 1;
    });
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'file.txt',
        status: 'ready',
        renderKind: 'text',
        sizeBytes: 1,
        lineCount: 1,
        content: 'x',
      },
    });
    try {
      const view = renderPaneAt('file.txt');
      const surface = document.querySelector(
        '[data-station-performance-surface="workspace-file-preview"]',
      )!;
      fireEvent.scroll(surface, { target: { scrollTop: 100 } });
      expect(frames.length).toBeGreaterThan(0);
      view.unmount();
      for (const frame of frames) frame(0);
      expect(marks).not.toContainEqual(
        expect.objectContaining({ kind: 'file-preview-scroll' }),
      );
    } finally {
      unsubscribe();
      vi.unstubAllGlobals();
    }
  });

  test('removes the exact ranged attachment without removing other same-path context', () => {
    // Attached for every render of this test: the menu reads it when opened.
    hasFileMock.mockReturnValue(true);
    onTestFinished(() => {
      hasFileMock.mockReturnValue(false);
    });
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'src/example.ts',
        status: 'ready',
        renderKind: 'source',
        lineRange: { start: 12, end: 18 },
        content: 'const exact = true;',
      },
    });
    render(
      pane({
        projectSlug: 'demo',
        stateKey: 'file-preview:remove-context',
        state: {
          version: '1.0',
          projectSlug: 'demo',
          path: 'src/example.ts',
          lineRange: { start: 12, end: 18 },
          wrap: true,
        },
      }),
    );

    chooseMenuAction('Remove from conversation');
    expect(removeFileMock).toHaveBeenCalledWith({
      projectSlug: 'demo',
      path: 'src/example.ts',
      lineRange: { start: 12, end: 18 },
    });
    expect(addFileMock).not.toHaveBeenCalled();
  });

  test('adds the exact ready selection to the active conversation context', () => {
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'src/example.ts',
        status: 'ready',
        renderKind: 'source',
        lineRange: { start: 12, end: 18 },
        content: 'const exact = true;',
      },
    });
    render(
      pane({
        projectSlug: 'demo',
        stateKey: 'file-preview:context',
        state: {
          version: '1.0',
          projectSlug: 'demo',
          path: 'src/example.ts',
          lineRange: { start: 12, end: 18 },
          wrap: true,
        },
      }),
    );

    chooseMenuAction('Add to conversation');
    expect(addFileMock).toHaveBeenCalledWith(
      {
        projectSlug: 'demo',
        path: 'src/example.ts',
        lineRange: { start: 12, end: 18 },
      },
      expect.objectContaining({ content: 'const exact = true;' }),
    );
  });

  test('uses the bounded Project preview query and renders source as text', () => {
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'src/example.ts',
        status: 'ready',
        renderKind: 'source',
        content: '<not executable />',
      },
    });

    renderPane();

    expect(previewQuery).toHaveBeenCalledWith('demo', {
      path: 'src/example.ts',
    });
    expect(screen.getByText('<not executable />')).toBeTruthy();
  });

  test('a preview opened from a worktree session reads through its thread (#2476)', () => {
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'src/example.ts',
        status: 'ready',
        renderKind: 'source',
        content: 'worktree copy',
      },
    });
    render(
      pane({
        projectSlug: 'demo',
        stateKey: 'file-preview:test',
        state: {
          version: '1.0',
          projectSlug: 'demo',
          path: 'src/example.ts',
          wrap: true,
          thread: 'thread-7',
        },
      }),
    );
    expect(previewQuery).toHaveBeenCalledWith('demo', {
      path: 'src/example.ts',
      thread: 'thread-7',
    });
  });

  test.each(['html', 'pdf'] as const)(
    'keeps ready %s files out of the trusted origin without inventing a Browser pane target',
    (renderKind) => {
      previewQuery.mockReturnValue({
        isLoading: false,
        isError: false,
        data: {
          path: `docs/guide.${renderKind}`,
          status: 'ready',
          renderKind,
        },
      });

      renderPane();

      expect(screen.getByRole('status').textContent).toContain(
        'does not supply one',
      );
      expect(document.querySelector('iframe')).toBeNull();
    },
  );

  test('downloads HTML through the authenticated attachment handoff without mounting it', async () => {
    downloadFilePreviewMock.mockResolvedValue({
      filename: 'guide.html',
      bytes: new Uint8Array([60, 98, 62]),
    });
    const createObjectURL = vi.fn(() => 'blob:station-download');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'docs/guide.html',
        status: 'ready',
        renderKind: 'html',
      },
    });

    renderPaneAt('docs/guide.html');
    fireEvent.click(screen.getByRole('button', { name: 'Download file' }));

    await waitFor(() => {
      // No thread: the handoff reads the project checkout (#2476).
      expect(downloadFilePreviewMock).toHaveBeenCalledWith(
        'demo',
        'docs/guide.html',
        undefined,
      );
    });
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:station-download');
    expect(document.querySelector('iframe')).toBeNull();
  });

  test('renders a validated bounded PNG payload as an inert image', () => {
    // jsdom has no layout; real image geometry is exercised in the browser spec.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'assets/example.png',
        status: 'ready',
        renderKind: 'image',
        mimeType: 'image/png',
        sizeBytes: 24,
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      },
    });

    renderPaneAt('assets/example.png');

    const image = screen.getByRole('img', {
      name: 'Preview of assets/example.png',
    });
    expect(image.getAttribute('src')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    );
    expect(screen.getByText('PNG · 24 bytes')).toBeTruthy();
    fireEvent.error(image);
    expect(screen.getByRole('alert').textContent).toContain(
      'could not be decoded',
    );
  });

  test('rejects an invalid ready image payload at the renderer boundary', () => {
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'assets/example.svg',
        status: 'ready',
        renderKind: 'image',
        mimeType: 'image/svg+xml',
        dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=',
      },
    });

    renderPaneAt('assets/example.svg');

    expect(screen.getByRole('alert').textContent).toContain(
      'bounded preview payload was not valid',
    );
    expect(document.querySelector('img')).toBeNull();
  });

  test(
    'renders bounded Markdown without active HTML, links, or remote images',
    async () => {
      previewQuery.mockReturnValue({
        isLoading: false,
        isError: false,
        data: {
          path: 'README.md',
          status: 'ready',
          renderKind: 'markdown',
          mimeType: 'text/markdown',
          content:
            '# Safe title\n<script>alert(1)</script>\n[link](https://example.com)\n![remote](https://example.com/x.png)',
        },
      });

      renderPaneAt('README.md');

      // The initial fallback proves this assertion traverses the production
      // React.lazy boundary before it checks the inert renderer's sanitizer.
      // The fallback is the shared region skeleton now (SHELL-13's one loading
      // vocabulary), so it names the wait in its accessible label rather than
      // as visible copy — the boundary it proves is the same one.
      expect(
        screen.getByLabelText('Loading bounded rendered Markdown preview'),
      ).toBeTruthy();
      expect(
        await screen.findByRole(
          'heading',
          { name: 'Safe title' },
          { timeout: COLD_RENDERED_MARKDOWN_QUERY_TIMEOUT_MS },
        ),
      ).toBeTruthy();
      expect(screen.queryByRole('link')).toBeNull();
      expect(document.querySelector('img')).toBeNull();
      expect(screen.getByText('link')).toBeTruthy();
      expect(screen.getByText('[Image omitted: remote]')).toBeTruthy();
      expect(document.querySelector('script')).toBeNull();
      expect(document.querySelector('input')).toBeNull();
    },
    COLD_RENDERED_MARKDOWN_TEST_TIMEOUT_MS,
  );

  test('keeps a bare-URL corpus as inert CommonMark text', async () => {
    const autolinkCorpus = Array.from({ length: 9_000 }, () => 'x.co').join(
      ' ',
    );
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'urls.md',
        status: 'ready',
        renderKind: 'markdown',
        mimeType: 'text/markdown',
        content: autolinkCorpus,
      },
    });

    renderPaneAt('urls.md');

    expect(
      document.querySelectorAll('[data-markdown-link-omitted]').length,
    ).toBe(0);
    expect(await screen.findByText(autolinkCorpus)).toBeTruthy();
  });

  test.each([
    ['at', 4_096, false],
    ['one past', 4_097, true],
  ])(
    'routes token-dense Markdown %s the 4,096-token budget (%i)',
    async (_edge, count, refused) => {
      previewQuery.mockReturnValue({
        isLoading: false,
        isError: false,
        data: {
          path: 'dense.md',
          status: 'ready',
          renderKind: 'markdown',
          mimeType: 'text/markdown',
          content: '*a'.repeat(count),
        },
      });

      renderPaneAt('dense.md');

      if (refused) {
        expect(screen.getByRole('status').textContent).toContain(
          'too complex for the bounded rendered view',
        );
        expect(
          screen.queryByRole('region', { name: 'Rendered Markdown preview' }),
        ).toBeNull();
      } else {
        expect(
          await screen.findByRole(
            'region',
            { name: 'Rendered Markdown preview' },
            { timeout: COLD_RENDERED_MARKDOWN_QUERY_TIMEOUT_MS },
          ),
        ).toBeTruthy();
        expect(
          screen.queryByText(/too complex for the bounded rendered view/),
        ).toBeNull();
      }
    },
    COLD_RENDERED_MARKDOWN_TEST_TIMEOUT_MS,
  );

  test.each([
    ['blockquote', `${'> '.repeat(4_096)}deep`],
    ['unordered', `${'- '.repeat(4_096)}deep`],
    ['ordered', `${'1. '.repeat(4_096)}deep`],
    ['mixed unordered and blockquote', `${'- > '.repeat(1_024)}deep`],
    ['mixed ordered and blockquote', `${'1. > '.repeat(1_024)}deep`],
    ['tabbed blockquote', `${'>\t'.repeat(2_048)}deep`],
  ])('never parses a deeply nested %s corpus', (_kind, content) => {
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'deep.md',
        status: 'ready',
        renderKind: 'markdown',
        mimeType: 'text/markdown',
        content,
      },
    });

    renderPaneAt('deep.md');

    expect(screen.getByRole('status').textContent).toContain(
      'too complex for the bounded rendered view',
    );
    expect(
      screen.queryByRole('region', { name: 'Rendered Markdown preview' }),
    ).toBeNull();
  });

  test('persists the Markdown source preference', () => {
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'README.md',
        status: 'ready',
        renderKind: 'markdown',
        mimeType: 'text/markdown',
        content: '# Source title',
      },
    });

    renderPaneAt('README.md');
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    chooseMenuAction('Wrap lines', 'menuitemcheckbox');

    expect(
      screen
        .getByRole('button', { name: 'Source' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    const persisted = localStorage.getItem(
      'station:file-preview-pane-state:v1:file-preview%3Atest',
    );
    expect(persisted).toContain('"markdownMode":"source"');
    expect(persisted).toContain('"wrap":false');
    expect(screen.getByRole('link', { name: 'Link to line 1' })).toBeTruthy();
  });

  test('forces a Markdown line reveal into accurate source mode', () => {
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'README.md',
        status: 'ready',
        renderKind: 'markdown',
        mimeType: 'text/markdown',
        lineRange: { start: 20, end: 20 },
        content: '<strong>literal source</strong>',
      },
    });
    render(
      pane({
        projectSlug: 'demo',
        stateKey: 'file-preview:markdown-range',
        state: {
          version: '1.0',
          projectSlug: 'demo',
          path: 'README.md',
          lineRange: { start: 20, end: 20 },
          wrap: true,
          markdownMode: 'rendered',
        },
      }),
    );

    expect(
      (
        screen.getByRole('button', {
          name: 'Rendered',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText(/Line reveal uses/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Link to line 20' })).toBeTruthy();
    expect(screen.getByText('<strong>literal source</strong>')).toBeTruthy();
  });

  test('renders explicit bounded status guidance', () => {
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'assets/large.bin',
        status: 'oversized',
        renderKind: 'unknown',
      },
    });

    renderPane();

    expect(screen.getByRole('status').textContent).toContain('too large');
  });

  test('renders the canonical empty primitive when no preview resolved', () => {
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: undefined,
    });

    renderPane();

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Nothing to preview');
    expect(status.textContent).toContain(
      'Station has not produced a preview for this file.',
    );
  });

  test('offers an executable retry for a transport error', () => {
    const refetch = vi.fn();
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
      refetch,
    });

    renderPane();

    fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test('renders anchored requested source lines and persists wrap locally', () => {
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'src/example.ts',
        status: 'ready',
        renderKind: 'source',
        lineRange: { start: 100, end: 102 },
        content: 'first\nsecond\nthird',
      },
    });
    const { container } = render(
      pane({
        projectSlug: 'demo',
        stateKey: 'file-preview:range',
        state: {
          version: '1.0',
          projectSlug: 'demo',
          path: 'src/example.ts',
          lineRange: { start: 100, end: 102 },
          wrap: true,
        },
      }),
    );
    expect(screen.getByText('Requested lines 100–102')).toBeTruthy();
    expect(
      document.getElementById('file-preview-file-preview:range-line-100'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Link to line 102' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More file actions' }));
    expect(
      screen
        .getByRole('menuitemcheckbox', { name: 'Wrap lines' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.click(
      screen.getByRole('menuitemcheckbox', { name: 'Wrap lines' }),
    );
    expect(
      localStorage.getItem(
        'station:file-preview-pane-state:v1:file-preview%3Arange',
      ),
    ).toContain('"wrap":false');
    // The code block follows the menu, not only the stored preference.
    expect(
      (container.querySelector('pre') as HTMLElement).style.whiteSpace,
    ).toBe('pre');
  });

  test('reveals the response-owned first line, not the requested one', () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      previewQuery.mockReturnValue({
        isLoading: false,
        isError: false,
        data: {
          path: 'src/example.ts',
          status: 'ready',
          renderKind: 'source',
          lineRange: { start: 250, end: 251 },
          content: 'first\nsecond',
        },
      });
      render(
        pane({
          projectSlug: 'demo',
          stateKey: 'file-preview:source-lines',
          state: {
            version: '1.0',
            projectSlug: 'demo',
            path: 'src/example.ts',
            lineRange: { start: 100, end: 101 },
            wrap: true,
          },
        }),
      );
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(
        document.getElementById(
          'file-preview-file-preview:source-lines-line-250',
        ),
      );
      expect(
        screen.getByRole('link', { name: 'Link to line 250' }),
      ).toBeTruthy();
      expect(
        screen.queryByRole('link', { name: 'Link to line 100' }),
      ).toBeNull();
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown })
        .scrollIntoView;
    }
  });

  test(
    'colours every grammar token through a theme rung, never a pigment (#2140)',
    async () => {
      // Each token NAMES a rung -- the pigment is the theme's decision, and
      // `theme-rung-contrast.test.ts` measures it.
      previewQuery.mockReturnValue({
        isLoading: false,
        isError: false,
        data: {
          path: 'src/example.ts',
          status: 'ready',
          renderKind: 'source',
          content: 'function greet(n: number) {\n  return "s" + 42; // done\n}',
        },
      });
      const { container } = renderPane();
      const tokens = await highlightedTokens(container);
      const colours = tokens.map((node) => node.style.color);
      expect(colours.length).toBeGreaterThan(0);
      for (const colour of colours) {
        expect(colour, `a token was painted with "${colour}"`).toMatch(
          /^var\(--(syntax-(keyword|number|string|function|tag|variable)|text-muted)\)$/,
        );
      }
      const rungOf = (text: string) =>
        tokens.find((node) => node.textContent === text)?.style.color;
      // A real grammar, not a keyword list: the function NAME is an entity
      // (a rung the retired regex tokenizer never produced), the comment is
      // muted, the literal is a string and 42 a constant.
      expect(rungOf('greet')).toBe('var(--syntax-function)');
      expect(rungOf('function')).toBe('var(--syntax-keyword)');
      expect(rungOf('42')).toBe('var(--syntax-number)');
      expect(
        tokens.some(
          (node) =>
            node.textContent?.includes('"s"') &&
            node.style.color === 'var(--syntax-string)',
        ),
      ).toBe(true);
      expect(
        tokens.some(
          (node) =>
            node.textContent?.includes('done') &&
            node.style.color === 'var(--text-muted)',
        ),
      ).toBe(true);
    },
    HIGHLIGHT_TIMEOUT_MS + 5_000,
  );

  test(
    'highlights by the file path language, not a JavaScript keyword list',
    async () => {
      previewQuery.mockReturnValue({
        isLoading: false,
        isError: false,
        data: {
          path: 'tools/job.py',
          status: 'ready',
          renderKind: 'source',
          content: 'def handler(event):\n    return None',
        },
      });
      const { container } = renderPaneAt('tools/job.py');
      const tokens = await highlightedTokens(container);
      expect(
        tokens.find((node) => node.textContent === 'def')?.style.color,
      ).toBe('var(--syntax-keyword)');
      expect(
        tokens.find((node) => node.textContent === 'handler')?.style.color,
      ).toBe('var(--syntax-function)');
    },
    HIGHLIGHT_TIMEOUT_MS + 5_000,
  );

  test(
    'highlights markup-bearing source as literal text, never as elements',
    async () => {
      // Workspace content is untrusted: markup inside a highlighted token (the
      // string literal) or in the gap between tokens must stay inert text.
      const line = 'const value = "<img src=x onerror=alert(1)>"; <b>gap</b>';
      previewQuery.mockReturnValue({
        isLoading: false,
        isError: false,
        data: {
          path: 'src/example.ts',
          status: 'ready',
          renderKind: 'source',
          content: line,
        },
      });
      const { container } = renderPane();
      // Proves the highlighted path ran, so the negatives below are not vacuous.
      const tokens = await highlightedTokens(container);
      expect(tokens.length).toBeGreaterThan(0);
      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector('b')).toBeNull();
      expect(
        tokens.some((node) =>
          node.textContent?.includes('<img src=x onerror=alert(1)>'),
        ),
      ).toBe(true);
      expect(container.textContent).toContain(line);
    },
    HIGHLIGHT_TIMEOUT_MS + 5_000,
  );

  test(
    'keeps a CRLF file byte-faithful while highlighting it',
    async () => {
      previewQuery.mockReturnValue({
        isLoading: false,
        isError: false,
        data: {
          path: 'src/example.ts',
          status: 'ready',
          renderKind: 'source',
          content: 'const a = 1;\r\nconst b = 2;\r\n',
        },
      });
      const { container } = renderPane();
      const tokens = await highlightedTokens(container);
      expect(tokens.some((node) => node.textContent === 'const')).toBe(true);
      expect(container.textContent).toContain('const b = 2;');
    },
    HIGHLIGHT_TIMEOUT_MS + 5_000,
  );

  test('refuses tokens that do not reproduce the text and says so', async () => {
    tokenizeOverride.current = async () => [
      [{ content: 'const forged = true;', color: '#F97583' }],
    ];
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'src/example.ts',
        status: 'ready',
        renderKind: 'source',
        content: 'const real = 1;',
      },
    });
    const { container } = renderPane();
    expect(
      await screen.findByText(
        'Syntax colours are off: the highlighter did not reproduce this text exactly.',
      ),
    ).toBeTruthy();
    expect(container.textContent).toContain('const real = 1;');
    expect(container.textContent).not.toContain('forged');
    expect(
      container.querySelectorAll('[data-file-preview-token]'),
    ).toHaveLength(0);
  });

  test('a highlighter failure leaves plain text and a stated reason', async () => {
    tokenizeOverride.current = async () => {
      throw new Error('highlight worker wedged (>8000ms)');
    };
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'src/example.ts',
        status: 'ready',
        renderKind: 'source',
        content: 'const plain = 1;',
      },
    });
    const { container } = renderPane();
    expect(
      await screen.findByText(
        'Syntax colours are off: the highlighter did not answer for this file.',
      ),
    ).toBeTruthy();
    expect(container.textContent).toContain('const plain = 1;');
  });

  test('refuses to colour past the span budget instead of colouring part of it', async () => {
    // 40,001 coloured runs: one past MAX_SOURCE_HIGHLIGHT_TOKENS (40,000),
    // answered in the exact shape the worker produces. The literal is pinned
    // beside the constant so a silent budget change reds here.
    expect(MAX_SOURCE_HIGHLIGHT_TOKENS).toBe(40_000);
    const lineCount = 2_000;
    const perLine = Math.ceil((MAX_SOURCE_HIGHLIGHT_TOKENS + 1) / lineCount);
    const text = Array.from({ length: perLine }, () => 'x').join(' ');
    tokenizeOverride.current = async () =>
      Array.from({ length: lineCount }, () =>
        text
          .split(' ')
          .flatMap((word, index) => [
            ...(index ? [{ content: ' ' }] : []),
            { content: word, color: '#F97583' },
          ]),
      );
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'src/example.ts',
        status: 'ready',
        renderKind: 'source',
        content: Array.from({ length: lineCount }, () => text).join('\n'),
      },
    });
    const { container } = renderPane();
    expect(
      await screen.findByText(
        'Syntax colours are off: this preview has more than 40,000 coloured tokens.',
      ),
    ).toBeTruthy();
    expect(
      container.querySelectorAll('[data-file-preview-token]'),
    ).toHaveLength(0);
  });

  test('states the rendered-line cap before the code, with the real total', () => {
    const content = Array.from(
      { length: 2_500 },
      (_, index) => `line ${index + 1}`,
    ).join('\n');
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'notes/long.txt',
        status: 'ready',
        renderKind: 'text',
        lineCount: 2_500,
        content,
      },
    });
    const { container } = renderPaneAt('notes/long.txt');
    const notice = screen.getByText(/Showing lines 1–2,000 of 2,500\./);
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain('renders at most 2,000 lines');
    const code = container.querySelector('section[aria-label$="source"]');
    expect(code).toBeTruthy();
    // Before the code in document order, so it is read first.
    expect(
      notice.compareDocumentPosition(code as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.queryByRole('link', { name: 'Link to line 2000' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('link', { name: 'Link to line 2001' }),
    ).toBeNull();
  });

  test('goes to a rendered line and refuses one outside the rendered lines', () => {
    const scrolled: string[] = [];
    (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView =
      function (this: HTMLElement) {
        scrolled.push(this.id);
      };
    try {
      previewQuery.mockReturnValue({
        isLoading: false,
        isError: false,
        data: {
          path: 'notes/short.txt',
          status: 'ready',
          renderKind: 'text',
          content: Array.from({ length: 40 }, (_, i) => `row ${i + 1}`).join(
            '\n',
          ),
        },
      });
      renderPaneAt('notes/short.txt');
      // Closed until asked for: no line input in the pane's chrome.
      expect(screen.queryByRole('form', { name: 'Go to line' })).toBeNull();
      chooseMenuAction('Go to line…');
      const input = screen.getByLabelText('Line');
      expect(document.activeElement).toBe(input);
      fireEvent.change(input, { target: { value: '41' } });
      fireEvent.click(screen.getByRole('button', { name: 'Go' }));
      expect(
        screen.getByText('Line 41 is not among the rendered lines 1–40.'),
      ).toBeTruthy();
      expect(scrolled).toEqual([]);
      fireEvent.change(input, { target: { value: '37' } });
      fireEvent.click(screen.getByRole('button', { name: 'Go' }));
      expect(scrolled.at(-1)).toBe('file-preview-file-preview:test-line-37');
      expect(document.activeElement).toBe(
        screen.getByRole('link', { name: 'Link to line 37' }),
      );
      // A successful jump closes the popover.
      expect(screen.queryByRole('form', { name: 'Go to line' })).toBeNull();

      // Shift+⌘G / Shift+Ctrl+G is the browser's; it opens nothing.
      fireEvent.keyDown(screen.getByRole('link', { name: 'Link to line 37' }), {
        key: 'G',
        ctrlKey: true,
        shiftKey: true,
      });
      expect(screen.queryByRole('form', { name: 'Go to line' })).toBeNull();
      // ⌘G / Ctrl+G from inside the pane opens it again; Escape closes it.
      fireEvent.keyDown(screen.getByRole('link', { name: 'Link to line 37' }), {
        key: 'g',
        ctrlKey: true,
      });
      const reopened = screen.getByRole('form', { name: 'Go to line' });
      fireEvent.keyDown(screen.getByLabelText('Line'), { key: 'Escape' });
      expect(reopened.isConnected).toBe(false);
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown })
        .scrollIntoView;
    }
  });

  test('copies the workspace-relative path and reports a refused clipboard', async () => {
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'src/example.ts',
        status: 'ready',
        renderKind: 'text',
        content: 'x',
      },
    });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderPane();
    const copy = screen.getByRole('button', { name: 'Copy path' });
    expect(copy.getAttribute('title')).toBe('Copy path (src/example.ts)');
    fireEvent.click(copy);
    // The icon itself confirms: a ✓ and a changed name, only after the write.
    expect(
      await screen.findByRole('button', { name: 'Path copied' }),
    ).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith('src/example.ts');
    writeText.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Path copied' }));
    expect(
      await screen.findByText(
        'This browser refused clipboard access. Select the path to copy it.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy path' })).toBeTruthy();
  });

  describe('Changes vs HEAD', () => {
    // A real `git diff HEAD -- src/example.ts` patch, the shape the server
    // returns verbatim in `patch`.
    const PATCH = `diff --git a/src/example.ts b/src/example.ts
index 3b18e51..a0423896 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,2 +1,2 @@
 const a = 1;
-const b = 2;
+const b = 3;
`;
    function readySource() {
      previewQuery.mockReturnValue({
        isLoading: false,
        isError: false,
        data: {
          path: 'src/example.ts',
          status: 'ready',
          renderKind: 'source',
          content: 'const a = 1;\nconst b = 3;',
        },
      });
    }
    function renderWithClient() {
      if (typeof globalThis.ResizeObserver === 'undefined') {
        vi.stubGlobal(
          'ResizeObserver',
          class {
            observe() {}
            unobserve() {}
            disconnect() {}
          },
        );
      }
      return render(
        <QueryClientProvider client={new QueryClient()}>
          {pane({
            projectSlug: 'demo',
            stateKey: 'file-preview:test',
            state: {
              version: '1.0',
              projectSlug: 'demo',
              path: 'src/example.ts',
              wrap: true,
              thread: 'thread-7',
            },
          })}
        </QueryClientProvider>,
      );
    }

    test('marks Changes with the changed-line count, then renders this file patch in the diff surface', async () => {
      readySource();
      changesQuery.mockReset();
      changesQuery.mockReturnValue({
        isLoading: false,
        isError: false,
        data: { state: 'changed', base: 'HEAD', patch: PATCH },
      });
      renderWithClient();
      // Same path and session as the preview (a worktree session's file is
      // diffed in that worktree), read for the pip before the view opens.
      expect(changesQuery).toHaveBeenCalledWith(
        'demo',
        { path: 'src/example.ts', thread: 'thread-7' },
        expect.objectContaining({ enabled: true }),
      );
      expect(
        screen
          .getByRole('button', { name: 'File' })
          .getAttribute('aria-pressed'),
      ).toBe('true');
      // One line out, one line in: the pip counts both, and says so by name.
      const changes = screen.getByRole('button', {
        name: 'Changes vs HEAD, 2 changed lines',
      });
      expect(changes.textContent).toBe('Changes2');

      fireEvent.click(changes);

      const region = await screen.findByRole('region', {
        name: 'src/example.ts changes against HEAD',
      });
      // The diff surface parsed the patch: one file, one line in, one out.
      await waitFor(() =>
        expect(within(region).getByText('1 file')).toBeTruthy(),
      );
      // Total and per-file stat both read +1/−1.
      expect(within(region).getAllByText('+1').length).toBeGreaterThan(0);
      expect(within(region).getAllByText('−1').length).toBeGreaterThan(0);
      expect(
        screen.queryByRole('region', { name: 'src/example.ts source' }),
      ).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'File' }));
      expect(
        screen.getByRole('region', { name: 'src/example.ts source' }),
      ).toBeTruthy();
    });

    test.each([
      [
        { state: 'unchanged', base: 'HEAD' },
        /matches the last commit \(HEAD\)/,
      ],
      [{ state: 'untracked' }, /not tracked by git/],
      [{ state: 'no-commits' }, /no commits yet/],
      [{ state: 'not-a-repository' }, /not inside a git repository/],
      [
        { state: 'oversized', limitBytes: 262_144 },
        /exceed the 256 KB in-app limit/,
      ],
      [
        {
          state: 'refused',
          reason: 'This repository defines programs git diff would run.',
        },
        /defines programs git diff would run/,
      ],
    ])(
      'says what %o means instead of showing an empty diff',
      async (data, text) => {
        readySource();
        changesQuery.mockReturnValue({
          isLoading: false,
          isError: false,
          data,
        });
        renderWithClient();
        fireEvent.click(
          screen.getByRole('button', { name: /^Changes vs HEAD/ }),
        );
        expect(await screen.findByText(text)).toBeTruthy();
        expect(screen.queryByText('No changes')).toBeNull();
      },
    );

    test('offers a retry when the changes read fails', () => {
      readySource();
      const refetch = vi.fn();
      changesQuery.mockReturnValue({
        isLoading: false,
        isError: true,
        data: undefined,
        error: new Error('HTTP 502'),
        refetch,
      });
      renderWithClient();
      fireEvent.click(screen.getByRole('button', { name: /^Changes vs HEAD/ }));
      expect(screen.getByRole('alert').textContent).toContain(
        "could not read this file's changes",
      );
      fireEvent.click(screen.getByRole('button', { name: 'Retry changes' }));
      expect(refetch).toHaveBeenCalled();
    });

    test('a repository that was being written is said to be busy, not failed or refused, and can be asked again', () => {
      readySource();
      const refetch = vi.fn();
      changesQuery.mockReturnValue({
        isLoading: false,
        isError: true,
        data: undefined,
        error: Object.assign(new Error('HTTP 503'), {
          status: 503,
          code: 'repository-busy',
        }),
        refetch,
      });
      renderWithClient();
      fireEvent.click(screen.getByRole('button', { name: /^Changes vs HEAD/ }));
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('status').textContent).toContain(
        'was being changed while Station read it',
      );
      expect(screen.queryByText(/could not read|not read/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(refetch).toHaveBeenCalled();
    });

    test('is not offered for a preview that is not text', () => {
      previewQuery.mockReturnValue({
        isLoading: false,
        isError: false,
        data: { path: 'x.bin', status: 'binary', renderKind: 'unknown' },
      });
      renderWithClient();
      expect(
        screen.queryByRole('button', { name: /^Changes vs HEAD/ }),
      ).toBeNull();
      // And nothing runs git for it.
      expect(changesQuery).toHaveBeenCalledWith(
        'demo',
        expect.anything(),
        expect.objectContaining({ enabled: false }),
      );
    });
  });
});

describe('FilePreviewPane inside a host that draws the head (design audit C4)', () => {
  test('under head slots the pane draws no bar of its own: the view toggle joins the head after the name and the actions before the close', () => {
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'src/example.ts',
        status: 'ready',
        renderKind: 'source',
        content: 'export const example = 1;',
      },
    });
    const leading = document.createElement('div');
    const trailing = document.createElement('div');
    document.body.append(leading, trailing);
    const removePane = vi.fn();
    const takeHostActions = vi.fn();
    try {
      const view = render(
        <PaneHeadSlotsContext.Provider
          value={{
            leading,
            trailing,
            hostActions: [
              {
                key: 'remove-pane',
                label: 'Remove pane',
                onSelect: removePane,
              },
            ],
            takeHostActions,
          }}
        >
          {pane({
            projectSlug: 'demo',
            stateKey: 'file-preview:test',
            state: {
              version: '1.0',
              projectSlug: 'demo',
              path: 'src/example.ts',
              wrap: true,
            },
          })}
        </PaneHeadSlotsContext.Provider>,
      );
      expect(document.querySelector('.workspace-file-preview__bar')).toBeNull();
      expect(
        screen.queryByRole('navigation', { name: 'File path' }),
      ).toBeNull();
      expect(
        within(leading).getByRole('button', { name: 'File' }),
      ).toBeTruthy();
      expect(
        within(leading).getByRole('button', { name: /^Changes vs HEAD/ }),
      ).toBeTruthy();
      expect(
        within(trailing).getByRole('button', { name: 'Copy path' }),
      ).toBeTruthy();
      expect(
        within(trailing).getByRole('button', { name: 'More file actions' }),
      ).toBeTruthy();
      // The file itself still renders below.
      expect(screen.getByText('export const example = 1;')).toBeTruthy();
      // The host's rows ride in the pane's own overflow, so the head keeps
      // one ⋯; the pane says it took them, and gives them back on unmount.
      expect(takeHostActions).toHaveBeenLastCalledWith(true);
      fireEvent.click(
        within(trailing).getByRole('button', { name: 'More file actions' }),
      );
      fireEvent.click(screen.getByRole('menuitem', { name: 'Remove pane' }));
      expect(removePane).toHaveBeenCalledTimes(1);
      view.unmount();
      expect(takeHostActions).toHaveBeenLastCalledWith(false);
    } finally {
      leading.remove();
      trailing.remove();
    }
  });
});
