/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkspacePaneInstanceId } from '@kontourai/station-contracts/workspace-pane';
import { chromium } from '@playwright/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../tests/helpers/css-cascade-fixture';
import { WorkspacePaneFrame } from '../WorkspacePaneFrame';

/**
 * The Coding lower panel draws its Terminal inside the real
 * `WorkspacePaneFrame` (`ProjectLayoutRenderer`'s `terminal.render`). With
 * the app's cascade, the terminal under the frame fills the panel body; a
 * block frame held content height and the terminal collapsed to a 16px strip
 * at 1440 (visual review of 4249bb5f5d). The terminal's own chain repeats
 * `CodingTerminalPane` and `TerminalPanel`'s classes as static markup.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../');
const SHEETS = [
  resolve(HERE, '../../components/coding-layout/CodingWorkbench.css'),
  resolve(HERE, '../../components/coding-layout/CodingLayout.css'),
  resolve(HERE, '../WorkspacePaneFrame.css'),
  resolve(REPO_ROOT, 'packages/sdk/src/terminal-view/TerminalView.css'),
];
const LOWER_HEIGHT = 280;

function lowerPanelMarkup() {
  const frame = renderToStaticMarkup(
    <WorkspacePaneFrame
      instanceId={'terminal-1' as WorkspacePaneInstanceId}
      paneName="Terminal"
      onRetry={() => true}
    >
      <section className="coding-layout__terminal coding-layout__terminal--pane">
        <div className="coding-layout__terminal-body">
          <div style={{ display: 'contents' }}>
            <div className="coding-terminal-shell">
              <div className="coding-terminal">
                <div className="station-terminal" />
              </div>
            </div>
          </div>
        </div>
      </section>
    </WorkspacePaneFrame>,
  );
  return `<section class="coding-workbench__lower" data-active="true" aria-label="Terminal" style="--coding-lower-height:${LOWER_HEIGHT}px">
  <header class="coding-workbench__panel-head"><h2 class="coding-workbench__panel-title">Terminal</h2></header>
  <div class="coding-workbench__panel-body">${frame}</div>
</section>`;
}

describe.skipIf(!chromiumIsInstalled(REPO_ROOT))(
  'WorkspacePaneFrame passes a flex panel’s height to its pane (real cascade)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });

    test('the Coding terminal fills the lower panel body at 1440', async () => {
      const css = [
        resolveCssImports(resolve(HERE, '../../index.css')),
        ...SHEETS.map((path) => readFileSync(path, 'utf8')),
      ].join('\n');
      assertNoImportsSurvive(css);
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      try {
        await page.setContent(`<!doctype html>
<html>
  <head><style>${css} html,body{height:100%;margin:0}
  .host{display:flex;flex-direction:column;height:900px}</style></head>
  <body><div class="host"><div style="flex:1"></div>${lowerPanelMarkup()}</div></body>
</html>`);
        const g = await page.evaluate(() => {
          const h = (selector: string) =>
            document.querySelector(selector)!.getBoundingClientRect().height;
          return {
            lower: h('.coding-workbench__lower'),
            body: h('.coding-workbench__panel-body'),
            frame: h('section[data-workspace-pane-lifecycle]'),
            terminal: h('.station-terminal'),
          };
        });
        // The panel holds its height, and the frame and the terminal take
        // all of the body under the head.
        expect(g.lower).toBe(LOWER_HEIGHT);
        expect(g.body).toBeGreaterThan(200);
        expect(g.frame).toBe(g.body);
        expect(g.terminal).toBe(g.body);
      } finally {
        await page.close();
      }
    });
  },
);
