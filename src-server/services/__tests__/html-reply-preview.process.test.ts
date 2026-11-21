import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import * as loggerUtils from '../../utils/logger.js';
import {
  CdpPipeTransport,
  CdpTransportClosedError,
} from '../browser/cdp-pipe-transport.js';
import { ChromiumAcquisition } from '../browser/chromium-acquisition.js';
import {
  ChromiumServerHost,
  SERVED_DOCUMENT_URL,
} from '../browser/hosts/chromium-server-host.js';
import { HtmlReplyPreview } from '../html-reply-preview.js';

const makeTempDir = trackTempDirs();

/** Diagnostic-only observer: forwards real CDP calls and retains no page content. */
function observePreviewPhases(caseOrdinal: number) {
  const logger = loggerUtils.createLogger({ name: 'preview-phase-diagnostic' });
  const started = performance.now();
  const entries: Record<string, unknown>[] = [];
  const identities = new Map<string, string>();
  const transports = new WeakSet<CdpPipeTransport>();
  const unsubscribe: (() => void)[] = [];
  let truncated = false;
  let identityExhausted = false;
  let entriesDropped = 0;
  let finished = false;
  let renderCount = 0;
  const attempts: {
    state: 'NOT_REACHED' | 'STARTED' | 'RESOLVED' | 'REJECTED';
    terminal?: unknown;
  }[] = [{ state: 'NOT_REACHED' }];
  const attemptBindings = new Map<string, number>();
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const identity = (
    value: unknown,
    kind: 'session' | 'target' | 'frame' | 'loader' = 'session',
  ) => {
    if (typeof value !== 'string') return undefined;
    if (value.length > 128) {
      identityExhausted = true;
      return null;
    }
    const key = `${kind}:${value}`;
    if (!identities.has(key) && identities.size < 96)
      identities.set(key, `opaque-${identities.size + 1}`);
    const alias = identities.get(key);
    if (!alias) identityExhausted = true;
    return alias ?? null;
  };
  const urlKind = (value: unknown) =>
    value === 'about:blank'
      ? 'about-blank'
      : typeof value === 'string' &&
          value.startsWith('chrome://prefs-internals/')
        ? 'prefs-internals'
        : 'other';
  const record = (entry: Record<string, unknown>) => {
    const projected = {
      atMs: Math.round(performance.now() - started),
      ...entry,
    };
    if (
      entries.length < 96 &&
      Buffer.byteLength(JSON.stringify(projected)) <= 384
    )
      entries.push(projected);
    else {
      truncated = true;
      entriesDropped = Math.min(65535, entriesDropped + 1);
    }
  };
  const methods = new Set([
    'Browser.getVersion',
    'Target.createTarget',
    'Target.attachToTarget',
    'Page.enable',
    'Page.navigate',
    'Runtime.evaluate',
    'Runtime.callFunctionOn',
    'Target.closeTarget',
    'Page.captureScreenshot',
    'Browser.close',
  ]);
  const original = CdpPipeTransport.prototype.send;
  const spy = vi
    .spyOn(CdpPipeTransport.prototype, 'send')
    .mockImplementation(async function <R>(
      this: CdpPipeTransport,
      method: string,
      params?: object,
      sessionId?: string,
    ): Promise<R> {
      if (!transports.has(this)) {
        transports.add(this);
        unsubscribe.push(
          this.on('Page.loadEventFired', (_params, session) =>
            record({ event: 'load', session: identity(session) }),
          ),
        );
        unsubscribe.push(
          this.on('Page.frameNavigated', (params, session) => {
            const frame =
              object(params) && object(params.frame) ? params.frame : undefined;
            record({
              event: 'frame-navigated',
              session: identity(session),
              frame: identity(frame?.id, 'frame'),
              loader: identity(frame?.loaderId, 'loader'),
              urlKind: urlKind(frame?.url),
            });
          }),
        );
      }
      const selected = methods.has(method);
      if (selected)
        record({
          method,
          state: 'sent',
          session: identity(sessionId),
          ...(method === 'Page.navigate' && object(params)
            ? { urlKind: urlKind(params.url) }
            : {}),
        });
      try {
        const send = original<R>;
        const answer = await send.call(this, method, params, sessionId);
        if (selected) {
          const safe: Record<string, unknown> = {};
          if (object(answer)) {
            if (method === 'Browser.getVersion')
              safe.product =
                typeof answer.product === 'string' &&
                /^(?:Chrome|HeadlessChrome)\/[0-9.]{1,48}$/.test(answer.product)
                  ? answer.product
                  : 'other';
            if (method === 'Target.createTarget')
              safe.target = identity(answer.targetId, 'target');
            if (method === 'Target.attachToTarget')
              safe.attachedSession = identity(answer.sessionId);
            if (method === 'Page.navigate') {
              safe.frame = identity(answer.frameId, 'frame');
              safe.loader = identity(answer.loaderId, 'loader');
              safe.navigationError = typeof answer.errorText === 'string';
            }
            if (
              method === 'Runtime.evaluate' ||
              method === 'Runtime.callFunctionOn'
            ) {
              safe.exceptionPresent = object(answer.exceptionDetails);
              const value = object(answer.result)
                ? answer.result.value
                : undefined;
              if (
                object(value) &&
                ('policy' in value || 'urlOverrides' in value)
              ) {
                safe.policy =
                  typeof value.policy === 'string' &&
                  [
                    'default',
                    'default_public_interface_only',
                    'default_public_and_private_interfaces',
                    'disable_non_proxied_udp',
                  ].includes(value.policy)
                    ? value.policy
                    : 'other-or-missing';
                safe.urlOverrides =
                  typeof value.urlOverrides === 'boolean'
                    ? value.urlOverrides
                    : 'unavailable';
              } else safe.valueKind = value === null ? 'null' : 'other';
            }
          }
          record({
            method,
            state: 'answered',
            session: identity(sessionId),
            ...safe,
          });
        }
        return answer;
      } catch (error) {
        if (selected)
          record({
            method,
            state: 'rejected',
            session: identity(sessionId),
            protocolCode:
              object(error) && Number.isSafeInteger(error.code)
                ? error.code
                : undefined,
          });
        throw error;
      }
    });
  loggerUtils.installLoggerLineSink({
    writeLine(line) {
      const parsed: unknown = JSON.parse(line);
      if (!object(parsed) || !object(parsed.previewTerminalReceipt)) return;
      const terminal = parsed.previewTerminalReceipt;
      if (
        typeof terminal.attempt !== 'string' ||
        !/^[a-f0-9]{16}$/.test(terminal.attempt)
      )
        return;
      if (
        !attemptBindings.has(terminal.attempt) &&
        terminal.late !== true &&
        attemptBindings.size < 3 &&
        attempts[renderCount - 1]?.state === 'STARTED'
      )
        attemptBindings.set(terminal.attempt, renderCount - 1);
      const index = attemptBindings.get(terminal.attempt);
      if (index !== undefined && attempts[index])
        attempts[index].terminal = terminal;
    },
  });
  const originalRender = HtmlReplyPreview.prototype.render;
  const renderSpy = vi
    .spyOn(HtmlReplyPreview.prototype, 'render')
    .mockImplementation(async function (this: HtmlReplyPreview, ...args) {
      const index = renderCount++;
      attempts[index] = { state: 'STARTED' };
      try {
        const result = await originalRender.apply(this, args);
        attempts[index].state = 'RESOLVED';
        return result;
      } catch (error) {
        attempts[index].state = 'REJECTED';
        if (error instanceof Error)
          Object.defineProperty(error, 'previewPhaseReceipt', {
            value: JSON.stringify(receipt()),
            enumerable: true,
            configurable: true,
          });
        throw error;
      }
    });
  const receipt = () => ({
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    entries,
    truncated,
    caseOrdinal,
    identityExhausted,
    entriesDropped,
    attempts,
  });
  return {
    planCalls(count: number) {
      attempts.splice(
        0,
        attempts.length,
        ...Array.from({ length: count }, () => ({
          state: 'NOT_REACHED' as const,
        })),
      );
    },
    attachFailure(error: unknown) {
      if (error instanceof Error)
        Object.defineProperty(error, 'previewPhaseReceipt', {
          value: JSON.stringify(receipt()),
          enumerable: true,
          configurable: true,
        });
    },
    finish() {
      if (finished) return;
      finished = true;
      spy.mockRestore();
      renderSpy.mockRestore();
      for (const off of unsubscribe) off();
      loggerUtils.installLoggerLineSink(undefined);
      logger.info('HTML preview safe phase receipt', {
        previewPhaseReceipt: receipt(),
      });
      expect(
        attempts
          .slice(0, renderCount)
          .every((attempt) => attempt.terminal !== undefined),
        'every reached real render must emit a terminal receipt',
      ).toBe(true);
    },
  };
}

let caseOrdinal = 0;
let activeObservation: ReturnType<typeof observePreviewPhases>;
function observationReceipt() {
  const error = new Error('diagnostic witness');
  activeObservation.attachFailure(error);
  return JSON.parse(
    Object.getOwnPropertyDescriptor(error, 'previewPhaseReceipt')?.value,
  );
}
beforeEach(() => {
  activeObservation = observePreviewPhases(++caseOrdinal);
});
afterEach(() => activeObservation.finish());

test('phase trace exhaustion retains real admission terminal facts and identity overflow stays null', async () => {
  const writable = new PassThrough();
  const readable = new PassThrough();
  const transport = new CdpPipeTransport(writable, readable);
  try {
    const enable = transport.send('Page.enable');
    readable.emit(
      'data',
      Buffer.from(JSON.stringify({ id: 1, result: {} }) + '\0'),
    );
    await enable;
    const frame = (session: string, id: string, loaderId: string) =>
      readable.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            method: 'Page.frameNavigated',
            sessionId: session,
            params: { frame: { id, loaderId, url: 'about:blank' } },
          }) + '\0',
        ),
      );
    frame('s'.repeat(129), 'f'.repeat(129), 'l'.repeat(129));
    expect(observationReceipt().entries.at(-1)).toMatchObject({
      event: 'frame-navigated',
      session: null,
      frame: null,
      loader: null,
    });
    for (let i = 0; i < 32; i++)
      frame('secret-session-' + i, 'secret-frame-' + i, 'secret-loader-' + i);
    expect(observationReceipt().entries[3]).toMatchObject({
      session: expect.any(String),
      frame: expect.any(String),
      loader: expect.any(String),
    });
    frame(
      'secret-session-overflow',
      'secret-frame-overflow',
      'secret-loader-overflow',
    );
    expect(observationReceipt().entries.at(-1)).toMatchObject({
      event: 'frame-navigated',
      session: null,
      frame: null,
      loader: null,
    });
    for (let i = 2; i <= 98; i++) {
      const pending = transport.send('Target.createTarget');
      readable.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            id: i,
            result: { targetId: 'secret-target-' + i },
          }) + '\0',
        ),
      );
      await pending;
    }
    const service = new HtmlReplyPreview(makeTempDir('html-preview-trace-'));
    await expect(
      service.render({ html: 'secret-authored', height: 400 }, 1, 'dark'),
    ).rejects.toThrow('width');
    const receipt = observationReceipt();
    expect(receipt.entries).toHaveLength(96);
    expect(
      receipt.entries.every(
        (entry: unknown) => Buffer.byteLength(JSON.stringify(entry)) <= 384,
      ),
    ).toBe(true);
    expect(receipt.entriesDropped).toBeGreaterThan(0);
    expect(receipt.identityExhausted).toBe(true);
    expect(receipt.attempts[0].terminal.terminal.phases.surfaced).toBe(
      'REJECTED',
    );
    expect(receipt.attempts[0].terminal.terminal.child).toBe('UNOBSERVED');
    expect(JSON.stringify(receipt)).not.toMatch(
      /secret-(?:target|session|frame|loader|authored)|"overflow"/,
    );
  } finally {
    await transport.close();
  }
});

test.each([false, true])(
  'keeper discards stale late receipts and requires an initial render receipt (omit=%s)',
  async (omitInitial) => {
    const service = new HtmlReplyPreview(
      makeTempDir('html-preview-attribution-'),
    );
    for (let i = 0; i < 3; i++)
      await expect(
        service.render({ html: 'secret-authored', height: 400 }, 1, 'dark'),
      ).rejects.toThrow('width');
    const previous = observationReceipt().attempts.map(
      (attempt: { terminal: unknown }) => attempt.terminal,
    );
    expect(previous).toHaveLength(3);
    activeObservation.finish();

    const productionRender = HtmlReplyPreview.prototype.render;
    const originalInstall = loggerUtils.installLoggerLineSink;
    const install = vi
      .spyOn(loggerUtils, 'installLoggerLineSink')
      .mockImplementation((sink) =>
        originalInstall(
          sink && {
            writeLine(line) {
              const parsed = JSON.parse(line);
              if (
                omitInitial &&
                parsed.previewTerminalReceipt &&
                parsed.previewTerminalReceipt.late !== true
              )
                return;
              sink.writeLine(line);
            },
          },
        ),
      );
    const logger = loggerUtils.createLogger({
      name: 'preview-attribution-control',
    });
    const stale = previous.map((terminal: object) => ({
      ...terminal,
      late: true,
    }));
    let beforeInitial: unknown;
    HtmlReplyPreview.prototype.render = function (
      this: HtmlReplyPreview,
      ...args: Parameters<HtmlReplyPreview['render']>
    ) {
      for (const terminal of stale)
        logger.info('stale preview receipt control', {
          previewTerminalReceipt: terminal,
        });
      beforeInitial = observationReceipt().attempts[0].terminal;
      return productionRender.apply(this, args);
    };
    activeObservation = observePreviewPhases(++caseOrdinal);
    try {
      await expect(
        service.render({ html: 'secret-authored', height: 400 }, 1, 'dark'),
      ).rejects.toThrow('width');
      expect(beforeInitial).toBeUndefined();
      const current = observationReceipt().attempts[0].terminal;
      if (omitInitial) {
        expect(current).toBeUndefined();
        expect(() => activeObservation.finish()).toThrow(
          'every reached real render must emit a terminal receipt',
        );
      } else {
        expect(current).toBeDefined();
        expect(
          previous.some(
            (terminal: { attempt: string }) =>
              terminal.attempt === current.attempt,
          ),
        ).toBe(false);
        for (const terminal of stale)
          logger.info('stale preview receipt control', {
            previewTerminalReceipt: terminal,
          });
        expect(observationReceipt().attempts[0].terminal.attempt).toBe(
          current.attempt,
        );
        logger.info('known late preview receipt control', {
          previewTerminalReceipt: { ...current, late: true },
        });
        expect(observationReceipt().attempts[0].terminal).toMatchObject({
          attempt: current.attempt,
          late: true,
        });
        expect(() => activeObservation.finish()).not.toThrow();
      }
    } finally {
      try {
        activeObservation.finish();
      } finally {
        HtmlReplyPreview.prototype.render = productionRender;
        install.mockRestore();
        originalInstall(undefined);
      }
    }
  },
);

test('Chromium preview returns PNG, measured height and console stacks inside the opaque page', async () => {
  const observation = activeObservation;
  try {
    const service = new HtmlReplyPreview(makeTempDir('html-preview-'));
    const result = await service.render(
      {
        html: `<h1>Preview integration</h1><script>console.log('preview log');console.log('heap limit',performance.memory.jsHeapSizeLimit);console.warn('preview warning');console.error('preview error');try{parent.document.body;console.log('PARENT ACCESS ALLOWED')}catch{console.log('parent blocked')}setTimeout(()=>{throw new Error('preview uncaught')},0);console.log('referrer',JSON.stringify(document.referrer))</script>`,
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
        // The served bootstrap page must not leak its address to the frame.
        expect.objectContaining({ level: 'log', text: 'referrer ""' }),
      ]),
    );
    expect(
      result.console.some((entry) =>
        entry.text.includes('PARENT ACCESS ALLOWED'),
      ),
    ).toBe(false);
  } catch (error) {
    observation.attachFailure(error);
    throw error;
  } finally {
    observation.finish();
  }
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
  activeObservation.planCalls(3);
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
  activeObservation.planCalls(2);
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
      `<script>setTimeout(()=>{try{const pc=new RTCPeerConnection({iceServers:${iceServers}});pc.createDataChannel('probe');pc.createOffer().then(o=>pc.setLocalDescription(o));parent.postMessage({rtcProbe:'${label}',value:'OPEN'},'*')}catch{parent.postMessage({rtcProbe:'${label}',value:typeof RTCPeerConnection},'*')}},500)</script>`;
    const attr = (value: string) =>
      value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const html = `<script>addEventListener('message',e=>{if(e.data?.rtcProbe)console.log('rtc-probe',e.data.rtcProbe,e.data.value)});const f=document.createElement('iframe');f.srcdoc=${JSON.stringify(child('nested')).replaceAll('<', '\\u003c')};document.body.append(f);</script><div><template shadowrootmode="closed"><iframe srcdoc="${attr(child('closed-shadow'))}"></iframe></template></div>`;
    let sessionId: string | undefined;
    const openTarget = ChromiumServerHost.prototype.openTarget;
    const shutdown = ChromiumServerHost.prototype.shutdown;
    const openSpy = vi
      .spyOn(ChromiumServerHost.prototype, 'openTarget')
      .mockImplementation(async function (this: ChromiumServerHost, options) {
        const target = await openTarget.call(this, options);
        sessionId = target.cdpSessionId;
        await this.cdp().send(
          'Runtime.evaluate',
          {
            expression: `globalThis.rtcWitnesses=[];addEventListener('message',event=>{const text=event.data?.text;if(text==='rtc-probe nested OPEN'||text==='rtc-probe closed-shadow OPEN')rtcWitnesses.push(text)});`,
          },
          sessionId,
        );
        return target;
      });
    // Keep the real preview process alive for its probes and UDP observation.
    const shutdownSpy = vi
      .spyOn(ChromiumServerHost.prototype, 'shutdown')
      .mockImplementation(async function (this: ChromiumServerHost) {
        try {
          if (!sessionId) throw new Error('Preview target was not opened');
          await expect
            .poll(
              async () => {
                const response = await this.cdp().send<{
                  result: { value: string[] };
                }>(
                  'Runtime.evaluate',
                  {
                    expression: 'rtcWitnesses.slice().sort()',
                    returnByValue: true,
                  },
                  sessionId,
                );
                return response.result.value;
              },
              { timeout: 5_000, interval: 50 },
            )
            .toEqual(['rtc-probe closed-shadow OPEN', 'rtc-probe nested OPEN']);
          await new Promise((resolve) => setTimeout(resolve, 400));
        } finally {
          await shutdown.call(this);
        }
      });
    try {
      const service = new HtmlReplyPreview(makeTempDir('html-preview-rtc-'));
      const result = await service.render({ html, height: 400 }, 800, 'dark');
      expect(result.contentHeight).toBeGreaterThan(0);
      expect(
        packets,
        'preview must emit no ICE packets to loopback or the host LAN interface',
      ).toEqual([0, 0]);
      process.stdout.write(
        `Preview ICE listener results: loopback=${packets[0]}, LAN=${packets[1]} (${lan}); nested + closed-shadow RTC attempts executed\n`,
      );
    } finally {
      openSpy.mockRestore();
      shutdownSpy.mockRestore();
    }
  } finally {
    for (const socket of sockets) socket.close();
  }
}, 30000);

/**
 * The abort probe records a fact and never gates: any browser death during
 * its one action (any signal, any non-zero exit, a closed pipe) is "aborts",
 * an answer from the frame is "survives", and anything else means the probe
 * did not run.
 */
function classifyAbortProbe(outcome: {
  answer?: unknown;
  exitReason?: string;
  error?: unknown;
}): 'aborts' | 'survives' | undefined {
  if (outcome.answer === 'survives') return 'survives';
  if (outcome.exitReason !== undefined) return 'aborts';
  if (outcome.error instanceof CdpTransportClosedError) return 'aborts';
  return undefined;
}

test('the abort probe classifies every browser death as aborts and an answer as survives', () => {
  const exited = (detail: string) => ({
    error: new Error('The browser host is no longer running'),
    exitReason: `browser process exited (${detail}): tail`,
  });
  expect(classifyAbortProbe(exited('code none, signal SIGABRT'))).toBe(
    'aborts',
  );
  expect(classifyAbortProbe(exited('code none, signal SIGTRAP'))).toBe(
    'aborts',
  );
  expect(classifyAbortProbe(exited('code none, signal SIGILL'))).toBe('aborts');
  expect(classifyAbortProbe(exited('code none, signal SIGSEGV'))).toBe(
    'aborts',
  );
  expect(classifyAbortProbe(exited('code 133, signal none'))).toBe('aborts');
  expect(
    classifyAbortProbe({
      error: new CdpTransportClosedError('Runtime.evaluate', 'pipe ended'),
    }),
  ).toBe('aborts');
  expect(classifyAbortProbe({ answer: 'survives' })).toBe('survives');
  expect(classifyAbortProbe({ error: new Error('evaluation failed') })).toBe(
    undefined,
  );
});

test('records whether the installed Chromium still aborts when an about:blank page adds a sandboxed srcdoc frame (#4917)', async (context) => {
  // The preview serves its bootstrap page only because of this abort. The
  // run log shows the day Chromium stops aborting, so that reason can be
  // revisited; neither answer fails the run.
  const executablePath = new ChromiumAcquisition(
    makeTempDir('html-preview-abort-probe-home-'),
  ).resolveExecutable();
  if (!executablePath) return context.skip('no Chromium for the abort probe');
  const host = new ChromiumServerHost({
    executablePath,
    launchTimeoutMs: 15_000,
    denyHostResolution: true,
    egressPolicy: {
      listeners: () => ({ ports: [], hostnames: [] }),
      interfaceAddresses: () => [],
      reach: { kind: 'none' },
    },
  });
  let version = 'unknown';
  const outcome: { answer?: unknown; exitReason?: string; error?: unknown } =
    {};
  try {
    const target = await host.openTarget({
      profileDir: makeTempDir('html-preview-abort-probe-'),
      viewport: { width: 400, height: 300, deviceScaleFactor: 1 },
    });
    const send = <T>(expression: string) =>
      host
        .cdp()
        .send<{ result: { value?: T } }>(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true },
          target.cdpSessionId,
        );
    version =
      (await send<string>('navigator.userAgent')).result.value?.match(
        /Chrome\/[0-9.]+/,
      )?.[0] ?? 'unknown';
    try {
      outcome.answer = (
        await send<string>(
          `new Promise(resolve=>{const frame=document.createElement('iframe');frame.sandbox='allow-scripts';frame.srcdoc='<script>parent.postMessage(1,"*")<\\/script>';addEventListener('message',()=>resolve('survives'));document.body.append(frame)})`,
        )
      ).result.value;
    } catch (error) {
      outcome.error = error;
      for (let i = 0; i < 100 && host.exited === undefined; i++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      outcome.exitReason = host.exited;
    }
  } finally {
    await host.shutdown().catch(() => {});
  }
  const verdict = classifyAbortProbe(outcome);
  process.stdout.write(
    `Chromium about:blank + sandboxed srcdoc frame probe: ${verdict ?? 'did not run'} (${version}, ${executablePath})\n`,
  );
  if (!verdict) throw outcome.error ?? new Error('abort probe did not run');
}, 30_000);

test('one real render requests nothing but the served bootstrap document', async () => {
  // Chrome's own update and account requests are not on the preview target's
  // session, so watching that session's Network events counts only what the
  // preview page and its frame ask for. The frame's own process is a separate
  // target; its srcdoc makes no request.
  const urls: string[] = [];
  const load = (
    ChromiumServerHost.prototype as unknown as {
      loadServedDocument: (...args: unknown[]) => Promise<void>;
    }
  ).loadServedDocument;
  const spy = vi
    .spyOn(
      ChromiumServerHost.prototype as unknown as {
        loadServedDocument: (...args: unknown[]) => Promise<void>;
      },
      'loadServedDocument',
    )
    .mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const [running, , sessionId] = args as [
        { launch: { transport: CdpPipeTransport } },
        string,
        string,
      ];
      const transport = running.launch.transport;
      transport.on('Network.requestWillBeSent', (params, eventSessionId) => {
        const url = (params as { request?: { url?: unknown } })?.request?.url;
        if (eventSessionId === sessionId && typeof url === 'string')
          urls.push(url);
      });
      await transport.send('Network.enable', {}, sessionId);
      return load.apply(this, args);
    });
  try {
    const service = new HtmlReplyPreview(makeTempDir('html-preview-requests-'));
    const result = await service.render(
      { html: '<h1>requests</h1>', height: 400 },
      800,
      'dark',
    );
    expect(result.contentHeight).toBeGreaterThan(0);
  } finally {
    spy.mockRestore();
  }
  // data: URLs (the inert icon) never leave the browser.
  expect(urls.filter((url) => !url.startsWith('data:'))).toEqual([
    SERVED_DOCUMENT_URL,
  ]);
}, 30_000);
