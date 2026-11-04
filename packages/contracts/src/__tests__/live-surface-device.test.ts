import { describe, expect, test } from 'vitest';
import {
  parseLiveSurfaceFold,
  parseLiveSurfaceFrameHeader,
  parseLiveSurfaceInput,
  parseLiveSurfaceStreamState,
} from '../live-surface.js';

/** #1970: the device extensions to the live-surface grammar, parsed strictly. */

describe('device input kinds', () => {
  test.each(['home', 'back', 'recents', 'power'])(
    'device-button %s',
    (button) => {
      expect(parseLiveSurfaceInput({ kind: 'device-button', button })).toEqual({
        kind: 'device-button',
        button,
      });
    },
  );

  test.each([
    'portrait',
    'landscape-left',
    'portrait-upside-down',
    'landscape-right',
  ])('rotate %s', (orientation) => {
    expect(parseLiveSurfaceInput({ kind: 'rotate', orientation })).toEqual({
      kind: 'rotate',
      orientation,
    });
  });

  test.each([
    { kind: 'device-button', button: 'reboot' },
    { kind: 'device-button', button: 'toString' },
    { kind: 'device-button' },
    { kind: 'device-button', button: 'home', extra: 1 },
    { kind: 'rotate', orientation: 'sideways' },
    { kind: 'rotate', orientation: 90 },
    { kind: 'rotate', orientation: 'portrait', button: 'home' },
  ])('refuses %o', (value) => {
    expect(parseLiveSurfaceInput(value)).toBeNull();
  });
});

const header = {
  surfaceId: 'device:ios:1',
  seq: 1,
  epoch: 0,
  codec: 'jpeg',
  width: 400,
  height: 800,
  deviceScaleFactor: 1,
  capturedAt: 1,
};

describe('frame rotation', () => {
  test('a quarter turn is carried; 0 is the same as absent', () => {
    expect(
      parseLiveSurfaceFrameHeader({ ...header, rotation: 90 }),
    ).toMatchObject({ rotation: 90 });
    expect(
      parseLiveSurfaceFrameHeader({ ...header, rotation: 0 }),
    ).not.toHaveProperty('rotation');
  });

  test.each([45, '90', -90, 360])('refuses rotation %o', (rotation) => {
    expect(parseLiveSurfaceFrameHeader({ ...header, rotation })).toBeNull();
  });
});

describe('producer status in the stream state', () => {
  const state = {
    surfaceId: 'device:ios:1',
    lease: {
      surfaceId: 'device:ios:1',
      epoch: 0,
      holder: null,
      expiresAt: null,
    },
    effectiveParams: {
      maxFps: 10,
      quality: 70,
      maxWidth: 1280,
      maxHeight: 1280,
    },
  };

  test('input and video liveness, orientation and host are carried', () => {
    expect(
      parseLiveSurfaceStreamState({
        ...state,
        inputChannel: 'reconnecting',
        videoMode: 'snapshot-poll',
        videoDegradedReason: 'decoder-unavailable',
        orientation: 'landscape-left',
        hostId: 'local',
      }),
    ).toMatchObject({
      inputChannel: 'reconnecting',
      videoMode: 'snapshot-poll',
      videoDegradedReason: 'decoder-unavailable',
      orientation: 'landscape-left',
      hostId: 'local',
    });
  });

  test.each([
    { inputChannel: 'maybe' },
    { videoMode: 'webrtc' },
    { videoDegradedReason: 'slow' },
    { orientation: 'up' },
    { hostId: '../etc' },
    { hostId: '' },
  ])('refuses %o', (bad) => {
    expect(parseLiveSurfaceStreamState({ ...state, ...bad })).toBeNull();
  });
});

describe('foldables', () => {
  test.each([
    { kind: 'fold', posture: 'book' },
    { kind: 'fold', posture: 'tent' },
    { kind: 'fold', hingeAngle: 0 },
    { kind: 'fold', hingeAngle: 112.5 },
    { kind: 'fold', hingeAngle: 180 },
    { kind: 'fold', tableMode: true },
  ])('fold input %o', (value) => {
    expect(parseLiveSurfaceInput(value)).toEqual(value);
  });

  test.each([
    { kind: 'fold' },
    { kind: 'fold', posture: 'flipped' },
    { kind: 'fold', hingeAngle: -1 },
    { kind: 'fold', hingeAngle: 181 },
    { kind: 'fold', hingeAngle: Number.NaN },
    { kind: 'fold', hingeAngle: '90' },
    { kind: 'fold', tableMode: 'yes' },
    // Exactly one control per event.
    { kind: 'fold', posture: 'book', hingeAngle: 90 },
    { kind: 'fold', posture: 'book', extra: 1 },
  ])('refuses fold input %o', (value) => {
    expect(parseLiveSurfaceInput(value)).toBeNull();
  });

  const fold = {
    activeDisplay: 'inner',
    hingeAngle: 90,
    posture: 'book',
    postures: ['closed', 'open', 'book'],
    angleControl: true,
  };

  test('fold state is carried by a stream state record', () => {
    const parsed = parseLiveSurfaceStreamState({
      surfaceId: 'device:ios:1',
      lease: {
        surfaceId: 'device:ios:1',
        epoch: 0,
        holder: null,
        expiresAt: null,
      },
      effectiveParams: {
        maxFps: 10,
        quality: 70,
        maxWidth: 1280,
        maxHeight: 1280,
      },
      fold,
    });
    expect(parsed?.fold).toEqual(fold);
  });

  test.each([
    { ...fold, activeDisplay: 'back' },
    { ...fold, hingeAngle: 200 },
    { ...fold, posture: 'flat' },
    { ...fold, postures: ['closed', 'sideways'] },
    { ...fold, angleControl: 'yes' },
    { ...fold, tableMode: 1 },
    { ...fold, extra: true },
  ])('refuses fold state %o', (value) => {
    expect(parseLiveSurfaceFold(value)).toBeNull();
  });

  test('unknown hinge and posture are null, not absent', () => {
    expect(
      parseLiveSurfaceFold({ ...fold, hingeAngle: null, posture: null }),
    ).toMatchObject({ hingeAngle: null, posture: null });
  });

  test('a frame names the display it shows', () => {
    expect(
      parseLiveSurfaceFrameHeader({ ...header, display: 'cover' }),
    ).toMatchObject({ display: 'cover' });
    expect(
      parseLiveSurfaceFrameHeader({ ...header, display: 'back' }),
    ).toBeNull();
  });
});
