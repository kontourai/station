import { createSocket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium, webkit } from 'playwright-core';
import { expect, test } from 'vitest';
import { createMcpUiFrameApp } from '../mcp-ui-frame-server.js';

for (const [engine, browserType] of Object.entries({ chromium, webkit })) {
  test(`${engine}: shared MCP and HTML sandboxes block direct RTC but record the nested-srcdoc residual with a UDP listener`, async (ctx) => {
    if (engine === 'webkit' && !existsSync(browserType.executablePath())) {
      const reason = `WebKit executable is not installed at ${browserType.executablePath()}; residual verification is local-only when CI installs Chromium alone`;
      process.stdout.write(`SKIP webkit: ${reason}\n`);
      return ctx.skip(reason);
    }
    const udp = createSocket('udp4');
    await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve));
    let packets = 0;
    udp.on('message', () => packets++);
    const port = udp.address().port;
    const browser = await browserType.launch({ headless: true });
    const server = createServer(async (req, res) => {
      if (req.url === '/parent') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<body></body>');
        return;
      }
      const frameApp = createMcpUiFrameApp({
        frameAncestors: [`http://${req.headers.host}`],
      });
      const response = await frameApp.request(`http://sandbox.test${req.url}`);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No HTTP listener');
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/parent`);
      const attack = `<script>(()=>{const results=[];const attempt=(realm,label)=>{try{const PC=realm.RTCPeerConnection||realm.webkitRTCPeerConnection;const pc=new PC({iceServers:[{urls:'stun:127.0.0.1:${port}'}]});pc.createDataChannel('probe');pc.createOffer().then(o=>pc.setLocalDescription(o));results.push(label+' OPEN')}catch{results.push(label+' blocked')}};attempt(window,'direct');try{Object.defineProperty(window,'RTCPeerConnection',{value:parent.RTCPeerConnection})}catch{};const child=document.createElement('iframe');child.src='about:blank';document.body.append(child);try{attempt(child.contentWindow,'child')}catch{results.push('child blocked')}try{attempt(window[0],'indexed child')}catch{results.push('indexed child blocked')}document.body.dataset.rtcResults=JSON.stringify(results); })()</script>`;
      await page.evaluate(`(()=>{
        document.body.dataset.links='0';
        addEventListener('message',event=>{if(event.data?.type==='html-reply-link')document.body.dataset.links=String(Number(document.body.dataset.links)+1)});
      })()`);
      for (const path of ['/html-reply/frame', '/mcp-ui/proxy']) {
        const payload = {
          origin: `http://127.0.0.1:${address.port}`,
          path,
          html: `${attack}<a href="https://example.com/">Continue</a><script>for(let i=0;i<6;i++)parent.postMessage({type:'html-reply-link',url:'https://example.com/'},'*')</script>`,
        };
        await page.evaluate(`(()=>{
          const {origin,path,html}=${JSON.stringify(payload)};
          document.body.replaceChildren();
          const frame=document.createElement('iframe');frame.src=origin+path;
          frame.onload=()=>frame.contentWindow.postMessage(path.startsWith('/html')?{type:'html-reply-load',html}:{jsonrpc:'2.0',method:'ui/notifications/sandbox-resource-ready',params:{html}},origin);
          document.body.append(frame);
        })()`);
        await expect
          .poll(
            () => page.frames().some((frame) => frame.url() === 'about:srcdoc'),
            { timeout: 5000, message: path },
          )
          .toBe(true);
        const inner = page
          .frames()
          .find((frame) => frame.url() === 'about:srcdoc');
        expect(inner, `${path} must mount authored HTML`).toBeDefined();
        if (!inner) throw new Error('Missing inner frame');
        await new Promise((resolve) => setTimeout(resolve, 1600));
        expect(packets, `${engine} ${path} UDP listener received packets`).toBe(
          0,
        );
        expect(await inner.evaluate('document.body.dataset.rtcResults')).toBe(
          JSON.stringify([
            'direct blocked',
            'child blocked',
            'indexed child blocked',
          ]),
        );
        expect(await inner.evaluate('typeof RTCPeerConnection')).toBe(
          'undefined',
        );
        if (path.startsWith('/html')) {
          expect(await page.evaluate('document.body.dataset.links')).toBe('0');
          await inner.getByRole('link', { name: 'Continue' }).click();
          await expect
            .poll(() => page.evaluate('document.body.dataset.links'))
            .toBe('1');
        }
      }
      const inner = page
        .frames()
        .find((frame) => frame.url() === 'about:srcdoc');
      if (!inner) throw new Error('Missing MCP sandbox');
      const nestedHtml = `<script>const pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${port}'}]});pc.createDataChannel('residual');pc.createOffer().then(o=>pc.setLocalDescription(o));</script>`;
      await inner.evaluate(
        `(()=>{const child=document.createElement('iframe');child.srcdoc=${JSON.stringify(nestedHtml)};document.body.append(child)})()`,
      );
      await expect.poll(() => packets, { timeout: 5000 }).toBeGreaterThan(0);
      process.stdout.write(
        `${engine}: direct HTML/MCP UDP=0; nested srcdoc residual UDP=${packets}\n`,
      );
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      udp.close();
    }
  }, 30000);
}
