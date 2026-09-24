// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// pdf.js is the module boundary for the canvas viewer (jsdom has no canvas or
// workers); the previewer's choice between frame and canvas is real.
const pdfjs = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock('pdfjs-dist', () => ({
  getDocument: pdfjs.getDocument,
  PDFWorker: { create: () => ({ destroy: () => undefined }) },
}));
class FakeWorker {
  terminate() {}
  addEventListener() {}
  removeEventListener() {}
}

import {
  releaseAttachmentObjectUrl,
  resetAttachmentObjectUrls,
  storeAttachmentObjectUrl,
} from '../components/chat/attachment-object-urls';
import FilePreviewContent, {
  filePreviewKind,
  TEXT_PREVIEW_CHAR_LIMIT,
} from '../components/FilePreviewContent';
import { PreviewProvider, usePreview } from '../contexts/PreviewContext';

function dataUrl(mediaType: string, text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${mediaType};base64,${btoa(binary)}`;
}

const createObjectURL = vi.fn((_blob: Blob) => 'blob:minted-pdf');
const revokeObjectURL = vi.fn();
const fetchSpy = vi.fn();
let pdfViewerEnabled: boolean | undefined;

beforeEach(() => {
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  fetchSpy.mockReset();
  pdfjs.getDocument.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal('Worker', FakeWorker);
  pdfViewerEnabled = true;
  Object.defineProperty(navigator, 'pdfViewerEnabled', {
    configurable: true,
    get: () => pdfViewerEnabled,
  });
});

afterEach(() => {
  resetAttachmentObjectUrls();
  vi.unstubAllGlobals();
});

describe('filePreviewKind', () => {
  test.each([
    ['application/pdf', 'pdf'],
    ['text/markdown', 'markdown'],
    ['application/json', 'json'],
    ['text/plain', 'text'],
    ['text/csv; charset=utf-8', 'text'],
    ['application/zip', 'none'],
  ] as const)('%s → %s', (mediaType, kind) => {
    expect(filePreviewKind(mediaType)).toBe(kind);
  });
});

describe('FilePreviewContent', () => {
  test('shows an inline plain-text attachment and offers the bytes', async () => {
    const url = dataUrl('text/plain', 'hello from the phone');
    render(
      <FilePreviewContent
        current={{ url, mediaType: 'text/plain', name: 'notes.txt' }}
      />,
    );

    expect(await screen.findByText('hello from the phone')).toBeTruthy();
    const download = screen.getByRole('link', { name: 'Download notes.txt' });
    expect(download.getAttribute('href')).toBe(url);
    // One slim row naming the type, not a row of its own for the button.
    const toolbar = download.closest('.file-preview__toolbar');
    expect(toolbar?.querySelector('.file-preview__kind')?.textContent).toBe(
      'Text',
    );
    expect(download.getAttribute('download')).toBe('notes.txt');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('reads a fetched attachment from the cached Blob, never by fetching its blob: URL', async () => {
    // The desktop/mobile CSP refuses fetch('blob:…'); a preview that re-read
    // the URL would work in a browser test and fail in the app.
    storeAttachmentObjectUrl(
      'ref text/csv',
      'blob:cached-csv',
      new Blob(['name,count\nwidgets,3'], { type: 'text/csv' }),
    );
    render(
      <FilePreviewContent
        current={{ url: 'blob:cached-csv', mediaType: 'text/csv', name: 'x' }}
      />,
    );

    expect(
      await screen.findByText(/widgets,3/, { selector: 'code' }),
    ).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('says so honestly when the bytes are not available to read', async () => {
    render(
      <FilePreviewContent
        current={{ url: 'blob:unknown', mediaType: 'text/plain', name: 'x' }}
      />,
    );

    expect(await screen.findByText('Preview unavailable')).toBeTruthy();
  });

  test('pretty-prints JSON', async () => {
    render(
      <FilePreviewContent
        current={{
          url: dataUrl('application/json', '{"a":1,"b":[2]}'),
          mediaType: 'application/json',
          name: 'data.json',
        }}
      />,
    );

    const code = await screen.findByText(/"a": 1/, { selector: 'code' });
    expect(code.textContent).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  });

  test('renders markdown as markdown', async () => {
    render(
      <FilePreviewContent
        current={{
          url: dataUrl('text/markdown', '# Release plan\n\n- ship it'),
          mediaType: 'text/markdown',
          name: 'plan.md',
        }}
      />,
    );

    expect(
      await screen.findByRole('heading', { name: 'Release plan' }),
    ).toBeTruthy();
    expect(screen.getByRole('listitem').textContent).toBe('ship it');
  });

  test('bounds a very large text file and says the rest is in the download', async () => {
    const big = 'x'.repeat(TEXT_PREVIEW_CHAR_LIMIT + 10);
    storeAttachmentObjectUrl('big', 'blob:big2', new Blob([big]));
    render(
      <FilePreviewContent
        current={{ url: 'blob:big2', mediaType: 'text/plain', name: 'b' }}
      />,
    );

    expect(await screen.findByText(/Showing the first/)).toBeTruthy();
    const code = document.querySelector('.file-preview__source code');
    expect(code?.textContent?.length).toBe(TEXT_PREVIEW_CHAR_LIMIT);
  });

  test('frames a PDF where the engine has a viewer, re-minting inline bytes as a blob URL', () => {
    render(
      <FilePreviewContent
        current={{
          url: dataUrl('application/pdf', '%PDF-1.7'),
          mediaType: 'application/pdf',
          name: 'report.pdf',
        }}
      />,
    );

    const frame = screen.getByTitle('report.pdf');
    expect(frame.tagName).toBe('IFRAME');
    // Browsers will not navigate a frame to a data: document.
    expect(frame.getAttribute('src')).toBe('blob:minted-pdf');
    expect(createObjectURL.mock.calls[0][0].type).toBe('application/pdf');
  });

  function renderablePdf(numPages: number) {
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
        scale,
      }),
      render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
      cleanup: () => undefined,
    };
    pdfjs.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages, getPage: async () => page }),
      destroy: () => Promise.resolve(),
    });
  }

  test.each([
    ['has no PDF viewer (Android WebView)', false],
    ['does not say whether it has one', undefined],
  ] as const)(
    'draws the PDF with pdf.js where the engine %s',
    async (_, enabled) => {
      pdfViewerEnabled = enabled;
      renderablePdf(2);
      const pdfBytes = new TextEncoder().encode('%PDF-1.7 cached bytes');
      storeAttachmentObjectUrl(
        'cached-pdf',
        'blob:cached-pdf',
        new Blob([pdfBytes], { type: 'application/pdf' }),
      );
      render(
        <FilePreviewContent
          current={{
            url: 'blob:cached-pdf',
            mediaType: 'application/pdf',
            name: 'report.pdf',
          }}
        />,
      );

      expect(
        await screen.findByRole('img', { name: 'Page 1 of 2' }),
      ).toBeTruthy();
      expect(screen.queryByTitle('report.pdf')).toBeNull();
      // pdf.js got the cached bytes themselves; nothing fetched the blob: URL.
      const { data } = pdfjs.getDocument.mock.calls[0][0];
      expect(Array.from(data)).toEqual(Array.from(pdfBytes));
      expect(fetchSpy).not.toHaveBeenCalled();
      const download = screen.getByRole('link', {
        name: 'Download report.pdf',
      });
      expect(download.getAttribute('href')).toBe('blob:cached-pdf');
      // Download sits at the end of the viewer's own zoom toolbar.
      expect(download.closest('.pdf-canvas-viewer__toolbar')).not.toBeNull();
      expect(document.querySelector('.file-preview__toolbar')).toBeNull();
    },
  );

  test('decodes an inline PDF for pdf.js without minting a frame URL', async () => {
    pdfViewerEnabled = false;
    renderablePdf(1);
    render(
      <FilePreviewContent
        current={{
          url: dataUrl('application/pdf', '%PDF-1.7 inline'),
          mediaType: 'application/pdf',
          name: 'inline.pdf',
        }}
      />,
    );

    expect(await screen.findByText('1 page')).toBeTruthy();
    const { data } = pdfjs.getDocument.mock.calls[0][0];
    expect(new TextDecoder().decode(data)).toBe('%PDF-1.7 inline');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  test('draws nothing on canvas for a "PDF" whose bytes Station does not hold', () => {
    pdfViewerEnabled = false;
    render(
      <FilePreviewContent
        current={{
          url: 'blob:not-ours',
          mediaType: 'application/pdf',
          name: 'stray.pdf',
        }}
      />,
    );

    expect(screen.getByText('Preview unavailable')).toBeTruthy();
    expect(pdfjs.getDocument).not.toHaveBeenCalled();
    expect(
      screen.getByRole('link', { name: 'Download stray.pdf' }),
    ).toBeTruthy();
  });

  test('refuses to frame a "PDF" whose URL is not bytes Station holds', () => {
    render(
      <FilePreviewContent
        current={{
          url: 'https://elsewhere.test/page',
          mediaType: 'application/pdf',
          name: 'report.pdf',
        }}
      />,
    );

    expect(screen.queryByTitle('report.pdf')).toBeNull();
    expect(screen.getByText('Preview unavailable')).toBeTruthy();
  });

  test('frames a blob: PDF only when the attachment cache minted it', () => {
    storeAttachmentObjectUrl(
      'owned',
      'blob:owned-pdf',
      new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
    );
    const { unmount } = render(
      <FilePreviewContent
        current={{
          url: 'blob:owned-pdf',
          mediaType: 'application/pdf',
          name: 'owned.pdf',
        }}
      />,
    );
    expect(screen.getByTitle('owned.pdf').getAttribute('src')).toBe(
      'blob:owned-pdf',
    );
    unmount();

    render(
      <FilePreviewContent
        current={{
          url: 'blob:not-ours',
          mediaType: 'application/pdf',
          name: 'stray.pdf',
        }}
      />,
    );
    expect(screen.queryByTitle('stray.pdf')).toBeNull();
    expect(screen.getByText('Preview unavailable')).toBeTruthy();
  });

  test('keeps links in an attached markdown file from navigating Station', async () => {
    render(
      <FilePreviewContent
        current={{
          url: dataUrl(
            'text/markdown',
            '[repo file](src/app.ts), [site](https://example.test/docs), [pr](https://github.com/acme/app/pull/7) and [forge file](https://github.com/acme/app/blob/main/src/app.ts)',
          ),
          mediaType: 'text/markdown',
          name: 'links.md',
        }}
      />,
    );

    // A relative link would resolve against Station's own origin; it is text.
    const relative = await screen.findByText('repo file');
    expect(relative.closest('a')).toBeNull();
    const external = screen.getByRole('link', { name: 'site' });
    expect(external.getAttribute('href')).toBe('https://example.test/docs');
    expect(external.getAttribute('target')).toBe('_blank');
    expect(external.getAttribute('rel')).toBe('noopener noreferrer');
    // A pull request has no pane to open in here; it is still a web page.
    expect(screen.getByRole('link', { name: 'pr' }).getAttribute('href')).toBe(
      'https://github.com/acme/app/pull/7',
    );
    // So is a file on a forge: no project here to open it from locally.
    expect(
      screen.getByRole('link', { name: 'forge file' }).getAttribute('href'),
    ).toBe('https://github.com/acme/app/blob/main/src/app.ts');
  });

  test('offers the download for a type it cannot render', () => {
    render(
      <FilePreviewContent
        current={{
          url: 'blob:zip',
          mediaType: 'application/zip',
          name: 'a.zip',
        }}
      />,
    );

    expect(screen.getByText("This file type can't be shown here")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download a.zip' })).toBeTruthy();
  });

  test('keeps Download reachable when pdf.js cannot open the PDF', async () => {
    pdfViewerEnabled = false;
    const locked = Promise.reject(
      Object.assign(new Error('No password given'), {
        name: 'PasswordException',
      }),
    );
    // The viewer awaits it; this only keeps the rejection from being reported
    // as unhandled before it does.
    locked.catch(() => undefined);
    pdfjs.getDocument.mockReturnValue({
      promise: locked,
      destroy: () => Promise.resolve(),
    });
    storeAttachmentObjectUrl(
      'locked',
      'blob:locked-pdf',
      new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
    );
    render(
      <FilePreviewContent
        current={{
          url: 'blob:locked-pdf',
          mediaType: 'application/pdf',
          name: 'locked.pdf',
        }}
      />,
    );

    expect(
      await screen.findByText('This PDF is password-protected'),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Download locked.pdf' })
        .getAttribute('href'),
    ).toBe('blob:locked-pdf');
  });

  test('sizes text previews to their content rather than the full panel', async () => {
    render(
      <FilePreviewContent
        current={{
          url: dataUrl('text/plain', 'short'),
          mediaType: 'text/plain',
          name: 'short.txt',
        }}
      />,
    );

    await screen.findByText('short');
    expect(document.querySelector('.file-preview__body')?.className).toContain(
      'file-preview__body--fit',
    );
  });
});

describe('PreviewProvider', () => {
  function Opener() {
    const { openPreview } = usePreview();
    return (
      <button
        type="button"
        onClick={() =>
          openPreview({
            url: dataUrl('text/plain', 'opened through the provider'),
            mediaType: 'text/plain',
            name: 'notes.txt',
          })
        }
      >
        open
      </button>
    );
  }

  test('holds the shown bytes after the opening chip lets go, so eviction cannot revoke them', async () => {
    const shown = 'blob:shown-text';
    storeAttachmentObjectUrl(
      'shown',
      shown,
      new Blob(['still here'], { type: 'text/plain' }),
    );
    function OpenShown() {
      const { openPreview } = usePreview();
      return (
        <button
          type="button"
          onClick={() =>
            openPreview({ url: shown, mediaType: 'text/plain', name: 's.txt' })
          }
        >
          open
        </button>
      );
    }
    const { unmount } = render(
      <PreviewProvider>
        <OpenShown />
      </PreviewProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(await screen.findByText('still here')).toBeTruthy();

    // The chip that opened it unmounts (transcript scrolled away) and a long
    // transcript pushes the cache past its idle budget.
    releaseAttachmentObjectUrl('shown');
    for (let i = 0; i < 40; i += 1) {
      storeAttachmentObjectUrl(`other-${i}`, `blob:other-${i}`);
      releaseAttachmentObjectUrl(`other-${i}`);
    }
    expect(revokeObjectURL).not.toHaveBeenCalledWith(shown);

    // Closing ends the dialog's hold; the next eviction may take it.
    unmount();
    storeAttachmentObjectUrl('one-more', 'blob:one-more');
    expect(revokeObjectURL).toHaveBeenCalledWith(shown);
  });

  test('opens the dialog for a non-image attachment', async () => {
    render(
      <PreviewProvider>
        <Opener />
      </PreviewProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'open' }));

    expect(await screen.findByText('opened through the provider')).toBeTruthy();
    expect(screen.getByText('notes.txt')).toBeTruthy();
  });
});
