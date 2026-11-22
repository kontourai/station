import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// Mirrors the tool server page's composition: the real split pane and a
// Secret bindings section after it, inside the stack the view renders. A
// bounded host stands in for the Connections tab panel; an unbounded one for
// the agent editor's tool setup. The editor content is taller than any panel.
const fixture = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {NavigationProvider} from './src-ui/src/contexts/NavigationContext';
  import {SplitPaneLayout} from './src-ui/src/components/SplitPaneLayout';
  let root;
  window.mount = ({panelHeight, selected}) => {
    root?.unmount();
    window.saves = 0;
    const stack = <div className="integration-editor-stack">
      <SplitPaneLayout label="connections / tools" title="Tool servers"
        items={[{id:'docs',name:'Station Docs'}]} selectedId={selected ? 'docs' : null}
        onSelect={()=>{}} onSearch={()=>{}} emptyDescription="Select one">
        <div className="editor-layout" style={{height:1200}}>
          <button type="button" onClick={()=>window.saves++}>Save</button>
        </div>
      </SplitPaneLayout>
      <section className="agent-editor__section">
        <details className="editor__expandable">
          <summary className="editor__expandable-header">Advanced: Secret bindings</summary>
          <div className="editor__expandable-content" style={{height:900}}>Form</div>
        </details>
      </section>
    </div>;
    root = createRoot(document.getElementById('root'));
    root.render(<NavigationProvider>{panelHeight
      ? <div style={{display:'flex',flexDirection:'column',height:panelHeight}}><div className="tab-panel">{stack}</div></div>
      : <div className="agent-tool-picker__setup">{stack}</div>}</NavigationProvider>);
  };
`;

async function mount(
  page: Page,
  options: { panelHeight?: number; selected: boolean },
) {
  await page.evaluate(
    (value) =>
      (window as unknown as { mount: (v: unknown) => void }).mount(value),
    options,
  );
  await page.locator('.editor__expandable').waitFor();
}

const heights = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) =>
      document.querySelector(selector)!.getBoundingClientRect();
    const stack = document.querySelector('.integration-editor-stack')!;
    return {
      pane: box('.integration-editor-stack > .split-pane').height,
      paneBottom: box('.integration-editor-stack > .split-pane').bottom,
      sectionTop: box('.editor__expandable').top,
      columnOverflow: stack.scrollHeight - stack.clientHeight,
      columnHeight: stack.clientHeight,
    };
  });

test('the Secret bindings section opens below the editor without covering it', async () => {
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
    await page.setViewportSize({ width: 1440, height: 900 });

    // Tall panel, server selected: the pane stays usable, the section follows
    // it, and Save still receives the click.
    await mount(page, { panelHeight: 700, selected: true });
    await page.getByText('Advanced: Secret bindings').click();
    let measured = await heights(page);
    expect(measured.pane).toBeGreaterThan(300);
    expect(measured.sectionTop).toBeGreaterThanOrEqual(measured.paneBottom - 1);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    expect(
      await page.evaluate(() => (window as unknown as { saves: number }).saves),
    ).toBe(1);

    // Short panel, closed: nothing forces the column to scroll.
    await mount(page, { panelHeight: 400, selected: true });
    measured = await heights(page);
    expect(measured.columnOverflow).toBeLessThanOrEqual(1);

    // Short panel, open: the pane never outgrows the panel.
    await page.getByText('Advanced: Secret bindings').click();
    measured = await heights(page);
    expect(measured.pane).toBeGreaterThan(300);
    expect(measured.pane).toBeLessThanOrEqual(measured.columnHeight + 1);

    // The agent editor hosts the same view in block flow: its height is the
    // content's, open or closed.
    await mount(page, { selected: true });
    expect((await heights(page)).pane).toBeGreaterThan(1000);
    await page.getByText('Advanced: Secret bindings').click();
    expect((await heights(page)).pane).toBeGreaterThan(1000);

    // Phone, no server selected (a selected server's sheet covers the section
    // there): the list pane and the section do not overlap.
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(page, { panelHeight: 600, selected: false });
    await page.getByText('Advanced: Secret bindings').click();
    measured = await heights(page);
    expect(measured.pane).toBeGreaterThan(300);
    expect(measured.sectionTop).toBeGreaterThanOrEqual(measured.paneBottom - 1);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
