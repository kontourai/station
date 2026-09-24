// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
  vi.stubGlobal('fetch', fetchSpy);
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
    const download = screen.getByRole('link', { name: 'Download' });
    expect(download.getAttribute('href')).toBe(url);
    // The row is the shared phone-safe action row (wrap, 44px, safe area).
    expect(
      download.closest('.responsive-surface-actions')?.className,
    ).toContain('file-preview__actions');
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

  test('offers the download instead of a blank frame where the engine has no PDF viewer', () => {
    pdfViewerEnabled = false; // Android WebView
    render(
      <FilePreviewContent
        current={{
          url: 'blob:cached-pdf',
          mediaType: 'application/pdf',
          name: 'report.pdf',
        }}
      />,
    );

    expect(screen.queryByTitle('report.pdf')).toBeNull();
    expect(screen.getByText("This device can't show PDFs here")).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Download' }).getAttribute('href'),
    ).toBe('blob:cached-pdf');
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
            '[repo file](src/app.ts), [site](https://example.test/docs) and [pr](https://github.com/acme/app/pull/7)',
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
    expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy();
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
