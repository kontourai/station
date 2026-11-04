/**
 * Chromium's own decoder, canvas and encoder make an attachment thumbnail: a
 * real multi-megapixel JPEG comes back as a PNG no wider than 160px, sized
 * for the chip's 80px box, and an animated GIF is left alone.
 */
import { expect, test } from 'vitest';
import { scrollBrowserFixture } from './scroll-browser-fixture';

declare global {
  interface Window {
    thumbnailProbe: () => Promise<unknown>;
  }
}

test('turns a large photo into a chip-sized PNG and leaves a GIF alone', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(`
    import {createAttachmentThumbnail} from './src-ui/src/components/chat/attachment-thumbnails';
    window.thumbnailProbe = async () => {
      // Noise does not compress, so a 3000x2000 JPEG lands well over the
      // 256 KiB floor, as a phone photo does.
      const canvas = document.createElement('canvas');
      canvas.width = 3000;
      canvas.height = 2000;
      const context = canvas.getContext('2d');
      const pixels = context.createImageData(3000, 2000);
      for (let index = 0; index < pixels.data.length; index += 1)
        pixels.data[index] = (index * 2654435761) >>> 24;
      context.putImageData(pixels, 0, 0);
      const photo = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      const thumbnail = await createAttachmentThumbnail(photo);
      const decoded = await createImageBitmap(thumbnail.blob);
      const gif = new Blob([new Uint8Array(300 * 1024)], { type: 'image/gif' });
      return {
        photoBytes: photo.size,
        type: thumbnail.blob.type,
        thumbnailBytes: thumbnail.blob.size,
        pixels: [decoded.width, decoded.height],
        chip: [thumbnail.width, thumbnail.height],
        gif: await createAttachmentThumbnail(gif),
      };
    };
  `);
  try {
    await page.waitForFunction(() => 'thumbnailProbe' in window);
    const result = (await page.evaluate(() => window.thumbnailProbe())) as {
      photoBytes: number;
      type: string;
      thumbnailBytes: number;
      pixels: [number, number];
      chip: [number, number];
      gif: unknown;
    };
    expect(errors).toEqual([]);
    expect(result.photoBytes).toBeGreaterThan(256 * 1024);
    expect(result.type).toBe('image/png');
    expect(result.pixels).toEqual([160, 107]);
    expect(result.chip).toEqual([80, 54]);
    expect(result.thumbnailBytes).toBeLessThan(result.photoBytes / 4);
    expect(result.gif).toBeNull();
  } finally {
    await browser.close();
  }
}, 60_000);
