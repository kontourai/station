// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', () => ({ authenticatedFetch }));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../contexts/PreviewContext', () => ({
  usePreview: () => ({ openPreview: vi.fn() }),
}));

import { resetAttachmentObjectUrls } from '../components/chat/attachment-object-urls';
import { FilePartPreview } from '../components/chat/FilePartPreview';

const REF = `sha256-${'a'.repeat(64)}`;
const createObjectURL = vi.fn((_blob: Blob) => 'blob:station-attachment');
const revokeObjectURL = vi.fn();

beforeEach(() => {
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  authenticatedFetch.mockReset();
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

    unmount();
    // Held while displayed, released when not — the cache revokes on eviction,
    // so an unmounted chip must not keep its hold forever.
    resetAttachmentObjectUrls();
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

  test('renders nothing for a part carrying no attachment identity at all', () => {
    const { container } = render(<FilePartPreview part={{ type: 'file' }} />);

    expect(container.firstChild).toBeNull();
  });
});
