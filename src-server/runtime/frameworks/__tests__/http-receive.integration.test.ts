// @vitest-environment node
import { spawn } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import {
  MEDIA_UPLOAD_POLICIES,
  mediaUploadPolicy,
} from '@kontourai/station-contracts/walkthrough';
import { configureHttpReceive } from '@kontourai/station-shared/http-upload';
import type { ServerProviderDeps } from '@voltagent/core';
import { streamSSE } from 'hono/streaming';
import { afterEach, expect, it, vi } from 'vitest';
import { buildUiServerScript } from '../../../../packages/cli/src/commands/lifecycle.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { DIRECT_LISTENER_LINK } from '../../bootstrap/supervisor-link.js';
import { stationHonoServer } from '../voltagent-hono-runtime.js';

const makeHome = trackTempDirs();
const cleanups: Array<() => unknown> = [];
const nativeTimer = globalThis.setTimeout;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
function accelerateTotal() {
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn, ms, ...args) =>
    nativeTimer(
      fn,
      ms !== undefined && ms >= 299_000 && ms <= 300_000 ? 150 : ms,
      ...args,
    )) as typeof setTimeout);
}
async function uiListener(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  unread = false,
  options: {
    early?: boolean;
    unavailable?: boolean;
    navigation?: boolean;
    onLateWrite?: () => void;
    onForwardingFinish?: (aborted: boolean) => void;
    queuedProxyResponse?: boolean;
    onQueuedResponse?: () => void;
    assetFailure?:
      | 'unreadable-stream'
      | 'vanished-stream'
      | 'vanished-stat'
      | 'unreadable-html'
      | 'navigation-html'
      | 'midstream';
    onAssetRace?: () => void;
  } = {},
) {
  const upstream = createServer(handler);
  configureHttpReceive(
    upstream,
    (method, path) => mediaUploadPolicy(method, path, MEDIA_UPLOAD_POLICIES),
    MEDIA_UPLOAD_POLICIES.walkthrough.totalMs,
  );
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve),
  );
  cleanups.push(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const uiDir = makeHome('station-receive-ui-');
  const identity = {
    instanceId: 'receive-fixture',
    bootId: 'receive-boot',
    sha: 'receive-sha',
  };
  const readinessFile = join(uiDir, 'ready.json');
  if (options.navigation) {
    writeFileSync(join(uiDir, 'index.html'), '<html>alive</html>');
    writeFileSync(
      readinessFile,
      JSON.stringify({ health: { status: 'ready', sha: identity.sha } }),
      { mode: 0o600 },
    );
  }
  const failedAsset = options.assetFailure?.endsWith('html')
    ? join(uiDir, 'index.html')
    : join(uiDir, 'broken.js');
  if (options.assetFailure) {
    writeFileSync(
      failedAsset,
      options.assetFailure === 'midstream'
        ? Buffer.alloc(1024 * 1024, 65)
        : '<head></head><body>asset</body>',
    );
    if (
      options.assetFailure.startsWith('unreadable') ||
      options.assetFailure === 'navigation-html'
    )
      chmodSync(failedAsset, 0);
  }
  const script = buildUiServerScript({
    uiDir,
    ...(options.navigation ? { identity, readinessFile } : {}),
    upstreamPort: (upstream.address() as net.AddressInfo).port,
    uiPort: 0,
    host: '127.0.0.1',
  });
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const nativeTimer=globalThis.setTimeout;
    globalThis.setTimeout=(fn,ms,...args)=>nativeTimer(fn,ms>=299000&&ms<=300000?150:ms>=59000&&ms<=60000?400:ms,...args);
    ${
      options.onForwardingFinish
        ? `
      let trackedProxyRequest;
      const finishHttp=require('http'),finishRequest=finishHttp.request;
      finishHttp.request=function(options,...args){
        const request=finishRequest.call(this,options,...args);
        if(options.path==='/api/projects')trackedProxyRequest=request;
        return request;
      };
    `
        : ''
    }
    ${
      options.queuedProxyResponse
        ? `
      // A response callback already queued by HTTP can outlive request.destroy().
      const raceHttp=require('http'),realRequest=raceHttp.request;
      raceHttp.request=function(options,callback){
        return realRequest.call(this,options,options.path==='/api/late-race'?response=>{
          response.on('error',()=>{});
          nativeTimer(()=>{
            process.stderr.write('QUEUED_PROXY_RESPONSE\\n');
            callback(response);
          },250);
        }:callback);
      };
    `
        : ''
    }
    ${script}
    ${
      options.assetFailure === 'midstream'
        ? `
      const brokenStreamPath=fs.realpathSync(${JSON.stringify(failedAsset)});
      const openStream=fs.createReadStream;
      fs.createReadStream=function(p,...args){
        const stream=openStream.call(this,p,...args);
        if(p===brokenStreamPath)stream.once('data',()=>{
          fs.closeSync(stream.fd);
          process.stderr.write('ASSET_RACE_RENAMED\\n');
        });
        return stream;
      };
    `
        : ''
    }
    ${
      options.assetFailure?.startsWith('vanished')
        ? `
      const assetPath=fs.realpathSync(${JSON.stringify(failedAsset)});
      const checkName=${JSON.stringify(options.assetFailure === 'vanished-stat' ? 'existsSync' : 'statSync')};
      const originalCheck=fs[checkName];
      let checks=0;
      fs[checkName]=function(p,...args){
        const result=originalCheck.call(this,p,...args);
        if(p===assetPath&&++checks===2){
          fs.renameSync(assetPath,assetPath+'.moved');
          process.stderr.write('ASSET_RACE_RENAMED\\n');
        }
        return result;
      };
    `
        : ''
    }
    ${
      options.onForwardingFinish
        ? `
      server.on('request',(req,res)=>{
        if(req.url!=='/api/projects')return;
        res.once('finish',()=>process.stderr.write(
          'PROXY_FINISH_'+(trackedProxyRequest.destroyed?'ABORTED':'ACTIVE')+'\\n'));
      });
    `
        : ''
    }
    ${
      unread
        ? `
      // The production proxy drains requests. Install the same unread fixture
      // on its generated listener without replacing its receive-policy listeners.
      const uiHandler=server.listeners('request').at(-1);
      server.removeListener('request',uiHandler);
      server.on('request',(req,res)=>req.url==='/api/unread-stream'?(${handler.toString()})(req,res):uiHandler(req,res));
    `
        : ''
    }
    ${
      options.early
        ? `
      const handler=server.listeners('request').at(-1);
      server.removeListener('request',handler);
      server.on('request',(req,res)=>{req.resume();res.end('{}');});
    `
        : ''
    }
    ${
      options.navigation
        ? `
      server.prependListener('request',(_req,res)=>{
        const writeHead=res.writeHead;
        res.writeHead=function(...args){
          if(res.headersSent)process.stderr.write('LATE_HEADER_WRITE'+String.fromCharCode(10));
          return writeHead.apply(this,args);
        };
      });
    `
        : ''
    }
    server.on('listening',()=>console.log(server.address().port));
  `,
    ],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        STATION_INTERNAL_API_TOKEN: options.unavailable
          ? ''
          : 'test-receive-internal',
      },
    },
  );
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill('SIGTERM');
    await exited;
  });
  return await new Promise<number>((resolve, reject) => {
    let output = '',
      errors = '';
    const guard = nativeTimer(
      () => reject(new Error(`UI listener did not start: ${errors}`)),
      5000,
    );
    child.stderr.on('data', (b) => {
      errors += b.toString();
      if (b.toString().includes('LATE_HEADER_WRITE')) options.onLateWrite?.();
      if (b.toString().includes('ASSET_RACE_RENAMED')) options.onAssetRace?.();
      if (b.toString().includes('PROXY_FINISH_'))
        options.onForwardingFinish?.(
          b.toString().includes('PROXY_FINISH_ABORTED'),
        );
      if (b.toString().includes('QUEUED_PROXY_RESPONSE'))
        options.onQueuedResponse?.();
    });
    child.stdout.on('data', (b) => {
      output += b.toString();
      if (/^\d+\n/.test(output)) {
        clearTimeout(guard);
        resolve(Number(output.trim()));
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(guard);
      reject(new Error(`UI exited ${code}: ${errors}`));
    });
  });
}

it.each(['api', 'serialized-ui'] as const)(
  '%s keeps an unread completed POST body SSE response alive beyond the ordinary receive total',
  async (listener) => {
    let port: number;
    if (listener === 'api') {
      accelerateTotal();
      const provider = stationHonoServer(
        {
          port: 0,
          hostname: '127.0.0.1',
          configureFullApp: ({ app }) => {
            app.post('/api/unread-stream', (c) =>
              streamSSE(c, async (s) => {
                await s.writeSSE({ data: 'first' });
                await new Promise((r) => nativeTimer(r, 500));
                await s.writeSSE({ data: 'last' });
              }),
            );
          },
        },
        () => DIRECT_LISTENER_LINK,
      )({} as ServerProviderDeps);
      port = (await provider.start()).port;
      cleanups.push(() => provider.stop());
    } else {
      port = await uiListener((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: first\n\n');
        setTimeout(() => res.end('data: last\n\n'), 500);
      }, true);
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/unread-stream`, {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.timeout(3000),
    });
    const result = await response
      .text()
      .catch((e: Error) => `stream failed: ${e.message}`);
    expect(response.status).toBe(200);
    expect(result).toContain('data: last');
  },
);

it.each(['api', 'serialized-ui'] as const)(
  '%s delivers a refusal body to a client still writing a large upload',
  async (listener) => {
    const path = '/api/projects/absent/walkthroughs/import';
    let port: number;
    if (listener === 'api') {
      const provider = stationHonoServer(
        {
          port: 0,
          hostname: '127.0.0.1',
          configureFullApp: ({ app }) => {
            app.post(path, (c) => {
              c.header('Connection', 'close');
              return c.json({ error: 'Project not found' }, 404);
            });
          },
        },
        () => DIRECT_LISTENER_LINK,
      )({} as ServerProviderDeps);
      port = (await provider.start()).port;
      cleanups.push(() => provider.stop());
    } else {
      port = await uiListener((_req, res) => {
        res.writeHead(404, {
          Connection: 'close',
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ error: 'Project not found' }));
      });
    }
    const total = 64 * 1024 * 1024;
    const result = await new Promise<{
      reply: string;
      supplied: number;
      timedOut: boolean;
    }>((resolve) => {
      const socket = net.connect({
        host: '127.0.0.1',
        port,
        allowHalfOpen: true,
      });
      let reply = '',
        supplied = 0,
        finished = false;
      let nextWrite: ReturnType<typeof setImmediate> | undefined;
      const done = (timedOut = false) => {
        if (finished) return;
        finished = true;
        clearTimeout(guard);
        clearImmediate(nextWrite);
        resolve({ reply, supplied, timedOut });
        socket.destroy();
      };
      const guard = nativeTimer(() => done(true), 3000);
      socket.on('data', (b) => {
        reply += b.toString();
      });
      socket.on('error', () => done());
      socket.on('close', () => done());
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Length: ${total}\r\n\r\n`,
      );
      const chunk = Buffer.alloc(64 * 1024, 1);
      const pump = () => {
        if (finished || supplied === total) return;
        supplied += chunk.length;
        if (socket.write(chunk)) nextWrite = setImmediate(pump);
        else
          socket.once('drain', () => {
            nextWrite = setImmediate(pump);
          });
      };
      pump();
    });
    expect(result.reply).toMatch(/^HTTP\/1.1 404/);
    expect(result.reply).toMatch(/connection: close/i);
    expect(result.reply).toContain('{"error":"Project not found"}');
    expect(
      result.supplied,
      'linger must stop reading after its byte cap',
    ).toBeLessThan(6 * 1024 * 1024);
    expect(result.timedOut, 'refused socket exceeded its bounded linger').toBe(
      false,
    );
  },
);

it('serialized UI survives ordinary receive expiry, aborts forwarding, and keeps another SSE alive', async () => {
  let upstreamClosed = false;
  let abortedBeforeWrite = false;
  let upstreamWrote = false;
  let abortedAtFinish = false;
  const port = await uiListener(
    (req, res) => {
      if (req.url === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: first\n\n');
        setTimeout(() => res.end('data: last\n\n'), 650);
      } else if (req.method === 'POST') {
        req.resume();
        res.on('close', () => {
          upstreamClosed = true;
        });
        // This later callback used to race the UI's local 408.
        setTimeout(() => {
          abortedBeforeWrite = upstreamClosed && !req.complete && res.destroyed;
          upstreamWrote = true;
          res.writeHead(408);
          res.end();
        }, 350);
      } else res.end('alive');
    },
    false,
    {
      onForwardingFinish: (aborted) => {
        abortedAtFinish = aborted;
      },
    },
  );
  const stream = fetch(`http://127.0.0.1:${port}/events`)
    .then((r) => r.text())
    .catch((e) => String(e));
  const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true });
  cleanups.push(() => socket.destroy());
  let reply = '';
  socket.on('data', (b) => {
    reply += b.toString();
  });
  socket.on('error', () => {});
  socket.write(
    'POST /api/projects HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\n ',
  );
  await new Promise((r) => nativeTimer(r, 800));
  expect(reply).toContain('408');
  expect(
    await stream,
    'unrelated SSE must survive the late upstream callback',
  ).toContain('data: last');
  expect(
    abortedAtFinish,
    'forwarding must be aborted when response finish returns',
  ).toBe(true);
  expect(upstreamWrote, 'the upstream own-write deadline must be reached').toBe(
    true,
  );
  expect(
    abortedBeforeWrite,
    'finish must abort upstream before its own write',
  ).toBe(true);
  expect(
    await (await fetch(`http://127.0.0.1:${port}/api/health`)).text(),
  ).toBe('alive');
});

it.each(['api', 'serialized-ui'] as const)(
  '%s bounds incomplete transcription even after early success',
  async (listener) => {
    let port: number;
    if (listener === 'api') {
      const server = createServer((req, res) => {
        req.resume();
        res.end('{}');
      });
      const policies = {
        ...MEDIA_UPLOAD_POLICIES,
        transcription: {
          ...MEDIA_UPLOAD_POLICIES.transcription,
          idleMs: 200,
          totalMs: 400,
        },
      };
      configureHttpReceive(
        server,
        (m, p) => mediaUploadPolicy(m, p, policies),
        policies.walkthrough.totalMs,
      );
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      port = (server.address() as net.AddressInfo).port;
      cleanups.push(() => {
        server.closeAllConnections();
        server.close();
      });
    } else
      port = await uiListener(
        (req, res) => {
          req.resume();
          res.end('{}');
        },
        false,
        { early: true },
      );
    const start = Date.now();
    const result = await new Promise<{
      reply: string;
      elapsed: number;
      capped: boolean;
    }>((resolve) => {
      const socket = net.connect({
        port,
        host: '127.0.0.1',
        allowHalfOpen: true,
      });
      let reply = '',
        capped = false;
      const pulse = setInterval(() => socket.write('x'), 25);
      const cap = nativeTimer(() => {
        capped = true;
        socket.destroy();
      }, 1400);
      socket.on('data', (b) => {
        reply += b.toString();
      });
      socket.on('error', () => {});
      socket.on('close', () => {
        clearInterval(pulse);
        clearTimeout(cap);
        resolve({ reply, elapsed: Date.now() - start, capped });
      });
      socket.write(
        'POST /api/transcription HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\nx',
      );
    });
    expect(result.reply).toContain('200');
    expect(
      result.capped,
      'early response must not dispose upload deadlines',
    ).toBe(false);
    expect(result.elapsed).toBeLessThan(1000);
  },
);

it('serialized UI closes and lingers on a local upload refusal', async () => {
  const port = await uiListener((_req, res) => res.end('unexpected'), false, {
    unavailable: true,
  });
  const result = await new Promise<{ reply: string; capped: boolean }>(
    (resolve) => {
      const socket = net.connect({
        port,
        host: '127.0.0.1',
        allowHalfOpen: true,
      });
      let reply = '',
        capped = false;
      const cap = nativeTimer(() => {
        capped = true;
        socket.destroy();
      }, 2000);
      const pulse = setInterval(() => socket.write('x'), 25);
      socket.on('data', (b) => {
        reply += b.toString();
      });
      socket.on('error', () => {});
      socket.on('close', () => {
        clearTimeout(cap);
        clearInterval(pulse);
        resolve({ reply, capped });
      });
      socket.write(
        'POST /api/transcription HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\nx',
      );
    },
  );
  expect(result.reply).toMatch(/^HTTP\/1.1 503/);
  expect(result.reply).toMatch(/connection: close/i);
  expect(result.capped, 'local refusal must use bounded linger').toBe(false);
});

it('serialized UI never writes navigation headers after receive expiry', async () => {
  let probes = 0;
  let answered = false;
  let lateWrites = 0;
  const port = await uiListener(
    (req, res) => {
      if (req.url === '/api/system/identity') {
        probes++;
        setTimeout(() => {
          answered = true;
          return res.end(
            JSON.stringify({
              instanceId: 'receive-fixture',
              bootId: 'receive-boot',
              sha: 'receive-sha',
            }),
          );
        }, 350);
      } else res.end('alive');
    },
    false,
    {
      navigation: true,
      onLateWrite: () => {
        lateWrites++;
      },
    },
  );
  const socket = net.connect(port, '127.0.0.1');
  cleanups.push(() => socket.destroy());
  let reply = '';
  socket.on('data', (b) => {
    reply += b.toString();
  });
  socket.on('error', () => {});
  socket.write(
    'GET / HTTP/1.1\r\nHost: x\r\nAccept: text/html\r\nContent-Length: 100000\r\n\r\nx',
  );
  await new Promise((r) => nativeTimer(r, 700));
  expect(reply).toContain('408');
  const result = await fetch(`http://127.0.0.1:${port}/api/health`)
    .then((r) => r.text())
    .catch((e) => String(e));
  expect(probes, 'the real navigation identity probe must be reached').toBe(1);
  expect(answered, 'the upstream answer must arrive after local 408').toBe(
    true,
  );
  expect(result, 'late navigation callback must not kill the UI').toBe('alive');
  expect(
    lateWrites,
    'an expired navigation must not attempt a second header write',
  ).toBe(0);
});

it('serialized UI discards an already queued proxy response after local 408', async () => {
  let queued = false;
  const port = await uiListener(
    (req, res) => {
      req.resume();
      res.end('upstream');
    },
    false,
    {
      queuedProxyResponse: true,
      onQueuedResponse: () => {
        queued = true;
      },
    },
  );
  const socket = net.connect(port, '127.0.0.1');
  cleanups.push(() => socket.destroy());
  let reply = '';
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    reply += chunk.toString();
  });
  socket.write(
    'POST /api/late-race HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\nx',
  );
  await new Promise((resolve) => nativeTimer(resolve, 600));
  expect(reply).toContain('408');
  expect(
    queued,
    'a real upstream response callback must arrive after the 408',
  ).toBe(true);
  const followup = await fetch(`http://127.0.0.1:${port}/__station/identity`)
    .then((res) => res.status)
    .catch((error) => String(error));
  expect(followup, 'late proxy callback must not kill the UI process').toBe(
    200,
  );
});

it.each([
  'unreadable-stream',
  'vanished-stream',
  'vanished-stat',
  'unreadable-html',
  'navigation-html',
  'midstream',
] as const)(
  'serialized UI contains %s asset failure and serves the next request',
  async (failure) => {
    let renamed = false;
    const port = await uiListener(
      (req, res) => {
        req.resume();
        res.end(
          JSON.stringify({
            instanceId: 'receive-fixture',
            bootId: 'receive-boot',
            sha: 'receive-sha',
          }),
        );
      },
      false,
      {
        assetFailure: failure,
        navigation: failure === 'navigation-html',
        onAssetRace: () => {
          renamed = true;
        },
      },
    );
    const failed = await fetch(
      `http://127.0.0.1:${port}/${failure.endsWith('html') ? '' : 'broken.js'}`,
      {
        headers: { Accept: failure.endsWith('html') ? 'text/html' : '*/*' },
        signal: AbortSignal.timeout(1500),
      },
    )
      .then(async (res) => ({ status: res.status, body: await res.text() }))
      .catch((error) => ({ status: String(error), body: '' }));
    if (failure.startsWith('vanished'))
      expect(
        renamed,
        'real file must be renamed between check and open/stat',
      ).toBe(true);
    if (failure === 'midstream') {
      expect(
        renamed,
        'real file descriptor must close after the first chunk',
      ).toBe(true);
      expect(String(failed.status)).toContain('terminated');
    } else
      expect(failed.status, 'asset failure must settle as a local 500').toBe(
        500,
      );
    expect(failed.body).not.toContain('station-receive-ui');
    const next = await fetch(`http://127.0.0.1:${port}/__station/identity`, {
      signal: AbortSignal.timeout(1000),
    })
      .then((res) => res.status)
      .catch((error) => String(error));
    expect(next, 'asset failure must not kill the UI process').toBe(200);
  },
);
