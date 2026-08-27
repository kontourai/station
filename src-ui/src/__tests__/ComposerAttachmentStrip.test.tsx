// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { AttachmentPreviewMenu } from '../components/chat/AttachmentPreviewMenu';
import { ComposerAttachmentStrip } from '../components/chat/ComposerAttachmentStrip';
import type { FileAttachment } from '../types';

function attachment(overrides: Partial<FileAttachment> = {}): FileAttachment {
  return {
    id: 'a1',
    name: 'screenshot.webp',
    type: 'image/webp',
    size: 1_048_576,
    data: 'data:image/webp;base64,AAAA',
    preview: 'data:image/webp;base64,AAAA',
    ...overrides,
  };
}

describe('ComposerAttachmentStrip', () => {
  test('says a resized image was resized, with both sizes in text (#3375)', () => {
    render(
      <ComposerAttachmentStrip
        attachments={[
          attachment({
            resized: {
              fromBytes: 8 * 1024 * 1024,
              fromMimeType: 'image/png',
              width: 2048,
              height: 1152,
            },
          }),
        ]}
        onRemove={vi.fn()}
      />,
    );

    // Both numbers are readable text. A title attribute reaches neither a
    // touch user nor a screen reader, so asserting the delta there would be
    // asserting something most of this surface's readers never receive.
    const note = screen.getByText('Resized 8.0 MB → 1.0 MB');
    expect(note.getAttribute('title')).toBe(
      'Resized to fit the 5 MB attachment limit — sent at 2048×1152',
    );
  });

  test('says nothing about resizing when the original was sent', () => {
    render(
      <ComposerAttachmentStrip
        attachments={[attachment()]}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.queryByText(/Resized/)).toBeNull();
  });

  test('names a local HEIF conversion without exposing its source bytes', () => {
    render(
      <ComposerAttachmentStrip
        attachments={[
          attachment({
            type: 'image/jpeg',
            transformation: {
              kind: 'heif-to-jpeg',
              adapter: 'browser-native',
              source: {
                mimeType: 'image/heic',
                bytes: 123,
                sha256: 'a'.repeat(64),
              },
              output: {
                name: 'screenshot.jpg',
                mimeType: 'image/jpeg',
                bytes: 456,
                sha256: 'b'.repeat(64),
              },
            },
          }),
        ]}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText('Converted HEIF to JPEG locally')).toBeTruthy();
    expect(screen.queryByText('aaaaaaaa')).toBeNull();
  });

  test('exposes supervised progress plus retry and cancel controls', () => {
    const retry = vi.fn();
    const cancel = vi.fn();
    render(
      <ComposerAttachmentStrip
        attachments={[attachment()]}
        stages={[
          {
            clientAttachmentId: 'a1',
            name: 'screenshot.webp',
            mimeType: 'image/webp',
            size: 1_048_576,
            state: 'uploading',
            progress: 0.5,
            delivery: 'staged',
          },
        ]}
        onRemove={vi.fn()}
        onRetry={retry}
        onCancel={cancel}
      />,
    );
    expect(
      screen
        .getByRole('progressbar', {
          name: 'screenshot.webp upload progress',
        })
        .getAttribute('value'),
    ).toBe('0.5');
    screen.getByRole('button', { name: 'Cancel screenshot.webp' }).click();
    expect(cancel).toHaveBeenCalledWith('a1');
  });

  test('hydrates an expired stage as a visible choose-file-again chip', () => {
    render(
      <ComposerAttachmentStrip
        attachments={[]}
        stages={[
          {
            clientAttachmentId: 'retained-id',
            name: 'expired.txt',
            mimeType: 'text/plain',
            size: 2,
            state: 'failed',
            progress: 0,
            needsFile: true,
            error: 'Attachment stage expired.',
          },
        ]}
        onRemove={vi.fn()}
        onReplaceFile={vi.fn()}
      />,
    );
    expect(screen.getByText('Choose file again to retry')).toBeTruthy();
    expect(screen.getByLabelText('Choose expired.txt again')).toBeTruthy();
  });
});

describe('AttachmentPreviewMenu', () => {
  function renderMenu(overrides: Partial<FileAttachment> = {}) {
    render(
      <AttachmentPreviewMenu
        attachments={[attachment(overrides)]}
        onRemove={vi.fn()}
        onClearAll={vi.fn()}
        onAddMore={vi.fn()}
        onPreviewImage={vi.fn()}
      />,
    );
  }

  test('names the resize beside the size it reports (#3375)', () => {
    renderMenu({
      resized: {
        fromBytes: 8 * 1024 * 1024,
        fromMimeType: 'image/png',
        width: 2048,
        height: 1152,
      },
    });

    // Without this the popover's "1.0 MB" reads as the size of the file the
    // user picked, while the strip beside it says the image was resized.
    expect(screen.getByText('1.0 MB · resized from 8.0 MB')).toBeTruthy();
  });

  test('reports an untouched attachment as one size, in the strip’s units', () => {
    renderMenu();

    expect(screen.getByText('1.0 MB')).toBeTruthy();
    expect(screen.queryByText(/resized/)).toBeNull();
  });
});
