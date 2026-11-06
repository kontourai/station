import type { Page } from '@playwright/test';
import { expect, test } from 'vitest';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// This fixture controls the replacement's delivery, not history delivery:
// every wrapped Back calls Chromium immediately, before mounting the reader.
const fixture = `
import React, {StrictMode, useRef, useState} from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {ResponsiveDialogSurface} from './src-ui/src/components/ResponsiveDialogSurface';
import {DialogHistoryHostBoundary} from './src-ui/src/components/DialogHistoryHost';
history.replaceState({}, '', '/earlier');
history.pushState({}, '', '/inventory');
const handoff = window.handoff = {backs: 0, pops: 0, replacementAt: 1,
  synthetic: false, afterOpen: null, stackedReader: false, openedAtPops: null,
  replacementMarker: null};
const nativeBack = history.back.bind(history);
history.back = () => {
  handoff.backs += 1;
  nativeBack();
  if (handoff.backs === handoff.replacementAt) {
    flushSync(() => handoff.openReader());
    handoff.openedAtPops = handoff.pops;
    handoff.replacementMarker = history.state?.__stationDialog ?? null;
    if (handoff.afterOpen === 'unmount') flushSync(() => handoff.closeReader());
    if (handoff.afterOpen === 'remove-host') flushSync(() => handoff.removeHost());
    if (handoff.afterOpen === 'navigate') {
      history.replaceState({...history.state}, '', '/changed');
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
    if (handoff.synthetic) window.dispatchEvent(new PopStateEvent('popstate'));
  }
};
window.addEventListener('popstate', event => { if (event.isTrusted) handoff.pops += 1; });
function App() {
  const [step, setStep] = useState('closed');
  const [outer, setOuter] = useState(false);
  const [details, setDetails] = useState(false);
  const [closes, setCloses] = useState(0);
  const trigger = useRef(null);
  handoff.openReader = () => {setStep('reader'); setDetails(handoff.stackedReader);};
  handoff.closeReader = () => setStep('closed');
  return <>
    <button ref={trigger} onClick={() => setStep('actions')}>Actions</button>
    <button onClick={() => {setOuter(true); setStep('actions');}}>Stacked actions</button>
    <output id="closes">{closes}</output>
    {outer && <ResponsiveDialogSurface key="older" ariaLabel="Older dialog"
      layer="dialog" onClose={() => setOuter(false)}><p>Older content</p></ResponsiveDialogSurface>}
    {step === 'actions' && <ResponsiveDialogSurface key="actions" ariaLabel="Actions"
      layer="popover" onClose={() => setStep('closed')}>
      <button onClick={() => setOuter(false)}>Discard older dialog</button>
      <button onClick={() => setStep('closed')}>Show inventory</button>
    </ResponsiveDialogSurface>}
    {step === 'reader' && <ResponsiveDialogSurface key="reader" ariaLabel="Chat inventory"
      layer="dialog" returnFocusTarget={trigger.current}
      onClose={() => {setCloses(n => n + 1); setStep('closed');}}>
      <p>Inventory body</p>
    </ResponsiveDialogSurface>}
    {details && <ResponsiveDialogSurface key="details" ariaLabel="Inventory details"
      layer="dialog" onClose={() => setDetails(false)}><p>Details body</p></ResponsiveDialogSurface>}
  </>;
}
function Outlet() {
  const [shown, setShown] = useState(true);
  handoff.removeHost = () => setShown(false);
  return shown ? <DialogHistoryHostBoundary><App/></DialogHistoryHostBoundary> : <p>Host removed</p>;
}
createRoot(document.getElementById('root')).render(
  <StrictMode><Outlet/></StrictMode>);
`;

interface Handoff {
  backs: number;
  pops: number;
  replacementAt: number;
  synthetic: boolean;
  afterOpen: 'unmount' | 'remove-host' | 'navigate' | null;
  stackedReader: boolean;
  openedAtPops: number | null;
  replacementMarker: string | null;
}

async function readHandoff(page: Page) {
  return page.evaluate(() => {
    const { backs, pops, openedAtPops, replacementMarker } = (
      window as unknown as { handoff: Handoff }
    ).handoff;
    return {
      backs,
      pops,
      openedAtPops,
      replacementMarker,
      marker: history.state?.__stationDialog ?? null,
      pathname: location.pathname,
    };
  });
}

test.each([
  { older: false, synthetic: false, pops: 1 },
  { older: true, synthetic: false, pops: 2 },
  { older: true, synthetic: true, pops: 2 },
])(
  'a replacement survives native cleanup (older=$older, synthetic=$synthetic)',
  async ({ older, synthetic, pops }) => {
    const { browser, page, errors } = await scrollBrowserFixture(fixture);
    try {
      await page.evaluate(
        ({ replacementAt, synthetic }) => {
          Object.assign((window as unknown as { handoff: Handoff }).handoff, {
            replacementAt,
            synthetic,
          });
        },
        { replacementAt: pops, synthetic },
      );
      await page
        .getByRole('button', {
          name: older ? 'Stacked actions' : 'Actions',
          exact: true,
        })
        .click();
      await page
        .getByRole('dialog', { name: 'Actions', exact: true })
        .waitFor();
      if (older) {
        await page
          .getByRole('button', { name: 'Discard older dialog' })
          .click();
        await page
          .getByRole('dialog', { name: 'Older dialog' })
          .waitFor({ state: 'detached' });
      }
      await page.getByRole('button', { name: 'Show inventory' }).click();
      await page.waitForFunction(
        (count) =>
          (window as unknown as { handoff: Handoff }).handoff.pops >= count,
        pops,
      );
      await page.getByRole('dialog', { name: 'Chat inventory' }).waitFor();
      const landed = await readHandoff(page);
      expect(landed.openedAtPops).toBe(pops - 1);
      expect(landed.backs).toBe(pops);
      expect(landed.pops).toBe(pops);
      expect(landed.pathname).toBe('/inventory');
      expect(landed.marker).toBeTruthy();
      expect(await page.locator('#closes').textContent()).toBe('0');

      await page.evaluate(() => history.back());
      await page
        .getByRole('dialog', { name: 'Chat inventory' })
        .waitFor({ state: 'detached' });
      expect(await page.locator('#closes').textContent()).toBe('1');
      expect((await readHandoff(page)).pathname).toBe('/inventory');
      await page.waitForFunction(
        () => document.activeElement?.textContent === 'Actions',
      );
      await page.evaluate(() => history.back());
      await page.waitForURL('http://station.test/earlier');
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  },
);

test.each(['unmount', 'remove-host', 'navigate'] as const)(
  'an unpublished replacement stays inert after %s',
  async (afterOpen) => {
    const { browser, page, errors } = await scrollBrowserFixture(fixture);
    try {
      await page.evaluate((value) => {
        (window as unknown as { handoff: Handoff }).handoff.afterOpen = value;
      }, afterOpen);
      await page.getByRole('button', { name: 'Actions', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Actions', exact: true })
        .waitFor();
      await page.getByRole('button', { name: 'Show inventory' }).click();
      await page.waitForFunction(
        () => (window as unknown as { handoff: Handoff }).handoff.pops === 1,
      );
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      expect(await readHandoff(page)).toMatchObject({
        backs: 1,
        pops: 1,
        pathname: '/inventory',
        marker: null,
      });
      if (afterOpen === 'navigate') {
        expect(await page.locator('#closes').textContent()).toBe('1');
      }
      await page.evaluate(() => history.back());
      await page.waitForURL('http://station.test/earlier');
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  },
);

test('live replacements publish in order after cleanup and Back closes each once', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(fixture);
  try {
    await page.evaluate(() => {
      (window as unknown as { handoff: Handoff }).handoff.stackedReader = true;
    });
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('button', { name: 'Show inventory' }).click();
    await page.waitForFunction(
      () => (window as unknown as { handoff: Handoff }).handoff.pops === 1,
    );
    await page
      .getByRole('dialog', { name: 'Inventory details', exact: true })
      .waitFor();
    await page.evaluate(() => history.back());
    await page
      .getByRole('dialog', { name: 'Inventory details', exact: true })
      .waitFor({ state: 'detached' });
    expect(
      await page
        .getByRole('dialog', { name: 'Chat inventory', exact: true })
        .count(),
    ).toBe(1);
    expect((await readHandoff(page)).pathname).toBe('/inventory');
    await page.evaluate(() => history.back());
    await page
      .getByRole('dialog', { name: 'Chat inventory', exact: true })
      .waitFor({ state: 'detached' });
    expect(await page.locator('#closes').textContent()).toBe('1');
    expect((await readHandoff(page)).pathname).toBe('/inventory');
    await page.evaluate(() => history.back());
    await page.waitForURL('http://station.test/earlier');
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
