import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// The real SectionNav with its own `page-layout.css` (bundled through the
// component's import) plus the app tokens, so `--motion-fast` resolves and any
// transition on `.page__tab` actually runs.
const fixture = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SectionNav} from './src-ui/src/components/SectionNav';
const items = [['workspace','Workspace'],['basic-info','Basic info'],['danger','Danger zone']]
  .map(([key,label]) => ({key, label, href: '?section=' + key}));
function Host() {
  const [active, setActive] = useState('danger');
  return <SectionNav aria-label="Sections" items={items} activeKey={active} onNavigate={setActive} />;
}
createRoot(document.getElementById('root')).render(<Host/>);
`;

test('a section tab that loses selection shows no active fill in the frame it loses it', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(fixture);
  try {
    await page.addStyleTag({
      content: resolveCssImports(resolve(import.meta.dirname, '../index.css')),
    });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      );
      const nav = page.getByRole('navigation', { name: 'Sections' });
      await nav.getByRole('link', { name: 'Danger zone' }).click();
      await page.mouse.move(0, 0);
      await page.evaluate(() =>
        Promise.all(document.getAnimations().map((a) => a.finished)),
      );
      expect(
        await nav
          .getByRole('link', { name: 'Danger zone' })
          .getAttribute('aria-current'),
      ).toBe('location');

      // Switch and read before the next frame: React commits a discrete click
      // in a microtask, so the first read after `aria-current` flips is the
      // style the next frame paints.
      const after = await page.evaluate(async () => {
        const link = (name: string) =>
          [...document.querySelectorAll('nav a')].find(
            (a) => a.textContent === name,
          ) as HTMLElement;
        const read = (el: HTMLElement) => {
          const style = getComputedStyle(el);
          return { background: style.backgroundColor, color: style.color };
        };
        link('Workspace').click();
        for (
          let turn = 0;
          turn < 20 && link('Danger zone').hasAttribute('aria-current');
          turn += 1
        )
          await Promise.resolve();
        const sameFrame = {
          current: link('Danger zone').getAttribute('aria-current'),
          ...read(link('Danger zone')),
        };
        await new Promise((r) => requestAnimationFrame(r));
        return {
          sameFrame,
          nextFrame: read(link('Danger zone')),
          neverSelected: read(link('Basic info')),
        };
      });
      expect(after.sameFrame.current).toBeNull();
      expect(after.sameFrame).toMatchObject(after.neverSelected);
      expect(after.nextFrame).toEqual(after.neverSelected);
      expect(after.neverSelected.background).toBe('rgba(0, 0, 0, 0)');
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
