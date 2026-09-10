/** Real image controls and modal host, with browser-decoded generated images.
 * No backend, provider, or OS delivery is represented by this component harness.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { test } from './helpers/fixture-audit';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let script = '';

test.beforeAll(async () => {
  const bundle = await build({
    stdin: {
      resolveDir: ROOT,
      loader: 'tsx',
      contents: `
        import { createRoot } from 'react-dom/client';
        import { PreviewProvider, usePreview } from './src-ui/src/contexts/PreviewContext';
        import { ImageInspector } from './src-ui/src/components/ImageInspector';
        const canvas = document.createElement('canvas');
        canvas.width = 2400; canvas.height = 1600;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#4380bd'; ctx.fillRect(0, 0, 2400, 1600);
        ctx.fillStyle = '#fff'; ctx.font = '72px sans-serif';
        ctx.fillText('Upper left', 50, 100); ctx.fillText('Lower right', 1900, 1500);
        const large = { url: canvas.toDataURL(), name: 'Large screenshot', mediaType: 'image/png' };
        canvas.width = 300; canvas.height = 900;
        const portrait = { url: canvas.toDataURL(), name: 'Portrait', mediaType: 'image/png' };
        function Open() {
          const { openPreview } = usePreview();
          return <>
            <button onClick={() => openPreview(large, [large, portrait])}>Inspect attachment</button>
            <button onClick={() => openPreview({ url: 'data:image/png;base64,invalid', name: 'Invalid image', mediaType: 'image/png' })}>Inspect broken image</button>
            <div style={{ width: 400, height: 300 }}><ImageInspector src={large.url} name="Inline file preview" /></div>
          </>;
        }
        createRoot(document.getElementById('root')).render(<PreviewProvider><Open /></PreviewProvider>);
      `,
    },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'empty' },
    write: false,
    platform: 'browser',
  });
  script = bundle.outputFiles[0].text;
});

async function mount(page: Page, theme = 'dark') {
  await page.setContent(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>',
  );
  for (const file of [
    'node_modules/@kontourai/ui/tokens/tokens.css',
    'src-ui/src/tokens.css',
    'src-ui/src/index.css',
    'src-ui/src/components/ImageInspector.css',
  ]) {
    await page.addStyleTag({ path: join(ROOT, file) });
  }
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
  await page.addScriptTag({ content: script });
  await page
    .getByRole('button', { name: 'Inspect attachment', exact: true })
    .click();
  await expect(
    page
      .getByRole('dialog', { name: 'Preview' })
      .getByRole('button', { name: 'Actual size', exact: true }),
  ).toBeEnabled();
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Preview' });

test('actual size, keyboard pan, fit, image navigation and focus return', async ({
  page,
}) => {
  await mount(page);
  const panel = dialog(page);
  const scrim = page.locator('.image-preview-overlay');
  const covered = (await scrim.boundingBox())!;
  expect(covered.x).toBe(0);
  expect(covered.y).toBe(0);
  expect(covered.width).toBe(page.viewportSize()!.width);
  expect(covered.height).toBe(page.viewportSize()!.height);
  expect(
    await page.evaluate(() =>
      document
        .elementFromPoint(2, 2)
        ?.classList.contains('image-preview-overlay'),
    ),
  ).toBe(true);
  const image = panel.getByRole('img', { name: 'Large screenshot' });
  const view = panel.getByRole('region', { name: 'Image viewport' });
  expect((await image.boundingBox())!.width).toBeLessThan(2400);
  await panel.getByRole('button', { name: 'Actual size', exact: true }).click();
  await expect(panel.getByLabel('Image zoom level')).toHaveText('100%');
  expect((await image.boundingBox())!.width).toBe(2400);
  await view.focus();
  const before = await view.evaluate((el) => el.scrollLeft);
  await page.keyboard.press('ArrowRight');
  expect(await view.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before);
  await expect(image).toBeVisible();
  await page.keyboard.press('Home');
  expect(await view.evaluate((el) => el.scrollLeft)).toBe(0);
  await page.keyboard.press('ArrowRight');
  await expect(panel.getByRole('img', { name: 'Portrait' })).toBeVisible();
  await expect(view).toBeFocused();
  await panel
    .getByRole('button', { name: 'Previous image', exact: true })
    .click();
  await expect(image).toBeVisible();
  expect((await image.boundingBox())!.width).toBeLessThan(2400);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Inspect attachment', exact: true }),
  ).toBeFocused();
});

test('pointer drag pans without dismissing and Alt+wheel preserves the pointer anchor', async ({
  page,
}) => {
  await mount(page);
  const panel = dialog(page);
  await panel.getByRole('button', { name: 'Actual size', exact: true }).click();
  const view = panel.getByRole('region', { name: 'Image viewport' });
  const box = (await view.boundingBox())!;
  const x = box.x + box.width * 0.6;
  const y = box.y + box.height * 0.6;
  const before = await view.evaluate((el) => ({
    x: el.scrollLeft,
    y: el.scrollTop,
  }));
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 80, y - 60, { steps: 6 });
  await page.mouse.up();
  expect(await view.evaluate((el) => el.scrollLeft)).toBeGreaterThan(
    before.x + 70,
  );
  expect(await view.evaluate((el) => el.scrollTop)).toBeGreaterThan(
    before.y + 50,
  );
  await expect(panel).toBeVisible();
  const old = await view.evaluate((el) => el.scrollLeft);
  await page.mouse.move(x, y);
  await page.keyboard.down('Alt');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Alt');
  await expect(panel.getByLabel('Image zoom level')).toHaveText('125%');
  expect(await view.evaluate((el) => el.scrollLeft)).toBeCloseTo(
    (old + box.width * 0.6) * 1.25 - box.width * 0.6,
    -1,
  );
});

for (const theme of ['light', 'dark']) {
  test(`narrow ${theme} preview keeps controls reachable through rotation and traps focus`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(page, theme);
    const panel = dialog(page);
    for (const button of await panel.getByRole('button').all()) {
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const view = panel.getByRole('region', { name: 'Image viewport' });
    await view.focus();
    await page.keyboard.press('Tab');
    await expect(
      panel.getByRole('button', { name: 'Close preview', exact: true }),
    ).toBeFocused();
    await page.setViewportSize({ width: 844, height: 390 });
    await panel.getByRole('button', { name: 'Fit', exact: true }).click();
    const image = (await panel.getByRole('img').boundingBox())!;
    const frame = (await view.boundingBox())!;
    expect(image.height).toBeLessThanOrEqual(frame.height);
    expect(frame.height).toBeGreaterThan(20);
    await page.screenshot({
      path: test.info().outputPath(`image-preview-${theme}.png`),
    });
  });
}

test('invalid image stays dismissible and inline file inspector uses the same controls', async ({
  page,
}) => {
  await mount(page);
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: 'Inspect broken image', exact: true })
    .click();
  await expect(dialog(page).getByRole('alert')).toContainText(
    'could not be loaded',
  );
  await expect(
    dialog(page).getByRole('button', { name: 'Actual size', exact: true }),
  ).toBeDisabled();
  await dialog(page)
    .getByRole('button', { name: 'Close preview', exact: true })
    .click();
  await page.getByRole('button', { name: 'Actual size', exact: true }).click();
  await expect(page.getByLabel('Image zoom level')).toHaveText('100%');
  expect(
    (await page
      .getByRole('img', { name: 'Inline file preview' })
      .boundingBox())!.width,
  ).toBe(2400);
});

test('browser touch pinch zooms and cancellation leaves drag usable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page);
  const panel = dialog(page);
  const view = panel.getByRole('region', { name: 'Image viewport' });
  const box = (await view.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const image = panel.getByRole('img', { name: 'Large screenshot' });
  const before = (await image.boundingBox())!.width;
  const input = await page.context().newCDPSession(page);
  // Browser input protocol generates real touch/pointer events, including capture.
  await input.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: x - 40, y, id: 1 },
      { x: x + 40, y, id: 2 },
    ],
  });
  await input.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: x - 80, y, id: 1 },
      { x: x + 80, y, id: 2 },
    ],
  });
  await expect
    .poll(async () => (await image.boundingBox())!.width)
    .toBeGreaterThan(before * 1.5);
  await input.send('Input.dispatchTouchEvent', {
    type: 'touchCancel',
    touchPoints: [],
  });
  await panel.getByRole('button', { name: 'Actual size', exact: true }).click();
  const left = await view.evaluate((el) => el.scrollLeft);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 60, y, { steps: 5 });
  await page.mouse.up();
  expect(await view.evaluate((el) => el.scrollLeft)).toBeGreaterThan(left + 50);
  await input.detach();
});
