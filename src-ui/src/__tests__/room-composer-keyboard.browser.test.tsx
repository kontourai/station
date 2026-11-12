import type { Page } from '@playwright/test';
import { expect, test } from 'vitest';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// The production RoomComposer at 390px in a scrolling page, under an emulated
// software keyboard (`window.visualViewport` replaced, as
// tests/helpers/keyboard-emulation.ts does for the gallery). The composer
// lifts itself over the keyboard and, once per focus or keyboard opening,
// scrolls back into view; the reader's own scrolling always wins (#4810
// keyboard delta).
const fixture = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {RoomComposer} from './src-ui/src/components/room/RoomComposer';
const target = new EventTarget();
let keyboard = 0;
const viewport = new Proxy(target, {
  get(object, property) {
    if (property === 'height') return window.innerHeight - keyboard;
    if (property === 'width') return window.innerWidth;
    if (['offsetTop', 'offsetLeft', 'pageTop', 'pageLeft'].includes(property)) return 0;
    if (property === 'scale') return 1;
    const value = Reflect.get(object, property, object);
    return typeof value === 'function' ? value.bind(object) : value;
  },
});
Object.defineProperty(window, 'visualViewport', {configurable: true, get: () => viewport});
window.__keyboard = (height) => {
  keyboard = height;
  target.dispatchEvent(new Event('resize'));
};
document.body.style.margin = '0';
function Page() {
  const [value, setValue] = useState('');
  return (
    <div className="content-view" style={{height: '100vh', overflowY: 'auto', '--motion-base': '400ms', '--k-ease': 'linear'}}>
      <div style={{height: 700}}>Project header</div>
      <section style={{display: 'flex', flexDirection: 'column', minHeight: 400}}>
        <div style={{height: 132, flex: 'none'}}>Messages</div>
        <RoomComposer id="c" label="Message" placeholder="Message" value={value}
          onValueChange={(next) => setValue(next)} onSend={() => {}} canSend={!!value} sendLabel="Send" />
      </section>
      <div style={{height: 300}}>After the room</div>
    </div>);
}
createRoot(document.getElementById('root')).render(<Page />);
`;

const scrollTop = (page: Page) =>
  page.evaluate(() => document.querySelector('.content-view')!.scrollTop);

/** Open (or resize) the emulated keyboard. */
const keyboard = (page: Page, height: number) =>
  page.evaluate(
    (value) =>
      (window as unknown as { __keyboard(height: number): void }).__keyboard(
        value,
      ),
    height,
  );

/**
 * Every transition has ended and a few frames have passed after it. The
 * viewport store reads on the next frame and React renders after it, so the
 * lift's transition starts a frame or two after the keyboard event.
 */
const settle = (page: Page) =>
  page.evaluate(async () => {
    const frame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    for (let i = 0; i < 3; i += 1) await frame();
    while (
      document
        .getAnimations()
        .some((animation) => animation.playState === 'running')
    )
      await frame();
    for (let i = 0; i < 4; i += 1) await frame();
  });

/** How far the composer's bottom sits below the visible viewport. */
const overhang = (page: Page) =>
  page.evaluate(
    () =>
      document.querySelector('.room-composer')!.getBoundingClientRect().bottom -
      (window.visualViewport!.offsetTop + window.visualViewport!.height),
  );

async function wheelUp(page: Page) {
  await page.mouse.move(195, 200);
  await page.mouse.wheel(0, -100);
}

async function open() {
  const fixtureRun = await scrollBrowserFixture(fixture);
  const { page } = fixtureRun;
  await page.getByRole('textbox', { name: 'Message' }).waitFor();
  expect(await page.evaluate(() => window.innerWidth)).toBe(390);
  // The composer is in view before the keyboard opens.
  await page.evaluate(() => {
    document.querySelector('.content-view')!.scrollTop = 300;
  });
  expect(await overhang(page)).toBeLessThanOrEqual(0);
  return fixtureRun;
}

test('after the keyboard lift, the reader scrolls away and a 1px viewport change does not pull the page back (#4810 keyboard delta)', async () => {
  const { browser, page, errors } = await open();
  try {
    const field = page.getByRole('textbox', { name: 'Message' });
    await field.focus();
    await keyboard(page, 300);
    await settle(page);
    // The one correction for this keyboard opening ran.
    expect(await overhang(page)).toBeLessThanOrEqual(0);
    const corrected = await scrollTop(page);
    expect(corrected).toBeGreaterThan(300);

    await wheelUp(page);
    await expect.poll(() => scrollTop(page)).toBeLessThan(corrected - 50);
    await settle(page);
    const reader = await scrollTop(page);

    await keyboard(page, 301);
    await settle(page);
    expect(await scrollTop(page), 'the reader’s scroll position').toBe(reader);

    // A genuine new opening re-arms it: the keyboard closes, the field is
    // left and focused again, and the keyboard opens.
    await keyboard(page, 0);
    await settle(page);
    await field.blur();
    await field.focus();
    await keyboard(page, 300);
    await settle(page);
    expect(await overhang(page)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a scroll during the keyboard lift cancels the pending correction (#4810 keyboard delta)', async () => {
  const { browser, page, errors } = await open();
  try {
    await page.getByRole('textbox', { name: 'Message' }).focus();
    await keyboard(page, 300);
    // The lift animates for 400ms here; the reader scrolls up within it.
    await wheelUp(page);
    await settle(page);
    expect(
      await scrollTop(page),
      'the reader’s scroll position',
    ).toBeLessThanOrEqual(210);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
