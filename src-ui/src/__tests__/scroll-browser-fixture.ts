import { resolve } from 'node:path';
import { type Browser, chromium, type Page } from '@playwright/test';
import { build, type Plugin } from 'esbuild';

const ROOT = resolve(import.meta.dirname, '../../..');

/** Mount production React owners in Chromium without the app's API startup. */
export async function scrollBrowserFixture(
  contents: string,
  plugins: Plugin[] = [],
) {
  const result = await build({
    stdin: { contents, loader: 'tsx', resolveDir: ROOT },
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    write: false,
    outdir: '/virtual',
    alias: {
      '@shared': resolve(ROOT, 'src-shared'),
      '@': resolve(ROOT, 'src-ui/src'),
    },
    define: {
      'process.env.NODE_ENV': '"development"',
      'import.meta.env': '{"MODE":"test"}',
    },
    plugins: [
      {
        name: 'workspace-connect-source',
        setup(builder) {
          builder.onResolve(
            { filter: /^@kontourai\/station-connect$/ },
            () => ({
              path: resolve(ROOT, 'packages/connect/src/index.ts'),
            }),
          );
        },
      },
      ...plugins,
    ],
  });
  const javascript = result.outputFiles.find((file) =>
    file.path.endsWith('.js'),
  )!.text;
  const css =
    result.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '';
  const browser: Browser = await chromium.launch();
  const page: Page = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://station.test/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<div id="root"></div><script type="module" src="/fixture.js"></script>',
      });
    if (path === '/fixture.js')
      return route.fulfill({
        contentType: 'text/javascript',
        body: javascript,
      });
    return route.abort();
  });
  await page.goto('http://station.test/');
  if (css) await page.addStyleTag({ content: css });
  return { browser, page, errors };
}
