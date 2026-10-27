// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { authenticatedFetch, openPreview } = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  openPreview: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', () => ({ authenticatedFetch }));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../contexts/PreviewContext', () => ({
  usePreview: () => ({ openPreview }),
}));

import {
  attachmentBlobForObjectUrl,
  releaseAttachmentObjectUrl,
  resetAttachmentObjectUrls,
  storeAttachmentObjectUrl,
} from '../components/chat/attachment-object-urls';
import { FilePartPreview } from '../components/chat/FilePartPreview';

const REF = `sha256-${'a'.repeat(64)}`;
const createObjectURL = vi.fn((_blob: Blob) => 'blob:station-attachment');
const revokeObjectURL = vi.fn();

beforeEach(() => {
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  authenticatedFetch.mockReset();
  openPreview.mockReset();
});

afterEach(() => {
  resetAttachmentObjectUrls();
});

describe('FilePartPreview', () => {
  test('renders an inline restored image without fetching anything', async () => {
    render(
      <FilePartPreview
        part={{
          type: 'file',
          url: 'data:image/png;base64,aGVsbG8=',
          mediaType: 'image/png',
          name: 'screen.png',
        }}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Preview screen.png' }),
    ).toBeTruthy();
    expect(screen.getByAltText('screen.png')).toBeTruthy();
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  test('fetches the blob for a reference-only part and renders it (#3385)', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    const { unmount } = render(
      <FilePartPreview
        part={{
          type: 'file',
          blobRef: REF,
          mediaType: 'image/png',
          name: 'screen.png',
        }}
      />,
    );

    // This is the whole point of #3385: after a reload the transcript carries
    // a reference, not bytes, and the chip must still become a picture.
    const image = await waitFor(() => screen.getByAltText('screen.png'));
    expect(image.getAttribute('src')).toBe('blob:station-attachment');
    expect(authenticatedFetch).toHaveBeenCalledWith(
      `http://station.test/api/attachments/${REF}`,
    );
    // The route serves inert octet-stream; the renderable type comes from the
    // attachment's own metadata.
    expect(createObjectURL.mock.calls[0][0]).toMatchObject({
      type: 'image/png',
    });

    // Held while displayed, released when not. The cache revokes only on
    // eviction, so fill it with idle entries on both sides of the unmount.
    const storeIdle = (index: number) => {
      const ref = `sha256-${String(index).padStart(64, '0')}`;
      storeAttachmentObjectUrl(ref, `blob:idle-${index}`);
      releaseAttachmentObjectUrl(ref);
    };
    for (let index = 0; index < 32; index += 1) storeIdle(index);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:idle-0');
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:station-attachment');

    unmount();
    storeIdle(32);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:station-attachment');
  });

  test('falls back to the honest chip when the blob is gone', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );

    const { container } = render(
      <FilePartPreview
        part={{
          type: 'file',
          blobRef: REF,
          mediaType: 'image/png',
          name: 'screen.png',
        }}
      />,
    );

    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    expect(screen.getByText('screen.png')).toBeTruthy();
    expect(screen.getByText('image/png')).toBeTruthy();
    // No <img> promising bytes that are not here, and nothing to click through
    // to a preview that cannot open.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  test('shows the chip for a part carrying no reference at all (#3374)', () => {
    const { container } = render(
      <FilePartPreview
        part={{ type: 'file', mediaType: 'image/png', name: 'screen.png' }}
      />,
    );

    expect(screen.getByText('screen.png')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  test('opens a fetched non-image attachment in the previewer, with its bytes kept for reading', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(new TextEncoder().encode('%PDF-1.7'), { status: 200 }),
    );

    render(
      <FilePartPreview
        part={{
          type: 'file',
          blobRef: REF,
          mediaType: 'application/pdf',
          name: 'report.pdf',
        }}
        allParts={[
          {
            type: 'file',
            url: 'data:image/png;base64,aGVsbG8=',
            mediaType: 'image/png',
            name: 'sibling.png',
          },
        ]}
      />,
    );

    const open = await waitFor(() =>
      screen.getByRole('button', { name: 'Preview report.pdf' }),
    );
    // A document gets an icon, not an <img> that could never decode it.
    expect(open.querySelector('img')).toBeNull();
    fireEvent.click(open);
    expect(openPreview).toHaveBeenCalledWith(
      {
        url: 'blob:station-attachment',
        mediaType: 'application/pdf',
        name: 'report.pdf',
      },
      // The image gallery is not offered for a document.
      undefined,
    );
    // The previewer reads text from this Blob rather than fetching the blob:
    // URL, which the app's CSP refuses.
    const blob = attachmentBlobForObjectUrl('blob:station-attachment');
    expect(blob?.type).toBe('application/pdf');
    expect(blob?.size).toBe(8);
  });

  test('renders nothing for a part carrying no attachment identity at all', () => {
    const { container } = render(<FilePartPreview part={{ type: 'file' }} />);

    expect(container.firstChild).toBeNull();
  });

  describe('a large photo', () => {
    // Over the 256 KiB floor below which the chip shows the bytes themselves.
    const PHOTO = new Uint8Array(300 * 1024);
    const close = vi.fn();
    const createImageBitmap = vi.fn(async () => ({
      width: 160,
      height: 120,
      close,
    }));
    class FakeOffscreenCanvas {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext() {
        return { drawImage: () => {} };
      }
      async convertToBlob() {
        return new Blob([new Uint8Array(4)], { type: 'image/png' });
      }
    }

    beforeEach(() => {
      createImageBitmap.mockClear();
      close.mockClear();
      vi.stubGlobal('createImageBitmap', createImageBitmap);
      vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
      createObjectURL.mockImplementation((blob: Blob) =>
        blob.size === PHOTO.length
          ? 'blob:station-attachment'
          : 'blob:station-thumbnail',
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      createObjectURL.mockImplementation(() => 'blob:station-attachment');
    });

    function photo() {
      authenticatedFetch.mockResolvedValueOnce(
        new Response(PHOTO, { status: 200 }),
      );
      return (
        <FilePartPreview
          part={{
            type: 'file',
            blobRef: REF,
            mediaType: 'image/jpeg',
            name: 'photo.jpg',
          }}
        />
      );
    }

    test('shows a thumbnail sized to the chip, never the full image', async () => {
      let decode: (
        bitmap: Awaited<ReturnType<typeof createImageBitmap>>,
      ) => void = () => {};
      createImageBitmap.mockImplementationOnce(
        () => new Promise((resolve) => (decode = resolve)),
      );
      const { container } = render(photo());
      await waitFor(() => expect(createImageBitmap).toHaveBeenCalled());
      // While the thumbnail is being made the chip keeps its icon: an <img>
      // of the full bytes here is the 48 MB decode this exists to avoid.
      expect(container.querySelector('img')).toBeNull();
      decode({ width: 160, height: 120, close });
      const image = await waitFor(() => screen.getByAltText('photo.jpg'));
      expect(image.getAttribute('src')).toBe('blob:station-thumbnail');
      expect(image.getAttribute('width')).toBe('80');
      expect(image.getAttribute('height')).toBe('60');
      expect(createImageBitmap).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'image/jpeg' }),
        expect.objectContaining({ resizeWidth: 160 }),
      );
      expect(close).toHaveBeenCalledOnce();
      // The previewer still opens the full bytes.
      fireEvent.click(
        screen.getByRole('button', { name: 'Preview photo.jpg' }),
      );
      expect(openPreview.mock.calls[0][0].url).toBe('blob:station-attachment');
      expect(
        [...container.querySelectorAll('img')].map((img) =>
          img.getAttribute('src'),
        ),
      ).not.toContain('blob:station-attachment');
    });

    test('a row scrolled back into view reuses its thumbnail', async () => {
      const first = render(photo());
      await waitFor(() => screen.getByAltText('photo.jpg'));
      first.unmount();
      render(photo());
      const image = await waitFor(() => screen.getByAltText('photo.jpg'));
      expect(image.getAttribute('src')).toBe('blob:station-thumbnail');
      expect(createImageBitmap).toHaveBeenCalledOnce();
    });

    test('a browser that cannot make one shows the image as before', async () => {
      createImageBitmap.mockRejectedValueOnce(new Error('unsupported'));
      render(photo());
      const image = await waitFor(() => screen.getByAltText('photo.jpg'));
      expect(image.getAttribute('src')).toBe('blob:station-attachment');
      expect(image.getAttribute('width')).toBeNull();
    });
  });
});
