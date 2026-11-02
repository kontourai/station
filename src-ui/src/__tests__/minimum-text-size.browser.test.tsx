import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// The chrome the audit measured under 12px on a Pixel 7 (#4403 A41): the
// dock subtitle ("Codex", 9px), the engine and approval chips (10px), the
// code-block text (10.8px), and a timestamp (11px, which stays: metadata).
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {CodeBlockFrame} from './src-ui/src/components/chat/CodeBlockFrame';
import './src-ui/src/components/badges/EngineChip.css';
import './src-ui/src/components/badges/AttributionChip.css';
createRoot(document.getElementById('root')).render(
  <div className="chat-dock">
    <span className="chat-dock__mobile-eyebrow" data-probe="dock subtitle">Codex</span>
    <span className="engine-chip"><span className="engine-chip__pill" data-probe="engine chip">CODEX</span></span>
    <span className="attribution-chip"><span className="attribution-chip__pill" data-probe="attribution chip">AGENT</span></span>
    <div className="message">
      <CodeBlockFrame lang="ts" code="const probe = 1;" html={null} />
      <span className="message-meta__time" data-probe="timestamp">2m</span>
    </div>
  </div>);
`;

test('#4403: dock and chip labels and code read at 12px or more on a phone; a timestamp may be 11px', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(fixture);
  try {
    await page.addStyleTag({
      content: resolveCssImports(resolve(import.meta.dirname, '../index.css')),
    });
    await page.setViewportSize({ width: 412, height: 915 });
    await page.locator('.code-block-body code').waitFor();
    const sizes = await page.evaluate(() => {
      const size = (element: Element | null) =>
        element ? Number.parseFloat(getComputedStyle(element).fontSize) : NaN;
      const probes = Object.fromEntries(
        [...document.querySelectorAll('[data-probe]')].map((element) => [
          element.getAttribute('data-probe'),
          size(element),
        ]),
      );
      return {
        ...probes,
        'code block': size(document.querySelector('.code-block-body code')),
      };
    });
    for (const label of [
      'dock subtitle',
      'engine chip',
      'attribution chip',
      'code block',
    ])
      expect(sizes[label], label).toBeGreaterThanOrEqual(12);
    expect(sizes.timestamp).toBeGreaterThanOrEqual(11);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
