/** Real provider form and device-preference store; only the unused AWS read is stubbed. */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { build } from 'esbuild';
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
        import { ProviderConnectionForm } from './src-ui/src/views/provider-settings/ProviderConnectionForm';
        const noop = () => {};
        const form = { kind: 'model', type: 'anthropic', name: 'Example provider', enabled: true, capabilities: ['llm'], status: 'ready', prerequisites: [], lastCheckedAt: null,
          config: { defaultModel: 'shared', modelOptions: [{ id: 'shared', name: 'Shared model' }, { id: 'custom', name: 'Custom model' }] } };
        createRoot(document.getElementById('root')).render(<ProviderConnectionForm form={form} selectedProviderId="example" isNew={false} testResult={null} testError={null} isTesting={false} onSetField={noop} onSetConfigField={noop} onTypeChange={noop} onTestConnection={noop} />);
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
        name: 'unused-provider-query',
        setup(builder) {
          builder.onResolve({ filter: /^@kontourai\/station-sdk$/ }, () => ({
            path: 'unused-provider-query',
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents:
              'export const useAwsProfilesQuery = () => ({data:undefined,isLoading:false,isError:false});',
            loader: 'js',
          }));
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
