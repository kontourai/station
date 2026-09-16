/** Real provider form and device-preference store; only the unused AWS read is stubbed. */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { build, type OnLoadResult } from 'esbuild';
import { test } from './helpers/fixture-audit';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let script = '';
let stylesheet = '';
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: ROOT,
      loader: 'tsx',
      contents: `
        import { createRoot } from 'react-dom/client';
        import { ConnectionsProvider } from '@kontourai/station-connect';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { ProviderConnectionForm } from './src-ui/src/views/provider-settings/ProviderConnectionForm';
        const noop = () => {};
        const form = { kind: 'model', type: 'anthropic', name: 'Example provider', enabled: true, capabilities: ['llm'], status: 'ready', prerequisites: [], lastCheckedAt: null,
          config: { defaultModel: 'shared', modelOptions: [{ id: 'shared', name: 'Shared model' }, { id: 'custom', name: 'Custom model' }] } };
        // The form reads devicePresentation, which resolves an api base from
        // the connection store and queries it. Both providers are the real
        // ones; the query is left to fail (every request but the document is
        // aborted below), which is the 'server has not answered' state the
        // hook documents and the state this fixture wants.
        createRoot(document.getElementById('root')).render(
          <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <ConnectionsProvider>
              <ProviderConnectionForm form={form} selectedProviderId="example" isNew={false} testResult={null} testError={null} isTesting={false} onSetField={noop} onSetConfigField={noop} onTypeChange={noop} onTestConnection={noop} />
            </ConnectionsProvider>
          </QueryClientProvider>
        );
      `,
    },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    platform: 'browser',
    write: false,
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        /**
         * Shadows ONE SDK export. The first version of this replaced the whole
         * module with that single binding, which is not what the file's first
         * line claims and not what it needs: the form's graph reaches
         * `useDevicePresentation` too, so when that import arrived the bundle
         * stopped building and the spec reported a failure that named no
         * behaviour (#2110). Re-exporting the real module keeps the stub's
         * blast radius equal to its description — a local export outranks a
         * `export *` of the same name, so only the AWS read is replaced and
         * every other SDK binding stays real.
         */
        name: 'unused-provider-query',
        setup(builder) {
          builder.onResolve({ filter: /^@kontourai\/station-sdk$/ }, (args) =>
            // The re-export below resolves the same specifier; without this
            // the stub would resolve to itself.
            args.pluginData?.passthrough
              ? null
              : { path: 'unused-provider-query', namespace: 'fixture' },
          );
          builder.onLoad(
            { filter: /.*/, namespace: 'fixture' },
            async (): Promise<OnLoadResult> => {
              const real = await builder.resolve('@kontourai/station-sdk', {
                resolveDir: ROOT,
                kind: 'import-statement',
                pluginData: { passthrough: true },
              });
              if (real.errors.length > 0) return { errors: real.errors };
              return {
                contents: [
                  `export * from ${JSON.stringify(real.path)};`,
                  'export const useAwsProfilesQuery = () => ({data:undefined,isLoading:false,isError:false});',
                ].join('\n'),
                loader: 'js',
                resolveDir: ROOT,
              };
            },
          );
        },
      },
    ],
  });
  script = result.outputFiles[0].text;
  const styles = await build({
    entryPoints: [join(ROOT, 'src-ui/src/index.css')],
    bundle: true,
    write: false,
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.png': 'dataurl' },
    plugins: [
      {
        name: 'public-assets',
        setup(builder) {
          builder.onResolve({ filter: /^\/(fonts\/|favicon)/ }, (args) => ({
            path: join(ROOT, 'src-ui/public', args.path.slice(1)),
          }));
        },
      },
    ],
  });
  stylesheet = styles.outputFiles[0].text;
});

for (const theme of ['light', 'dark']) {
  test(`bulk visibility remains keyboard reachable at phone width in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    // Everything the fixture needs is inlined, so any other request is the
    // device-presentation query reaching for a connection that does not
    // exist. Aborting keeps this offline and off DNS rather than waiting for
    // a name to fail to resolve. Registered FIRST: Playwright matches the
    // most recently registered route, so the document route below wins.
    await page.route('**/*', (route) => route.abort());
    await page.route('http://station.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root" style="padding:16px"></div></body></html>',
      }),
    );
    await page.goto('http://station.test/');
    await page.addStyleTag({ content: stylesheet });
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.addScriptTag({ content: script });
    await page.evaluate(() => document.fonts.ready);
    const hide = page.getByRole('button', { name: 'Hide all (2)' });
    const show = page.getByRole('button', { name: 'Show all (2)' });
    await hide.scrollIntoViewIfNeeded();
    for (const button of [hide, show]) {
      const box = (await button.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    await hide.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toHaveText('0 of 2 visible');
    await expect(hide).toBeDisabled();
    await show.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toHaveText('2 of 2 visible');
    await expect(show).toBeDisabled();
    await expect(page.getByLabel('Default model', { exact: true })).toHaveValue(
      'shared',
    );
    await page.screenshot({
      path: testInfo.outputPath(`model-visibility-${theme}.png`),
    });
  });
}
