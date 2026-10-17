import { expect, test } from 'vitest';
import { scrollBrowserFixture } from './scroll-browser-fixture';

test('a small upward wheel pauses transcript follow until the reader reaches the true bottom', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(`
    import React, {useRef, useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {useSessionTranscriptScroll} from './src-ui/src/components/session-detail/useSessionTranscriptScroll';
    function App(){
      const scrollRef = useRef(null), contentRef = useRef(null);
      const [height, setHeight] = useState(2000);
      useSessionTranscriptScroll({identity:'session',scrollRef,contentRef,ready:true,contentVersion:height});
      return <><button onClick={()=>setHeight(h=>h+100)}>Grow</button><div id="scroll" ref={scrollRef} style={{height:300,overflow:'auto',overflowAnchor:'none'}}><div ref={contentRef} style={{height}}>Transcript</div></div></>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `);
  try {
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1700,
    );
    await page.locator('#scroll').hover();
    await page.mouse.wheel(0, -12);
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1688,
    );
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
