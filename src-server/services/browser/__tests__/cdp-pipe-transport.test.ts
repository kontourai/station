import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import {
  CdpPipeTransport,
  CdpProtocolError,
  CdpTransportClosedError,
} from '../cdp-pipe-transport.js';

/** In-memory stand-in for Chromium's fd 3 (we write) and fd 4 (we read). */
function fakePipe() {
  const written: Buffer[] = [];
  const writable = Object.assign(new EventEmitter(), {
    ended: false,
    write(chunk: Buffer) {
      written.push(chunk);
      return true;
    },
    end() {
      writable.ended = true;
    },
  });
  const readable = Object.assign(new EventEmitter(), {
    destroyed: false,
    destroy() {
      readable.destroyed = true;
    },
  });
  const sent = () =>
    Buffer.concat(written)
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const deliver = (...messages: object[]) =>
    readable.emit(
      'data',
      Buffer.from(messages.map((m) => `${JSON.stringify(m)}\0`).join('')),
    );
  return { writable, readable, written, sent, deliver };
}

describe('CdpPipeTransport framing and correlation', () => {
  test('writes NUL-terminated JSON with increasing ids and sessionId when given', async () => {
    const pipe = fakePipe();
    const transport = new CdpPipeTransport(pipe.writable, pipe.readable);
    const a = transport.send('Browser.getVersion');
    const b = transport.send('Page.navigate', { url: 'about:blank' }, 'S1');
    expect(pipe.written.every((chunk) => chunk.at(-1) === 0)).toBe(true);
    expect(pipe.sent()).toEqual([
      { id: 1, method: 'Browser.getVersion' },
      {
        id: 2,
        method: 'Page.navigate',
        params: { url: 'about:blank' },
        sessionId: 'S1',
      },
    ]);
    // Out-of-order responses settle the matching request only.
    pipe.deliver({ id: 2, result: { frameId: 'F' }, sessionId: 'S1' });
    pipe.deliver({ id: 1, result: { product: 'Chrome/1' } });
    await expect(b).resolves.toEqual({ frameId: 'F' });
    await expect(a).resolves.toEqual({ product: 'Chrome/1' });
  });

  test('reassembles a frame split across chunks and several frames in one chunk', async () => {
    const pipe = fakePipe();
    const transport = new CdpPipeTransport(pipe.writable, pipe.readable);
    const a = transport.send('A');
    const b = transport.send('B');
    const c = transport.send('C');
    const whole = `${JSON.stringify({ id: 1, result: { v: 'one' } })}\0${JSON.stringify({ id: 2, result: { v: 'two' } })}\0${JSON.stringify({ id: 3, result: { v: 'three' } })}\0`;
    // Byte-by-byte delivery exercises every split point.
    for (const byte of Buffer.from(whole))
      pipe.readable.emit('data', Buffer.of(byte));
    await expect(Promise.all([a, b, c])).resolves.toEqual([
      { v: 'one' },
      { v: 'two' },
      { v: 'three' },
    ]);
  });

  test('a protocol error rejects with CdpProtocolError carrying method and code', async () => {
    const pipe = fakePipe();
    const transport = new CdpPipeTransport(pipe.writable, pipe.readable);
    const request = transport.send('Target.attachToTarget', { targetId: 'x' });
    pipe.deliver({
      id: 1,
      error: { code: -32000, message: 'No target with given id' },
    });
    const error = await request.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CdpProtocolError);
    expect(error).toMatchObject({
      method: 'Target.attachToTarget',
      code: -32000,
      protocolMessage: 'No target with given id',
    });
  });

  test('routes events with their sessionId; onSession filters to one session', () => {
    const pipe = fakePipe();
    const transport = new CdpPipeTransport(pipe.writable, pipe.readable);
    const all: Array<[unknown, string | undefined]> = [];
    const s1: unknown[] = [];
    transport.on('Page.frameNavigated', (params, sessionId) =>
      all.push([params, sessionId]),
    );
    const off = transport.onSession('S1', 'Page.frameNavigated', (params) =>
      s1.push(params),
    );
    pipe.deliver(
      { method: 'Page.frameNavigated', params: { n: 1 }, sessionId: 'S1' },
      { method: 'Page.frameNavigated', params: { n: 2 }, sessionId: 'S2' },
      { method: 'Page.frameNavigated', params: { n: 3 } },
    );
    expect(all).toEqual([
      [{ n: 1 }, 'S1'],
      [{ n: 2 }, 'S2'],
      [{ n: 3 }, undefined],
    ]);
    expect(s1).toEqual([{ n: 1 }]);
    off();
    pipe.deliver({
      method: 'Page.frameNavigated',
      params: { n: 4 },
      sessionId: 'S1',
    });
    expect(s1).toEqual([{ n: 1 }]);
  });

  test('a throwing listener does not starve other listeners or later responses', async () => {
    const pipe = fakePipe();
    const transport = new CdpPipeTransport(pipe.writable, pipe.readable);
    const seen: unknown[] = [];
    transport.on('E', () => {
      throw new Error('boom');
    });
    transport.on('E', (params) => seen.push(params));
    const request = transport.send('M');
    pipe.deliver({ method: 'E', params: { ok: true } }, { id: 1, result: {} });
    await expect(request).resolves.toEqual({});
    expect(seen).toEqual([{ ok: true }]);
  });
});

describe('CdpPipeTransport close semantics', () => {
  test('pipe end rejects every pending request and settles `closed`', async () => {
    const pipe = fakePipe();
    const transport = new CdpPipeTransport(pipe.writable, pipe.readable);
    const a = transport.send('A');
    const b = transport.send('B', {}, 'S1');
    pipe.readable.emit('end');
    await expect(a).rejects.toBeInstanceOf(CdpTransportClosedError);
    await expect(b).rejects.toMatchObject({
      method: 'B',
      reason: 'pipe ended',
    });
    await expect(transport.closed).resolves.toBeUndefined();
    expect(transport.closeReason).toBe('pipe ended');
  });

  test('explicit close rejects pending, ends the write side, and refuses later sends', async () => {
    const pipe = fakePipe();
    const transport = new CdpPipeTransport(pipe.writable, pipe.readable);
    const pending = transport.send('A');
    await transport.close();
    await expect(pending).rejects.toBeInstanceOf(CdpTransportClosedError);
    expect(pipe.writable.ended).toBe(true);
    expect(pipe.readable.destroyed).toBe(true);
    await expect(transport.send('Later')).rejects.toMatchObject({
      method: 'Later',
      reason: 'closed by caller',
    });
    // No bytes were written for the refused send.
    expect(pipe.sent().map((m) => m.method)).toEqual(['A']);
  });

  test('read and write errors close the transport and reject pending', async () => {
    for (const side of ['readable', 'writable'] as const) {
      const pipe = fakePipe();
      const transport = new CdpPipeTransport(pipe.writable, pipe.readable);
      const pending = transport.send('A');
      pipe[side].emit('error', new Error('EPIPE'));
      await expect(pending).rejects.toBeInstanceOf(CdpTransportClosedError);
      expect(transport.closeReason).toMatch(/EPIPE/);
    }
  });

  test('an oversized incoming frame closes the transport instead of buffering it', async () => {
    const pipe = fakePipe();
    const transport = new CdpPipeTransport(pipe.writable, pipe.readable, {
      maxMessageBytes: 64,
    });
    const pending = transport.send('A');
    // No NUL yet: the bound must hold for a frame still being accumulated.
    pipe.readable.emit('data', Buffer.from('{"id":1,"result":{"x":"'));
    pipe.readable.emit('data', Buffer.alloc(64, 0x61));
    await expect(pending).rejects.toMatchObject({
      reason: 'incoming CDP message exceeded 64 bytes',
    });
    expect(transport.isClosed).toBe(true);
  });

  test('a complete but oversized frame in one chunk is refused too', async () => {
    const pipe = fakePipe();
    const transport = new CdpPipeTransport(pipe.writable, pipe.readable, {
      maxMessageBytes: 32,
    });
    const pending = transport.send('A');
    pipe.deliver({ id: 1, result: { padding: 'x'.repeat(64) } });
    await expect(pending).rejects.toBeInstanceOf(CdpTransportClosedError);
  });

  test('a frame at exactly the bound is accepted', async () => {
    const frame = JSON.stringify({ id: 1, result: { p: '' } });
    const pipe = fakePipe();
    const transport = new CdpPipeTransport(pipe.writable, pipe.readable, {
      maxMessageBytes: Buffer.byteLength(frame),
    });
    const pending = transport.send('A');
    pipe.readable.emit('data', Buffer.from(`${frame}\0`));
    await expect(pending).resolves.toEqual({ p: '' });
  });

  test('a frame one byte over the bound is refused (max + 1)', async () => {
    const frame = JSON.stringify({ id: 1, result: { p: '' } });
    const pipe = fakePipe();
    const transport = new CdpPipeTransport(pipe.writable, pipe.readable, {
      maxMessageBytes: Buffer.byteLength(frame) - 1,
    });
    const pending = transport.send('A');
    pipe.readable.emit('data', Buffer.from(`${frame}\0`));
    await expect(pending).rejects.toBeInstanceOf(CdpTransportClosedError);
  });

  test('a corrupt (non-JSON) frame closes the transport', async () => {
    const pipe = fakePipe();
    const transport = new CdpPipeTransport(pipe.writable, pipe.readable);
    const pending = transport.send('A');
    pipe.readable.emit('data', Buffer.from('not json\0'));
    await expect(pending).rejects.toMatchObject({
      reason: 'received a CDP frame that is not JSON',
    });
  });
});
