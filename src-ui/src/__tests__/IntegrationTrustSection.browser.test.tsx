import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

test('trust controls fit and remain usable in both themes and widths', async () => {
  const fixture = `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {IntegrationTrustSection} from './src-ui/src/views/integrations/IntegrationTrustSection';
    function App() {
      const [form,setForm] = useState({id:'mail',kind:'mcp',contentTrust:'untrusted',trustReadOnlyHints:false,
        untrustedContentPermissions:{default:'ask',tools:{send_reply:'deny'}},
        probe:{ok:true,toolCount:2,checkedAt:'2026-01-01T00:00:00Z',tools:[{name:'read_message'},{name:'send_reply'}]},
        untrustedContentChanges:[{at:'2026-01-01T00:00:00Z',by:'person',contentTrust:'untrusted'}]});
      return <main style={{maxWidth:720,margin:'0 auto',padding:16}}><IntegrationTrustSection form={form} locked={false} onUpdate={setForm}/></main>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `;
  const { browser, page, errors } = await scrollBrowserFixture(fixture);
  try {
    await page.addStyleTag({
      content: [
        '../index.css',
        '../components/editor-controls.css',
        '../views/page-layout.css',
        '../views/PluginManagementView.css',
        '../views/editor-layout.css',
        '../views/IntegrationsView.css',
      ]
        .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
        .join('\n'),
    });
    const output = resolve('.kontourai/pr4280-trust-settings');
    mkdirSync(output, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      );
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.getByText('Change history (1)').click();
        await page.getByText('person').waitFor();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        expect(
          await page
            .getByLabel('send_reply after untrusted content')
            .inputValue(),
        ).toBe('deny');
        await page.screenshot({
          path: `${output}/${width}-${theme}.png`,
          fullPage: true,
        });
        await page.getByText('Change history (1)').click();
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
