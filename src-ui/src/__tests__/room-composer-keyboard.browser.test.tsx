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
    // Past any settle delay the composer waits after the viewport changes.
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (let i = 0; i < 4; i += 1) await frame();
  });

/** A few frames, without waiting for anything to settle. */
const frames = (page: Page) =>
  page.evaluate(async () => {
    for (let i = 0; i < 4; i += 1)
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
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
  // That scroll's own event lands a frame later; let it, before any focus.
  await frames(page);
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

test('with reduced motion, a keyboard that opens in steps (80, 150, 300px) still ends with Send above it (#4810 scroll-cancel delta 1)', async () => {
  const { browser, page, errors } = await open();
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() =>
      document
        .querySelector<HTMLElement>('.content-view')!
        .style.setProperty('--motion-base', '0.01ms'),
    );
    await page.getByRole('textbox', { name: 'Message' }).focus();
    await keyboard(page, 80);
    await frames(page);
    await keyboard(page, 150);
    await frames(page);
    await keyboard(page, 300);
    await settle(page);
    expect(
      await overhang(page),
      'Send below the keyboard (px)',
    ).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('once the reader scrolls, a later keyboard step does not pull the page back (#4810 scroll-cancel delta 2)', async () => {
  const { browser, page, errors } = await open();
  try {
    await page.getByRole('textbox', { name: 'Message' }).focus();
    await keyboard(page, 80);
    await frames(page);
    await wheelUp(page);
    await expect.poll(() => scrollTop(page)).toBeLessThan(250);
    await frames(page);
    const reader = await scrollTop(page);
    await keyboard(page, 300);
    await settle(page);
    expect(await scrollTop(page), 'the reader’s scroll position').toBe(reader);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('focusing the field while the keyboard is already open brings Send above it (#4810 scroll-cancel delta 3)', async () => {
  const { browser, page, errors } = await open();
  try {
    await keyboard(page, 300);
    await settle(page);
    expect(await overhang(page)).toBeGreaterThan(0);
    await page.getByRole('textbox', { name: 'Message' }).focus();
    await settle(page);
    expect(
      await overhang(page),
      'Send below the keyboard (px)',
    ).toBeLessThanOrEqual(0);
    // Checking again moves nothing.
    const placed = await scrollTop(page);
    await keyboard(page, 301);
    await settle(page);
    expect(await overhang(page)).toBeLessThanOrEqual(0);
    expect(await scrollTop(page)).toBeLessThanOrEqual(placed + 1);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

// PageUp in a one-line field pages the document itself: that is the reader
// scrolling, so only caret keys are checked here.
test('arrow keys typed in the field are not the reader scrolling (#4810 scroll-cancel delta)', async () => {
  for (const key of ['ArrowUp', 'ArrowDown']) {
    const { browser, page, errors } = await open();
    try {
      await page.getByRole('textbox', { name: 'Message' }).focus();
      await keyboard(page, 300);
      await page.keyboard.press(key);
      await settle(page);
      expect(
        await overhang(page),
        `${key}: Send below the keyboard (px)`,
      ).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }
});

test('a keyboard that grows after the first correction is followed, since the correction’s own scroll is not the reader’s (#4810 scroll-cancel delta)', async () => {
  const { browser, page, errors } = await open();
  try {
    await page.getByRole('textbox', { name: 'Message' }).focus();
    await keyboard(page, 150);
    await settle(page);
    const first = await scrollTop(page);
    expect(first, 'the first correction scrolled').toBeGreaterThan(300);
    expect(await overhang(page)).toBeLessThanOrEqual(0);
    // A suggestion bar appears: the keyboard grows by 150px.
    await keyboard(page, 300);
    await settle(page);
    expect(
      await overhang(page),
      'Send below the keyboard (px)',
    ).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
