import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// Mirrors the tool server page's composition: a bounded tab panel holding the
// real split pane and the Secret bindings section after it. The section's
// content is taller than the panel, as the real form is.
const fixture = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {NavigationProvider} from './src-ui/src/contexts/NavigationContext';
  import {SplitPaneLayout} from './src-ui/src/components/SplitPaneLayout';
  function App() {
    window.saves = 0;
    return <NavigationProvider>
      <div id="frame" style={{display:'flex',flexDirection:'column',height:'calc(100vh - 220px)'}}>
        <div className="tab-panel">
          <div className="integration-editor-stack">
            <SplitPaneLayout label="connections / tools" title="Tool servers"
              items={[{id:'docs',name:'Station Docs'}]} selectedId="docs"
              onSelect={()=>{}} onSearch={()=>{}} emptyDescription="Select one">
              <div className="editor-layout">
                <button type="button" onClick={()=>window.saves++}>Save</button>
              </div>
            </SplitPaneLayout>
            <section className="agent-editor__section">
              <details className="editor__expandable">
                <summary className="editor__expandable-header">Advanced: Secret bindings</summary>
                <div className="editor__expandable-content" style={{height:900}}>Form</div>
              </details>
            </section>
          </div>
        </div>
      </div>
    </NavigationProvider>;
  }
  createRoot(document.getElementById('root')).render(<App/>);
`;

test('opening Secret bindings keeps the editor visible and its buttons clickable', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(fixture);
  try {
    await page.addStyleTag({
      content: [
        '../index.css',
        '../components/SplitPaneLayout.css',
        '../views/page-layout.css',
        '../views/editor-layout.css',
        '../views/IntegrationsView.css',
      ]
        .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
        .join('\n'),
    });
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      const save = page.getByRole('button', { name: 'Save', exact: true });
      await save.waitFor();
      await page.getByText('Advanced: Secret bindings').click();
      const pane = await page.locator('.split-pane').boundingBox();
      expect(pane!.height, `${width}px editor height`).toBeGreaterThan(300);
      const section = await page.locator('.editor__expandable').boundingBox();
      expect(
        section!.y,
        `${width}px section starts below the editor`,
      ).toBeGreaterThanOrEqual(pane!.y + pane!.height - 1);
      const before = await page.evaluate(
        () => (window as unknown as { saves: number }).saves,
      );
      await save.click({ timeout: 3000 });
      expect(
        await page.evaluate(
          () => (window as unknown as { saves: number }).saves,
        ),
        `${width}px Save click reached the button`,
      ).toBe(before + 1);
      await page.getByText('Advanced: Secret bindings').click();
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
