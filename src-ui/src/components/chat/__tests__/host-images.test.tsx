// @vitest-environment jsdom

import type { ChatHostImageMap } from '@kontourai/station-contracts/chat-host-images';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { authenticatedFetch, flags } = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  flags: { current: new Set<string>() },
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  authenticatedFetch,
}));
vi.mock('../../../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../contexts/ApiBaseContext')
  >()),
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => flags.current,
}));

import ReactMarkdown from 'react-markdown';
import { PreviewProvider } from '../../../contexts/PreviewContext';
import { resetAttachmentObjectUrls } from '../attachment-object-urls';
import {
  HostImagesContext,
  type HostImagesView,
  STREAMING_HOST_IMAGES,
  settledHostImages,
} from '../HostImagesContext';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { chatUrlTransform, HOST_IMAGE_SRC_PREFIX } from '../markdown-images';

/**
 * chat-host-images in an assistant row: the stored copy when Station kept
 * one, the reason when it refused, a pending note while streaming, and the
 * unchanged old behaviour while the preview is off.
 */

const REF = `sha256-${'b'.repeat(64)}`;
const PATH = '/tmp/station-icon-comparison.png';
const MAP: ChatHostImageMap = {
  images: {
    [PATH]: {
      blobRef: REF,
      mimeType: 'image/png',
      name: 'station-icon-comparison.png',
    },
  },
  refused: { '/etc/passwd.png': 'outside-allowed-roots' },
};

function renderRow(markdown: string, view: HostImagesView | null) {
  return render(
    <PreviewProvider>
      <HostImagesContext.Provider value={view}>
        <MarkdownRenderer>{markdown}</MarkdownRenderer>
      </HostImagesContext.Provider>
    </PreviewProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  flags.current = new Set(['chat-host-images']);
  authenticatedFetch.mockReset();
  Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:host-image'),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => resetAttachmentObjectUrls());

describe('host images in a reply', () => {
  test('a captured path renders the stored copy, fetched with the session credential', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );
    renderRow(
      `Before and after: ![Before and after icon sizing](${PATH})`,
      settledHostImages(MAP),
    );
    const image = await screen.findByAltText('Before and after icon sizing');
    expect(image.getAttribute('src')).toBe('blob:host-image');
    expect(authenticatedFetch).toHaveBeenCalledWith(
      `http://station.test/api/attachments/${REF}`,
    );
    expect(
      screen.getByRole('button', {
        name: 'Preview Before and after icon sizing',
      }),
    ).toBeTruthy();
  });

  test('a file: URL resolves to the same stored copy', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([1]), { status: 200 }),
    );
    renderRow(`![shot](file://${PATH})`, settledHostImages(MAP));
    expect((await screen.findByAltText('shot')).getAttribute('src')).toBe(
      'blob:host-image',
    );
  });

  test('a refused path says why, and never renders an <img> at the host path', () => {
    const { container } = renderRow(
      '![key](/etc/passwd.png)',
      settledHostImages(MAP),
    );
    expect(screen.getByRole('note').textContent).toContain(
      "Image not available on this device: it is outside this chat's working folder and temporary folder.",
    );
    expect(container.querySelector('img')).toBeNull();
  });

  test('a path with no record says it is not available; while streaming it says it is coming', () => {
    const settled = renderRow(
      '![x](/tmp/other.png)',
      settledHostImages(undefined),
    );
    expect(screen.getByRole('note').textContent).toContain(
      'Image not available on this device',
    );
    settled.unmount();
    renderRow('![x](/tmp/other.png)', STREAMING_HOST_IMAGES);
    expect(screen.getByRole('note').textContent).toBe(
      'Image appears when the reply finishes.',
    );
  });

  test('a stored copy the device cannot fetch becomes the chip, not a broken image', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );
    const { container } = renderRow(
      `![sizing](${PATH})`,
      settledHostImages(MAP),
    );
    await waitFor(() =>
      expect(screen.getByRole('note').textContent).toContain(
        'Station could not send its stored copy.',
      ),
    );
    expect(container.querySelector('img')).toBeNull();
  });

  test('preview off: the old rendering, with no fetch and no chip', () => {
    flags.current = new Set();
    const { container } = renderRow(
      `![sizing](${PATH})`,
      settledHostImages(MAP),
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe(PATH);
    expect(screen.queryByRole('note')).toBeNull();
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  test('outside an assistant row nothing changes', () => {
    const { container } = renderRow(`![sizing](${PATH})`, null);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(PATH);
  });

  test('the URL transform never lets a file: URL through, only an inert placeholder', () => {
    const img = { tagName: 'img' } as Parameters<typeof chatUrlTransform>[2];
    const a = { tagName: 'a' } as Parameters<typeof chatUrlTransform>[2];
    expect(chatUrlTransform(`file://${PATH}`, 'src', img)).toBe(
      `${HOST_IMAGE_SRC_PREFIX}${encodeURIComponent(PATH)}`,
    );
    expect(chatUrlTransform(`file://${PATH}`, 'href', a)).toBe('');
    expect(chatUrlTransform('file:///etc/passwd', 'src', img)).toBe('');
  });

  test('a renderer without MarkdownImage, given the same transform, emits no file: image', () => {
    const { container } = render(
      <ReactMarkdown urlTransform={chatUrlTransform}>
        {`![shot](file://${PATH})`}
      </ReactMarkdown>,
    );
    const src = container.querySelector('img')?.getAttribute('src') ?? '';
    expect(src.startsWith('file:')).toBe(false);
    expect(src.startsWith(HOST_IMAGE_SRC_PREFIX)).toBe(true);
  });

  test('outside an assistant row, a file: image still renders blank, as before', () => {
    const { container } = renderRow(`![shot](file://${PATH})`, null);
    expect(container.querySelector('img')?.getAttribute('src') ?? '').toBe('');
  });
});
