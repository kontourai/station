// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
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
    render(
      <FilePreviewContent
        current={{
          url: 'blob:big',
          mediaType: 'text/plain',
          name: 'big.txt',
        }}
      />,
    );
    // Not cached → unavailable; cache it and remount to exercise the bound.
    await screen.findByText('Preview unavailable');
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

    expect(screen.getByText('No preview for this file type')).toBeTruthy();
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
