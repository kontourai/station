import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { HtmlReplyPreview } from '../html-reply-preview.js';

const makeTempDir = trackTempDirs();
test('Chromium preview returns PNG, measured height and console stacks inside the opaque page', async () => {
  const service = new HtmlReplyPreview(makeTempDir('html-preview-'));
  const result = await service.render(
    {
      html: `<h1>Preview integration</h1><script>console.log('preview log');console.log('heap limit',performance.memory.jsHeapSizeLimit);console.warn('preview warning');console.error('preview error');try{parent.document.body;console.log('PARENT ACCESS ALLOWED')}catch{console.log('parent blocked')}setTimeout(()=>{throw new Error('preview uncaught')},0)</script>`,
      height: 400,
    },
    800,
    'dark',
  );
  expect(Buffer.from(result.png, 'base64').subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  const heap = result.console.find((entry) =>
    entry.text.startsWith('heap limit '),
  );
  expect(heap).toBeDefined();
  expect(Number(heap?.text.split(' ').at(-1))).toBeLessThanOrEqual(
    256 * 1024 * 1024,
  );
  expect(result.width).toBe(800);
  expect(result.contentHeight).toBeGreaterThan(40);
  expect(result.console).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        level: 'log',
        text: expect.stringContaining('preview log'),
      }),
      expect.objectContaining({
        level: 'warning',
        text: expect.stringContaining('preview warning'),
      }),
      expect.objectContaining({
        level: 'error',
        text: expect.stringContaining('preview error'),
      }),
      expect.objectContaining({
        level: 'uncaught',
        text: expect.stringContaining('preview uncaught'),
        stack: expect.anything(),
      }),
      expect.objectContaining({
        level: 'log',
        text: expect.stringContaining('parent blocked'),
      }),
    ]),
  );
  expect(
    result.console.some((entry) =>
      entry.text.includes('PARENT ACCESS ALLOWED'),
    ),
  ).toBe(false);
}, 30_000);

test('preview delivers script delimiters, Unicode separators and template syntax byte-exact to the frame', async () => {
  const payload = '</script>\u2028` ${agent.value}';
  const service = new HtmlReplyPreview(makeTempDir('html-preview-bytes-'));
  const result = await service.render(
    {
      html: `<template id="payload"><!--${payload}--></template><script>console.log(document.getElementById('payload').content.firstChild.data)</script>`,
      height: 400,
    },
    800,
    'dark',
  );
  const received = result.console.find((entry) => entry.text === payload);
  expect(
    received,
    'the opaque frame must receive every authored byte',
  ).toBeDefined();
  expect(Buffer.from(received?.text ?? '', 'utf8')).toEqual(
    Buffer.from(payload, 'utf8'),
  );
}, 30_000);

test('preview rejects oversized layout, overflowing console and invalid viewport instead of returning partial output', async () => {
  const service = new HtmlReplyPreview(makeTempDir('html-preview-limits-'));
  await expect(
    service.render(
      { html: '<div style="height:4000px">Too tall</div>', height: 400 },
      800,
      'light',
    ),
  ).rejects.toThrow('height exceeds');
  await expect(
    service.render(
      {
        html: '<script>for(let i=0;i<150;i++)console.log(i)</script>',
        height: 400,
      },
      800,
      'light',
    ),
  ).rejects.toThrow('console exceeds');
  await expect(
    service.render({ html: '', height: 400 }, 10000, 'light'),
  ).rejects.toThrow('width');
}, 40_000);

test('preview navigation and fetch cannot reach a loopback listener', async () => {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits++;
    response.end('unexpected network access');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No listener address');
  try {
    const url = `http://127.0.0.1:${address.port}/preview-probe`;
    const service = new HtmlReplyPreview(makeTempDir('html-preview-egress-'));
    const control = await service.render(
      { html: '<h1>egress prerequisite</h1>', height: 400 },
      800,
      'dark',
    );
    expect(control.contentHeight).toBeGreaterThan(0);
    await expect(
      service.render(
        {
          html: `<script>fetch('${url}').catch(()=>{});location.href='${url}'</script>`,
          height: 400,
        },
        800,
        'dark',
      ),
    ).rejects.toThrow('HTML preview exceeded 15 seconds');
    expect(
      hits,
      'preview must not send any HTTP request, including navigation',
    ).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 40000);

test('preview blocks ICE UDP in nested srcdoc and declarative closed shadow frames on loopback and LAN', async () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((value) => value?.family === 'IPv4' && !value.internal)?.address;
  expect(
    lan,
    'a real non-loopback interface is required for this host-egress test',
  ).toBeDefined();
  if (!lan) throw new Error('Missing non-loopback interface');
  const sockets = [];
  const packets = [0, 0];
  const destinations = [];
  try {
    for (const [index, address] of ['127.0.0.1', lan].entries()) {
      const socket = createSocket('udp4');
      sockets.push(socket);
      socket.on('message', () => packets[index]++);
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(0, address, resolve);
      });
      destinations.push(`stun:${address}:${socket.address().port}`);
    }
    const iceServers = JSON.stringify(destinations.map((urls) => ({ urls })));
    const child = (label: string) =>
      `<script>try{const pc=new RTCPeerConnection({iceServers:${iceServers}});pc.createDataChannel('probe');pc.createOffer().then(o=>pc.setLocalDescription(o));parent.postMessage({rtcProbe:'${label}',value:'OPEN'},'*')}catch{parent.postMessage({rtcProbe:'${label}',value:typeof RTCPeerConnection},'*')}</script>`;
    const attr = (value: string) =>
      value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const html = `<script>addEventListener('message',e=>{if(e.data?.rtcProbe)console.log('rtc-probe',e.data.rtcProbe,e.data.value)});const f=document.createElement('iframe');f.srcdoc=${JSON.stringify(child('nested')).replaceAll('<', '\\u003c')};document.body.append(f);</script><div><template shadowrootmode="closed"><iframe srcdoc="${attr(child('closed-shadow'))}"></iframe></template></div>`;
    const service = new HtmlReplyPreview(makeTempDir('html-preview-rtc-'));
    const result = await service.render({ html, height: 400 }, 800, 'dark');
    expect(result.contentHeight).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(
      packets,
      'preview must emit no ICE packets to loopback or the host LAN interface',
    ).toEqual([0, 0]);
    for (const label of ['nested', 'closed-shadow'])
      expect(
        result.console.some(
          (entry) => entry.text === `rtc-probe ${label} OPEN`,
        ),
        `${label} executed its RTC attempt in a fresh realm`,
      ).toBe(true);
    process.stdout.write(
      `Preview ICE listener results: loopback=${packets[0]}, LAN=${packets[1]} (${lan}); nested + closed-shadow RTC attempts executed\n`,
    );
  } finally {
    for (const socket of sockets) socket.close();
  }
}, 30000);
