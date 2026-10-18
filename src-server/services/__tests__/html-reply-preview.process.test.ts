import { createServer } from 'node:http';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { HtmlReplyPreview } from '../html-reply-preview.js';

const makeTempDir = trackTempDirs();
test('Chromium preview returns PNG, measured height and console stacks inside the opaque page', async () => {
  const service = new HtmlReplyPreview(makeTempDir('html-preview-'));
  const result = await service.render(
    {
      html: `<h1>Preview integration</h1><script>console.log('preview log');console.log('heap limit',performance.memory.jsHeapSizeLimit);console.warn('preview warning');console.error('preview error');try{parent.document.body;console.log('PARENT ACCESS ALLOWED')}catch{console.log('parent blocked')}setTimeout(()=>{throw new Error('preview uncaught')},0)</script>`,
      height: 400,
    },
    800,
    'dark',
  );
  expect(Buffer.from(result.png, 'base64').subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  const heap = result.console.find((entry) =>
    entry.text.startsWith('heap limit '),
  );
  expect(heap).toBeDefined();
  expect(Number(heap?.text.split(' ').at(-1))).toBeLessThanOrEqual(
    256 * 1024 * 1024,
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

test('preview navigation and fetch cannot reach a loopback listener', async () => {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits++;
    response.end('unexpected network access');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No listener address');
  try {
    const url = `http://127.0.0.1:${address.port}/preview-probe`;
    const service = new HtmlReplyPreview(makeTempDir('html-preview-egress-'));
    const control = await service.render(
      { html: '<h1>egress prerequisite</h1>', height: 400 },
      800,
      'dark',
    );
    expect(control.contentHeight).toBeGreaterThan(0);
    await expect(
      service.render(
        {
          html: `<script>fetch('${url}').catch(()=>{});location.href='${url}'</script>`,
          height: 400,
        },
        800,
        'dark',
      ),
    ).rejects.toThrow('HTML preview exceeded 15 seconds');
    expect(
      hits,
      'preview must not send any HTTP request, including navigation',
    ).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 40000);
