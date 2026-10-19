import { expect, test } from 'vitest';
import { scrollBrowserFixture } from './scroll-browser-fixture';

test('native virtualizer positioning echoes are identified before the scroll listener runs', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(`
    import React, {useRef,useState,useCallback} from 'react';
    import {createRoot} from 'react-dom/client';
    import {TranscriptVirtualizer} from './src-ui/src/components/chat/TranscriptVirtualizer';
    window.echoes={tagged:0,untagged:0};
    function App(){
      const ref=useRef(null), lastWrite=useRef(null);
      const [version,setVersion]=useState(0);
      const [reveal,setReveal]=useState(undefined);
      const [rows,setRows]=useState(Array.from({length:100},(_,i)=>({id:'row-'+i,kind:'message:user'})));
      const note=useCallback(el=>{lastWrite.current=el.scrollTop},[]);
      return <><button onClick={()=>setReveal("row-50")}>Reveal</button><button onClick={()=>setRows(old=>[...Array.from({length:40},(_,i)=>({id:'earlier-'+i,kind:'message:user'})),...old])}>Earlier</button>
      <div id="scroll" ref={ref} style={{height:300,overflow:'auto',overflowAnchor:'none'}} onScroll={event=>{
        if(Math.abs(event.currentTarget.scrollTop-lastWrite.current)<=1){window.echoes.tagged++;return;}
        window.echoes.untagged++;setVersion(v=>v+1);
      }}><TranscriptVirtualizer rows={rows} scrollElement={ref} onProgrammaticScroll={note} anchorVersion={version} revealRowId={reveal} renderRow={row=><article style={{height:88}}>{row.id}</article>}/></div></>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `);
  try {
    await page.getByRole('button', { name: 'Reveal', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('#scroll')!.scrollTop > 3000,
    );
    await page.getByRole('button', { name: 'Earlier', exact: true }).click();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let frames = 24;
          const tick = () =>
            --frames ? requestAnimationFrame(tick) : resolve();
          requestAnimationFrame(tick);
        }),
    );
    const echoes = (await page.evaluate('window.echoes')) as {
      tagged: number;
      untagged: number;
    };
    expect(echoes.tagged).toBeGreaterThan(0);
    expect(echoes.untagged).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
