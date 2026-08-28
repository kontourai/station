/** @vitest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, test, vi } from 'vitest';

const previewQuery = vi.hoisted(() => vi.fn());
const addFileMock = vi.hoisted(() => vi.fn(() => true));
const hasFileMock = vi.hoisted(() => vi.fn(() => false));
const removeFileMock = vi.hoisted(() => vi.fn());
const downloadFilePreviewMock = vi.hoisted(() => vi.fn());

vi.mock('@kontourai/station-sdk/workspace-file-preview', () => ({
  useProjectWorkspaceFilePreviewQuery: previewQuery,
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

import { subscribeInteractiveWorkspacePerformanceMarks } from '../../performance/interactive-workspace-performance-hooks';
import {
  FilePreviewPane,
  FilePreviewSourceLines,
  highlightFilePreviewLine,
  isRenderedMarkdownWithinBudget,
  projectFilePreviewLines,
  shouldHighlightFilePreviewLines,
  useFilePreviewWrapController,
} from '../FilePreviewPane';

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

  test('removes the exact ranged attachment without removing other same-path context', () => {
    hasFileMock.mockReturnValueOnce(true);
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

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove from conversation' }),
    );
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

    fireEvent.click(
      screen.getByRole('button', { name: 'Add to conversation' }),
    );
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

  test.each(['html', 'pdf'] as const)(
    'keeps ready %s files out of the trusted origin without inventing a Browser Preview target',
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
      expect(downloadFilePreviewMock).toHaveBeenCalledWith(
        'demo',
        'docs/guide.html',
      );
    });
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:station-download');
    expect(document.querySelector('iframe')).toBeNull();
  });

  test('renders a validated bounded PNG payload as an inert image', () => {
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
      // The fallback is the shared region skeleton now ('s one loading
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

  test('rejects token-dense Markdown before building a large React tree', () => {
    expect(isRenderedMarkdownWithinBudget('*a'.repeat(4_096))).toBe(true);
    expect(isRenderedMarkdownWithinBudget('*a'.repeat(4_097))).toBe(false);
    expect(isRenderedMarkdownWithinBudget(`${'> '.repeat(4_096)}deep`)).toBe(
      false,
    );
    expect(isRenderedMarkdownWithinBudget(`${'- '.repeat(4_096)}deep`)).toBe(
      false,
    );
    expect(isRenderedMarkdownWithinBudget(`${'1. '.repeat(4_096)}deep`)).toBe(
      false,
    );
    expect(isRenderedMarkdownWithinBudget(`${'- > '.repeat(1_024)}deep`)).toBe(
      false,
    );
    expect(isRenderedMarkdownWithinBudget(`${'>\t'.repeat(2_048)}deep`)).toBe(
      false,
    );
  });

  test.each([
    ['unordered', `${'- '.repeat(4_096)}deep`],
    ['ordered', `${'1. '.repeat(4_096)}deep`],
    ['mixed unordered and blockquote', `${'- > '.repeat(1_024)}deep`],
    ['mixed ordered and blockquote', `${'1. > '.repeat(1_024)}deep`],
    ['tabbed blockquote', `${'>\t'.repeat(2_048)}deep`],
  ])('never parses a deeply nested %s list corpus', (_kind, content) => {
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

  test('routes structurally deep Markdown to the safe source view', () => {
    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'deep.md',
        status: 'ready',
        renderKind: 'markdown',
        mimeType: 'text/markdown',
        content: `${'> '.repeat(4_096)}deep`,
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
    fireEvent.click(screen.getByRole('checkbox', { name: 'Wrap lines' }));

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
    render(
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
    fireEvent.click(screen.getByRole('checkbox', { name: 'Wrap lines' }));
    expect(
      localStorage.getItem(
        'station:file-preview-pane-state:v1:file-preview%3Arange',
      ),
    ).toContain('"wrap":false');
  });

  test('the source-lines unit reveals the exact response-owned first line', () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    render(
      <FilePreviewSourceLines
        preview={{
          path: 'src/example.ts',
          status: 'ready',
          renderKind: 'source',
          lineRange: { start: 250, end: 251 },
          content: 'first\nsecond',
        }}
        state={{
          version: '1.0',
          projectSlug: 'demo',
          path: 'src/example.ts',
          lineRange: { start: 100, end: 101 },
          wrap: true,
        }}
        stateKey="file-preview:source-lines"
        wrap={true}
      />,
    );
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(screen.getByRole('link', { name: 'Link to line 250' })).toBeTruthy();
    delete (HTMLElement.prototype as { scrollIntoView?: unknown })
      .scrollIntoView;
  });

  test('the wrap controller owns local preference persistence', () => {
    const state = {
      version: '1.0' as const,
      projectSlug: 'demo',
      path: 'src/example.ts',
      wrap: true,
    };
    const { result } = renderHook(() =>
      useFilePreviewWrapController('file-preview:wrap-controller', state),
    );
    act(() => result.current.updateWrap(false));
    expect(result.current.wrap).toBe(false);
    expect(
      localStorage.getItem(
        'station:file-preview-pane-state:v1:file-preview%3Awrap-controller',
      ),
    ).toContain('"wrap":false');
  });

  test('projects sliced contract responses from the server-owned line range', () => {
    expect(
      projectFilePreviewLines(
        {
          path: 'src/example.ts',
          status: 'ready',
          renderKind: 'source',
          lineRange: { start: 100, end: 110 },
          content: Array.from(
            { length: 11 },
            (_, index) => `line ${index}`,
          ).join('\n'),
        },
        {
          version: '1.0',
          projectSlug: 'demo',
          path: 'src/example.ts',
          lineRange: { start: 100, end: 110 },
          wrap: true,
        },
      ).map((line) => line.number),
    ).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110]);
  });

  test('highlights as React text without accepting workspace markup authority', () => {
    const { container } = render(
      <code>
        {highlightFilePreviewLine('const value = "<script>";', true)}
      </code>,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toBe('const value = "<script>";');
  });

  test('falls back to one inert text payload before token-dense content exceeds the total React-node budget', () => {
    const dense = 'const value = 1;'.repeat(32_768);
    const lines = [{ number: 1, text: dense, requested: false }] as const;
    expect(dense.length).toBeGreaterThan(500_000);
    expect(shouldHighlightFilePreviewLines(lines, true)).toBe(false);
    expect(highlightFilePreviewLine(dense, true)).toBe(dense);

    previewQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        path: 'src/example.ts',
        status: 'ready',
        renderKind: 'source',
        content: dense,
      },
    });
    const { container } = renderPane();
    expect(
      container.querySelectorAll('[data-file-preview-token]'),
    ).toHaveLength(0);
  });
});
