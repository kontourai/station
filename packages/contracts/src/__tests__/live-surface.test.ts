import { describe, expect, test } from 'vitest';
import {
  encodeLiveSurfaceRecord,
  LIVE_SURFACE_DEFAULT_STREAM_PARAMS,
  LIVE_SURFACE_TEXT_MAX_LENGTH,
  type LiveSurfaceRecord,
  LiveSurfaceRecordDecoder,
  LiveSurfaceRecordError,
  parseLiveSurfaceControlLease,
  parseLiveSurfaceInput,
  parseLiveSurfaceInputBatch,
  parseLiveSurfaceLeaseRequest,
  parseLiveSurfaceStreamParams,
} from '../live-surface.js';

const frame: LiveSurfaceRecord = {
  kind: 'frame',
  header: {
    surfaceId: 'browser:s1',
    seq: 7,
    epoch: 2,
    codec: 'jpeg',
    width: 1280,
    height: 720,
    deviceScaleFactor: 2,
    capturedAt: 1_700_000_000_000,
  },
  body: Uint8Array.from({ length: 40_000 }, (_, i) => i % 251),
};
const state: LiveSurfaceRecord = {
  kind: 'state',
  state: {
    surfaceId: 'browser:s1',
    lease: {
      surfaceId: 'browser:s1',
      epoch: 2,
      holder: { kind: 'agent', principal: 'agent:x', sessionId: 's' },
      expiresAt: 5,
    },
    effectiveParams: { ...LIVE_SURFACE_DEFAULT_STREAM_PARAMS },
  },
};

describe('live surface record envelope', () => {
  test('round-trips across arbitrary chunk boundaries (the relay re-chunks at 16 KB)', () => {
    const bytes = new Uint8Array([
      ...encodeLiveSurfaceRecord(state),
      ...encodeLiveSurfaceRecord(frame),
      ...encodeLiveSurfaceRecord(state),
    ]);
    for (const chunkSize of [1, 7, 16 * 1024, bytes.length]) {
      const decoder = new LiveSurfaceRecordDecoder();
      const records: LiveSurfaceRecord[] = [];
      for (let offset = 0; offset < bytes.length; offset += chunkSize)
        records.push(
          ...decoder.push(bytes.subarray(offset, offset + chunkSize)),
        );
      expect(records, `chunk ${chunkSize}`).toEqual([state, frame, state]);
      expect(decoder.pendingBytes).toBe(0);
    }
  });

  test('a malformed prefix or header is fatal, not skipped', () => {
    const good = encodeLiveSurfaceRecord(frame);
    const badVersion = good.slice();
    badVersion[0] = 9;
    const badKind = good.slice();
    badKind[1] = 3;
    const hugeHeader = good.slice();
    new DataView(hugeHeader.buffer).setUint32(2, 1 << 20);
    const hugeBody = good.slice();
    new DataView(hugeBody.buffer).setUint32(6, 0xffffffff);
    for (const bytes of [badVersion, badKind, hugeHeader, hugeBody]) {
      expect(() => new LiveSurfaceRecordDecoder().push(bytes)).toThrow(
        LiveSurfaceRecordError,
      );
    }
    const wrongHeader = encodeLiveSurfaceRecord({
      ...frame,
      header: { ...frame.header, codec: 'gif' as never },
    });
    expect(() => new LiveSurfaceRecordDecoder().push(wrongHeader)).toThrow(
      'invalid frame header',
    );
  });
});

describe('live surface wire parsers', () => {
  test('input events are parsed strictly', () => {
    expect(
      parseLiveSurfaceInput({
        kind: 'pointer',
        type: 'wheel',
        x: 1.5,
        y: 2,
        deltaY: -120,
        modifiers: { shift: true },
      }),
    ).toEqual({
      kind: 'pointer',
      type: 'wheel',
      x: 1.5,
      y: 2,
      deltaY: -120,
      modifiers: { shift: true },
    });
    expect(
      parseLiveSurfaceInput({ kind: 'key', type: 'down', key: 'a', code: '' }),
    ).not.toBeNull();
    for (const bad of [
      { kind: 'pointer', type: 'down', x: -1, y: 0 },
      { kind: 'pointer', type: 'down', x: 0, y: Number.POSITIVE_INFINITY },
      { kind: 'pointer', type: 'down', x: 0, y: 0, deltaX: 3 },
      { kind: 'pointer', type: 'down', x: 0, y: 0, button: 'back' },
      { kind: 'pointer', type: 'down', x: 0, y: 0, modifiers: { hyper: true } },
      { kind: 'key', type: 'press', key: 'a', code: 'KeyA' },
      { kind: 'key', type: 'down', key: '', code: 'KeyA' },
      { kind: 'text', text: '' },
      { kind: 'text', text: 'x'.repeat(LIVE_SURFACE_TEXT_MAX_LENGTH + 1) },
      { kind: 'text', text: 'a', extra: 1 },
      [],
      null,
    ]) {
      expect(parseLiveSurfaceInput(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  test('a batch needs a valid epoch and 1..64 valid events', () => {
    const move = { kind: 'pointer', type: 'move', x: 1, y: 1 };
    expect(parseLiveSurfaceInputBatch({ epoch: 3, events: [move] })).toEqual({
      epoch: 3,
      events: [move],
    });
    expect(parseLiveSurfaceInputBatch({ epoch: 3, events: [] })).toBeNull();
    expect(
      parseLiveSurfaceInputBatch({ epoch: 3, events: Array(65).fill(move) }),
    ).toBeNull();
    expect(
      parseLiveSurfaceInputBatch({ epoch: 1.5, events: [move] }),
    ).toBeNull();
    expect(
      parseLiveSurfaceInputBatch({ epoch: 1, events: [move, { kind: 'x' }] }),
    ).toBeNull();
  });

  test('stream params refuse out-of-range values instead of clamping them', () => {
    expect(parseLiveSurfaceStreamParams({})).toEqual({
      ok: true,
      params: LIVE_SURFACE_DEFAULT_STREAM_PARAMS,
    });
    expect(
      parseLiveSurfaceStreamParams({ maxFps: '30', quality: '10' }),
    ).toEqual({
      ok: true,
      params: {
        ...LIVE_SURFACE_DEFAULT_STREAM_PARAMS,
        maxFps: 30,
        quality: 10,
      },
    });
    expect(parseLiveSurfaceStreamParams({ maxFps: '31' })).toEqual({
      ok: false,
      field: 'maxFps',
    });
    expect(parseLiveSurfaceStreamParams({ maxWidth: '1e3' })).toEqual({
      ok: false,
      field: 'maxWidth',
    });
  });

  test('lease requests cannot name an agent', () => {
    expect(parseLiveSurfaceLeaseRequest({ action: 'claim' })).toEqual({
      action: 'claim',
    });
    expect(
      parseLiveSurfaceLeaseRequest({ action: 'claim', sessionId: 's' }),
    ).toBeNull();
    expect(
      parseLiveSurfaceLeaseRequest({ action: 'release', epoch: 4 }),
    ).toEqual({ action: 'release', epoch: 4 });
    expect(parseLiveSurfaceLeaseRequest({ action: 'release' })).toBeNull();
  });

  test('a lease snapshot round-trips and rejects a malformed holder', () => {
    const lease = (state as { state: { lease: unknown } }).state.lease;
    expect(parseLiveSurfaceControlLease(lease)).toEqual(lease);
    expect(
      parseLiveSurfaceControlLease({
        ...(lease as object),
        holder: { kind: 'agent', principal: 'a' },
      }),
    ).toBeNull();
  });
});
