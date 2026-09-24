// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  resetAttachmentObjectUrls,
  storeAttachmentObjectUrl,
} from '../components/chat/attachment-object-urls';
import FilePreviewContent from '../components/FilePreviewContent';

// The viewer's chunk never arrives (offline, or a stale chunk after an
// update): the dynamic import rejects.
vi.mock('../components/PdfCanvasViewer', () => {
  throw new Error('chunk failed to load');
});

afterEach(() => {
  resetAttachmentObjectUrls();
  vi.unstubAllGlobals();
});

test('keeps Download, and offers a retry, when the PDF viewer cannot load', async () => {
  Object.defineProperty(navigator, 'pdfViewerEnabled', {
    configurable: true,
    get: () => false,
  });
  storeAttachmentObjectUrl(
    'offline',
    'blob:offline-pdf',
    new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
  );
  render(
    <FilePreviewContent
      current={{
        url: 'blob:offline-pdf',
        mediaType: 'application/pdf',
        name: 'offline.pdf',
      }}
    />,
  );

  expect(
    await screen.findByText(
      'Station could not load the PDF viewer. Download the file, or try again.',
    ),
  ).toBeTruthy();
  expect(
    screen
      .getByRole('link', { name: 'Download offline.pdf' })
      .getAttribute('href'),
  ).toBe('blob:offline-pdf');
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
});
