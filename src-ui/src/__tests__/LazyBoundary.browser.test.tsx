import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const fixture = `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LazyBoundary } from './src-ui/src/components/LazyBoundary';

const stablePromise = Object.freeze(Promise.resolve({
  default: ({ mount }) => <p>Panel mount {mount}</p>,
}));
let calls = 0;
const load = () => {
  calls++;
  document.querySelector('#load-calls').textContent = String(calls);
  return stablePromise;
};

function Harness() {
  const [mount, setMount] = useState(0);
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => { setMount(mount + 1); setOpen(true); }}>Open panel</button>
    <button type="button" onClick={() => setOpen(false)}>Close panel</button>
    <output id="load-calls" aria-label="Loader calls">0</output>
    {open && <LazyBoundary load={load} componentProps={{ mount }} pending={<p>Loading panel</p>} />}
  </>;
}
createRoot(document.getElementById('root')).render(<Harness />);
`;

test('remounts a real lazy surface twice with the same settled loader promise', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(fixture);
  try {
    const open = page.getByRole('button', { name: 'Open panel' });
    const close = page.getByRole('button', { name: 'Close panel' });
    for (const mount of [1, 2]) {
      const panel = page.getByText('Panel mount ' + mount, { exact: true });
      await open.click({ timeout: 3000 });
      await panel.waitFor({ timeout: 3000 });
      expect(await page.locator('#load-calls').textContent()).toBe(
        String(mount),
      );
      await close.click({ timeout: 3000 });
      await panel.waitFor({ state: 'detached', timeout: 3000 });
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

const recoveryFixture = `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LazyBoundary } from './src-ui/src/components/LazyBoundary';

let actionsAvailable = false;
const loadActions = async () => {
  if (!actionsAvailable) throw new Error('fixture: actions unavailable');
  return { default: () => <p>Chat actions opened</p> };
};
const loadInbox = async () => { throw new Error('fixture: inbox unavailable'); };
function Harness() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>Open Chat actions</button>
    <button type="button" onClick={() => { actionsAvailable = true; }}>Restore action chunk</button>
    <LazyBoundary load={loadInbox} componentProps={{}} pending={null}
      surface={{ id: 'mobile-inbox', label: 'Inbox' }} />
    {open && <LazyBoundary load={loadActions} componentProps={{}} pending={null}
      surface={{ id: 'chat-actions', label: 'Chat actions' }} />}
  </>;
}
createRoot(document.getElementById('root')).render(<Harness />);
`;

test('the named Retry recovers Chat actions without retrying a failing sibling', async () => {
  const { browser, page } = await scrollBrowserFixture(recoveryFixture);
  page.setDefaultTimeout(5000);
  try {
    await page.addStyleTag({
      content: resolveCssImports(resolve(import.meta.dirname, '../index.css')),
    });
    await page.getByRole('button', { name: 'Open Chat actions' }).click();
    const failures = page.getByRole('alert');
    await failures.nth(1).waitFor();
    const captureDir = process.env.STATION_LAZY_BOUNDARY_CAPTURE_DIR;
    if (captureDir) {
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const theme of ['light', 'dark']) {
          await page.evaluate(
            (value) =>
              document.documentElement.setAttribute('data-theme', value),
            theme,
          );
          await page.screenshot({
            path: resolve(
              captureDir,
              'failure-' + width + '-' + theme + '.png',
            ),
          });
        }
      }
    }

    const actions = failures.and(
      page.locator('[data-lazy-surface="chat-actions"]'),
    );
    const inbox = failures.and(
      page.locator('[data-lazy-surface="mobile-inbox"]'),
    );
    expect(await actions.textContent({ timeout: 3000 })).toContain(
      'Unable to load Chat actions.',
    );
    expect(await inbox.textContent({ timeout: 3000 })).toContain(
      'Unable to load Inbox.',
    );
    await page.getByRole('button', { name: 'Restore action chunk' }).click();
    expect(await actions.isVisible()).toBe(true);
    await actions.getByRole('button', { name: 'Retry' }).click();
    await page.getByText('Chat actions opened').waitFor({ timeout: 3000 });
    expect(await inbox.isVisible()).toBe(true);
    expect(await actions.count()).toBe(0);
  } finally {
    await browser.close();
  }
});
