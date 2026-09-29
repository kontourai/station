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
    const { container } = render(
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
    // Neither digest reaches the DOM, as text or in any attribute.
    expect(container.innerHTML).not.toContain('a'.repeat(64));
    expect(container.innerHTML).not.toContain('b'.repeat(64));
  });

  test('exposes supervised progress and cancel, with no retry while uploading', () => {
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
    expect(
      screen.queryByRole('button', { name: 'Retry screenshot.webp' }),
    ).toBeNull();
    screen
      .getByRole('button', { name: 'Stop uploading screenshot.webp' })
      .click();
    expect(cancel).toHaveBeenCalledWith('a1');
    expect(retry).not.toHaveBeenCalled();
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
    expect(screen.getByText('Choose the file again')).toBeTruthy();
    expect(screen.getByLabelText('Choose expired.txt again')).toBeTruthy();
  });

  test('names a retained retryable stage as an action instead of exposing its enum', () => {
    const retry = vi.fn();
    render(
      <ComposerAttachmentStrip
        attachments={[attachment()]}
        stages={[
          {
            clientAttachmentId: 'a1',
            name: 'screenshot.webp',
            mimeType: 'image/webp',
            size: 1_048_576,
            state: 'retryable',
            progress: 0,
            error: 'Attachment upload did not finish.',
          },
        ]}
        onRemove={vi.fn()}
        onRetry={retry}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Upload didn't finish")).toBeTruthy();
    expect(screen.queryByText('retryable')).toBeNull();
    // × already removes the chip; a second "Cancel" beside it did the same
    // thing under another name.
    expect(
      screen.queryByRole('button', { name: /^(Cancel|Stop uploading) / }),
    ).toBeNull();
    screen.getByRole('button', { name: 'Retry screenshot.webp' }).click();
    expect(retry).toHaveBeenCalledWith('a1');
  });

  test('says an upload EXPIRED, rather than a bare retry demand, when its stage TTL lapsed', () => {
    const retry = vi.fn();
    render(
      <ComposerAttachmentStrip
        attachments={[attachment()]}
        stages={[
          {
            clientAttachmentId: 'a1',
            name: 'screenshot.webp',
            mimeType: 'image/webp',
            size: 1_048_576,
            state: 'retryable',
            progress: 0,
            expired: true,
            error: 'Attachment stage expired. Retry or choose the file again.',
          },
        ]}
        onRemove={vi.fn()}
        onRetry={retry}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Upload expired')).toBeTruthy();
    screen
      .getByRole('button', { name: 'Upload again screenshot.webp' })
      .click();
    expect(retry).toHaveBeenCalledWith('a1');
  });

  test('a full staging capacity says so and offers no Retry that cannot succeed', () => {
    render(
      <ComposerAttachmentStrip
        attachments={[attachment()]}
        stages={[
          {
            clientAttachmentId: 'a1',
            name: 'screenshot.webp',
            mimeType: 'image/webp',
            size: 1_048_576,
            state: 'failed',
            progress: 0,
            capacityFull: true,
            error: 'Attachment staging capacity is full.',
          },
        ]}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText('Upload limit reached')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /^(Retry|Upload again) / }),
    ).toBeNull();
  });

  test('an image chip says the engine refused images instead of "ready"', () => {
    render(
      <ComposerAttachmentStrip
        attachments={[attachment()]}
        stages={[
          {
            clientAttachmentId: 'a1',
            name: 'screenshot.webp',
            mimeType: 'image/webp',
            size: 1_048_576,
            state: 'complete',
            progress: 1,
            delivery: 'staged',
          },
        ]}
        onRemove={vi.fn()}
        imagesRefused
      />,
    );
    expect(screen.getByText('Not accepted here')).toBeTruthy();
    expect(screen.queryByText('Ready')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Remove screenshot.webp' }),
    ).toBeTruthy();
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
