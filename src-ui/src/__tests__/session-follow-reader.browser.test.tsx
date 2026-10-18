import { expect, test } from 'vitest';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const sessionFixture = () =>
  scrollBrowserFixture(`
    import React, {useRef, useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {useSessionTranscriptScroll} from './src-ui/src/components/session-detail/useSessionTranscriptScroll';
    function App(){
      const scrollRef = useRef(null), contentRef = useRef(null);
      const [height, setHeight] = useState(2000);
      const {atLatest, jumpToLatest} = useSessionTranscriptScroll({identity:'session',scrollRef,contentRef,ready:true,contentVersion:height});
      return <>{!atLatest && <button onClick={jumpToLatest}>Jump to latest</button>}<button onClick={()=>setHeight(h=>h+100)}>Grow</button><div id="scroll" ref={scrollRef} style={{height:300,overflow:'auto',overflowAnchor:'none'}}><div id="content" ref={contentRef} style={{height}}>Transcript</div></div></>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `);

test('a small upward wheel pauses transcript follow until the reader reaches the true bottom', async () => {
  const { browser, page, errors } = await sessionFixture();
  try {
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1700,
    );
    await page.locator('#scroll').hover();
    await page.mouse.wheel(0, -12);
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1688,
    );
    expect(
      await page.getByRole('button', { name: 'Jump to latest' }).isVisible(),
    ).toBe(true);
    await page.waitForTimeout(250);
    await page.getByRole('button', { name: 'Grow' }).click();
    expect(
      await page.locator('#scroll').evaluate((element) => element.scrollTop),
    ).toBe(1688);
    await page.locator('#scroll').hover();
    await page.mouse.wheel(0, 1000);
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1800,
    );
    await page.waitForTimeout(250);
    await page.getByRole('button', { name: 'Grow' }).click();
    expect(
      await page.locator('#scroll').evaluate((element) => element.scrollTop),
    ).toBe(1900);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('transcript follow survives sustained asynchronous growth between pin echoes', async () => {
  const { browser, page, errors } = await sessionFixture();
  try {
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1700,
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const content = document.querySelector<HTMLElement>('#content')!;
          let ticks = 0;
          const timer = setInterval(() => {
            content.style.height = `${2000 + ++ticks * 20}px`;
            if (ticks === 60) {
              clearInterval(timer);
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              );
            }
          }, 16);
        }),
    );
    const gap = await page
      .locator('#scroll')
      .evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      );
    expect(gap).toBeLessThanOrEqual(2);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test.each(['wheel', 'pointerdown', 'touchstart'])(
  'a %s at the bottom resumes following after the reader grace period',
  async (input) => {
    const { browser, page, errors } = await sessionFixture();
    try {
      await page.waitForFunction(
        () => document.querySelector('#scroll')?.scrollTop === 1700,
      );
      // These inputs do not move a scroller that is already at its lower limit.
      if (input === 'wheel') {
        await page.locator('#scroll').hover();
        await page.mouse.wheel(0, 12);
      } else if (input === 'pointerdown') {
        await page.locator('#scroll').click();
      } else {
        await page.locator('#scroll').dispatchEvent('touchstart');
      }
      await page.waitForTimeout(250);
      await page.getByRole('button', { name: 'Grow' }).click();
      expect(
        await page.locator('#scroll').evaluate((element) => element.scrollTop),
      ).toBe(1800);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  },
);
