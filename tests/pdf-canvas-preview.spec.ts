/** A real PDF drawn by the real pdf.js canvas viewer, built by Vite exactly as
 * the app is (bundled module worker, emitted side-file assets, the app's own
 * stylesheet) and served from memory through browser-local routes under the
 * desktop/mobile CSP, Station's UI-server MIME map and `nosniff`. The engine
 * is made to report no PDF viewer, as Android WebView does. No backend,
 * provider, live Station instance, or written output is involved.
 */
import { createRequire } from 'node:module';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build, type Rollup } from 'vite';
import { UI_MIME_TYPES } from '../packages/cli/src/commands/lifecycle';
import { test } from './helpers/fixture-audit';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS_ID = '/virtual/pdf-preview-harness.tsx';
const ORIGIN = 'http://station-pdf-preview.test';
const files = new Map<string, Uint8Array | string>();

/** The app's own CSP, verbatim: no `'unsafe-eval'`, no `data:` fetches. */
const CSP = Object.entries(
  createRequire(import.meta.url)('../src-desktop/tauri.conf.json').app.security
    .csp as Record<string, string>,
)
  .map(([directive, sources]) => `${directive} ${sources}`)
  .join('; ');

/**
 * A small, valid PDF: each page a blue band, a line of Helvetica (drawn with
 * a system font) and a line of Symbol, which pdf.js must load from the
 * bundled standard fonts through the main-thread side-file factory.
 */
function tinyPdf(pageCount: number): string {
  const objects: string[] = [];
  const kids: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>';
  for (let i = 0; i < pageCount; i += 1) {
    const pageId = 5 + i * 2;
    const content = `0.2 0.4 0.8 rg 72 600 300 120 re f BT /F1 36 Tf 0 0 0 rg 72 500 Td (Station page ${i + 1}) Tj ET BT /F2 36 Tf 72 420 Td (abg) Tj ET`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] =
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    kids.push(`${pageId} 0 R`);
  }
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;
  let body = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1)
    body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}

/** A one-page PDF encrypted with a user password (AES-128, made with pypdf). */
const LOCKED_PDF_BASE64 =
  'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPGNhMGJjOWQyYTViZmQzOGYxZWEyYTgxMzY1ODM2NWIyOWEzN2EyYWE5OWI5NDZhZjNiMTk5M2ExYzkyZTdkZGM+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAyMDAgMjAwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViA0Ci9SIDQKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8MGRiNTg1NWZjNTMyNjU2OWU3NjU5MDZjYWY2NGU0NDI5YTRjMjBkNmU5OTZmZGVmOTYzZTliNTA4MGY5ZTA4Mz4KL1UgPGI1YzFlM2U1NjVmZWUzNmM2YzNmYTNkMjkxNjdmNzVjMjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Ci9DRiA8PAovU3RkQ0YgPDwKL0F1dGhFdmVudCAvRG9jT3BlbgovQ0ZNIC9BRVNWMgovTGVuZ3RoIDE2Cj4+Cj4+Ci9TdG1GIC9TdGRDRgovU3RyRiAvU3RkQ0YKPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMTEzIDAwMDAwIG4gCjAwMDAwMDAxNzIgMDAwMDAgbiAKMDAwMDAwMDIyMSAwMDAwMCBuIAowMDAwMDAwMzE1IDAwMDAwIG4gCnRyYWlsZXIKPDwKL1NpemUgNgovUm9vdCAzIDAgUgovSW5mbyAxIDAgUgovSUQgWyA8MzUzOTYzMzIzMDYyNjI2MTY1NjMzODMyNjUzMTYyMzU2MzM2MzM2MzYxNjI2NTY2MzU2MTY2NjE2NTY2MzEzMT4gPDM1Mzk2MzMyMzA2MjYyNjE2NTYzMzgzMjY1MzE2MjM1NjMzNjMzNjM2MTYyNjU2NjM1NjE2NjYxNjU2NjMxMzE+IF0KL0VuY3J5cHQgNSAwIFIKPj4Kc3RhcnR4cmVmCjYyMgolJUVPRgo=';

const harness = `
  import '${ROOT}/src-ui/src/index.css';
  import { createRoot } from 'react-dom/client';
  import { PreviewProvider, usePreview } from '${ROOT}/src-ui/src/contexts/PreviewContext';
  const pdf = ${JSON.stringify(tinyPdf(2))};
  const broken = '%PDF-1.7\\nthis is not a PDF body';
  const asDataUrl = (text) => 'data:application/pdf;base64,' + btoa(text);
  function Open() {
    const { openPreview } = usePreview();
    return <>
      <button onClick={() => openPreview({ url: asDataUrl(pdf), name: 'report.pdf', mediaType: 'application/pdf' })}>Open PDF</button>
      <button onClick={() => openPreview({ url: asDataUrl(broken), name: 'broken.pdf', mediaType: 'application/pdf' })}>Open broken PDF</button>
      <button onClick={() => openPreview({ url: 'data:application/pdf;base64,${LOCKED_PDF_BASE64}', name: 'locked.pdf', mediaType: 'application/pdf' })}>Open locked PDF</button>
    </>;
  }
  createRoot(document.getElementById('root')).render(<PreviewProvider><Open /></PreviewProvider>);
`;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const output = (await build({
    configFile: false,
    root: ROOT,
    logLevel: 'error',
    plugins: [
      tailwindcss(),
      react(),
      {
        name: 'pdf-preview-harness',
        resolveId: (id) => (id === HARNESS_ID ? id : undefined),
        load: (id) => (id === HARNESS_ID ? harness : undefined),
      },
    ],
    define: { 'process.env.NODE_ENV': '"production"' },
    worker: { format: 'es' },
    build: {
      write: false,
      minify: false,
      modulePreload: false,
      rollupOptions: { input: HARNESS_ID },
    },
  })) as Rollup.RollupOutput;
  let entry = '';
  const styles: string[] = [];
  for (const item of output.output) {
    files.set(
      `/${item.fileName}`,
      item.type === 'chunk' ? item.code : item.source,
    );
    if (item.type === 'chunk' && item.isEntry) {
      entry = item.fileName;
      styles.push(...(item.viteMetadata?.importedCss ?? []));
    }
  }
  files.set(
    '/',
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${styles.map((file) => `<link rel="stylesheet" href="/${file}">`).join('')}</head><body><div id="root"></div><script type="module" src="/${entry}"></script></body></html>`,
  );
});

async function mount(page: Page) {
  // Every request — document, chunks, the worker, side-files — is answered
  // here with the headers the app serves them with.
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = files.get(path);
    await route.fulfill({
      status: body === undefined ? 404 : 200,
      headers: {
        'Content-Type':
          path === '/'
            ? 'text/html'
            : UI_MIME_TYPES[extname(path)] || 'application/octet-stream',
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
      },
      body: typeof body === 'string' ? body : Buffer.from(body ?? ''),
    });
  });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    // Missing responses are reported by URL below instead.
    if (
      message.type() === 'error' &&
      !message.text().startsWith('Failed to load resource')
    )
      problems.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    // Station's self-hosted UI fonts live in src-ui/public, which this build
    // does not include; everything the build emits must load.
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400 && !path.startsWith('/fonts/'))
      problems.push(`${response.status()} ${path}`);
  });
  await page.addInitScript(() => {
    // Android WebView's answer.
    Object.defineProperty(Navigator.prototype, 'pdfViewerEnabled', {
      configurable: true,
      get: () => false,
    });
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(
        `CSP violation: ${event.violatedDirective} ${event.blockedURI}`,
      );
    });
  });
  await page.goto(ORIGIN);
  return problems;
}

/**
 * Pixels on a page canvas: `inked` is anything but white paper or
 * transparency (the blue band), `text` is near-black (the Helvetica line,
 * which proves the font path drew, not just a filled path).
 */
function pixels(page: Page, name: string) {
  return page.getByRole('img', { name }).evaluate((canvas) => {
    const element = canvas as HTMLCanvasElement;
    if (!element.width || !element.height) return { inked: 0, text: 0 };
    const { data } = element
      .getContext('2d')!
      .getImageData(0, 0, element.width, element.height);
    let inked = 0;
    let text = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) inked += 1;
      if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80) text += 1;
    }
    return { inked, text };
  });
}

test('draws a real PDF to canvas under the app CSP where the engine has no viewer', async ({
  page,
}) => {
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  const symbolFonts: string[] = [];
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (response.ok() && /^\/assets\/FoxitSymbol-[^/]+\.pfb$/.test(path))
      symbolFonts.push(path);
  });
  const problems = await mount(page);

  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Preview' });
  await expect(dialog.getByText('2 pages')).toBeVisible({ timeout: 20_000 });
  expect(await dialog.locator('iframe').count()).toBe(0);

  await expect
    .poll(async () => (await pixels(page, 'Page 1 of 2')).inked, {
      timeout: 20_000,
    })
    .toBeGreaterThan(1_000);
  expect((await pixels(page, 'Page 1 of 2')).text).toBeGreaterThan(100);
  // Page 2 sits more than a screen below: it is laid out but not drawn.
  const region = dialog.getByRole('region', { name: 'PDF pages' });
  expect((await pixels(page, 'Page 2 of 2')).inked).toBe(0);
  await region.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(async () => (await pixels(page, 'Page 2 of 2')).inked, {
      timeout: 20_000,
    })
    .toBeGreaterThan(1_000);
  await region.evaluate((element) => {
    element.scrollTop = 0;
  });
  // The non-embedded Symbol font came from the bundle, as an emitted asset
  // rather than an inlined data: URL the CSP would refuse.
  expect(symbolFonts).toHaveLength(1);
  // Parsed off the main thread, in the bundled same-origin worker.
  expect(
    workers.some((url) => url.startsWith(`${ORIGIN}/assets/pdf.worker`)),
  ).toBe(true);

  // The page fits the dialog, and zoom widens it.
  const canvas = dialog.getByRole('img', { name: 'Page 1 of 2' });
  const fitted = (await canvas.boundingBox())!.width;
  expect(fitted).toBeLessThanOrEqual((await region.boundingBox())!.width);
  await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(dialog.getByLabel('PDF zoom level')).toHaveText('125%');
  await expect
    .poll(async () => (await canvas.boundingBox())!.width)
    .toBeCloseTo(fitted * 1.25, 0);
  await expect(dialog.getByRole('link', { name: 'Download' })).toBeVisible();

  expect(problems).toEqual([]);
});

test('says the PDF could not be read instead of drawing a blank page', async ({
  page,
}) => {
  await mount(page);

  await page
    .getByRole('button', { name: 'Open broken PDF', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Preview' });
  await expect(dialog.getByText('Preview unavailable')).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    dialog.getByText(
      'Station could not read this PDF. Download it to open it.',
    ),
  ).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Download' })).toBeVisible();
});

test('names a password-protected PDF instead of calling it unreadable', async ({
  page,
}) => {
  await mount(page);

  await page
    .getByRole('button', { name: 'Open locked PDF', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Preview' });
  await expect(dialog.getByText('This PDF is password-protected')).toBeVisible({
    timeout: 20_000,
  });
  await expect(dialog.getByRole('link', { name: 'Download' })).toBeVisible();
});
