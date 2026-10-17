import { expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { HtmlReplyPreview } from '../html-reply-preview.js';

const makeTempDir = trackTempDirs();
test('Chromium preview returns PNG, measured height and console stacks inside the opaque page', async () => {
  const service = new HtmlReplyPreview(makeTempDir('html-preview-'));
  const result = await service.render(
    {
      html: `<h1>Preview integration</h1><script>console.log('preview log');console.warn('preview warning');console.error('preview error');try{parent.document.body;console.log('PARENT ACCESS ALLOWED')}catch{console.log('parent blocked')}setTimeout(()=>{throw new Error('preview uncaught')},0)</script>`,
      height: 400,
    },
    800,
    'dark',
  );
  expect(Buffer.from(result.png, 'base64').subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  expect(result.width).toBe(800);
  expect(result.contentHeight).toBeGreaterThan(40);
  expect(result.console).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        level: 'log',
        text: expect.stringContaining('preview log'),
      }),
      expect.objectContaining({
        level: 'warning',
        text: expect.stringContaining('preview warning'),
      }),
      expect.objectContaining({
        level: 'error',
        text: expect.stringContaining('preview error'),
      }),
      expect.objectContaining({
        level: 'uncaught',
        text: expect.stringContaining('preview uncaught'),
        stack: expect.anything(),
      }),
      expect.objectContaining({
        level: 'log',
        text: expect.stringContaining('parent blocked'),
      }),
    ]),
  );
  expect(
    result.console.some((entry) =>
      entry.text.includes('PARENT ACCESS ALLOWED'),
    ),
  ).toBe(false);
}, 30_000);

test('preview rejects oversized layout, overflowing console and invalid viewport instead of returning partial output', async () => {
  const service = new HtmlReplyPreview(makeTempDir('html-preview-limits-'));
  await expect(
    service.render(
      { html: '<div style="height:4000px">Too tall</div>', height: 400 },
      800,
      'light',
    ),
  ).rejects.toThrow('height exceeds');
  await expect(
    service.render(
      {
        html: '<script>for(let i=0;i<150;i++)console.log(i)</script>',
        height: 400,
      },
      800,
      'light',
    ),
  ).rejects.toThrow('console exceeds');
  await expect(
    service.render({ html: '', height: 400 }, 10000, 'light'),
  ).rejects.toThrow('width');
}, 40_000);
