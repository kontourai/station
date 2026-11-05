import { afterEach, expect, test } from 'vitest';
import {
  registerFloatHost,
  requestFloat,
  requestFloatInNextChat,
  resetFloatStoreForTests,
  takeFloatRequest,
} from '../floatStore';

/** A float asked for while no chat is open (a phone: one pane at a time). */

const SOURCE = {
  kind: 'device',
  hostId: 'local',
  platform: 'ios',
  deviceId: 'D1',
  surfaceId: 'device:ios:s1',
  name: 'iPhone Duo',
} as const;

afterEach(() => resetFloatStoreForTests());

test('with no chat, a plain request is still refused', () => {
  expect(requestFloat(SOURCE)).toBe(false);
  registerFloatHost();
  expect(takeFloatRequest()).toBeNull();
});

test('the next chat to open takes a float asked for before it, once', () => {
  let taken = 0;
  requestFloatInNextChat(SOURCE, () => taken++, 1_000);
  registerFloatHost(2_000);
  const request = takeFloatRequest(2_000);
  expect(request?.source).toEqual(SOURCE);
  request?.onTaken?.();
  expect(taken).toBe(1);
  // Only that chat: a second one opening finds nothing waiting.
  registerFloatHost(3_000);
  expect(takeFloatRequest(3_000)).toBeNull();
});

test('a float asked for long before a chat opens is forgotten', () => {
  requestFloatInNextChat(SOURCE, undefined, 0);
  registerFloatHost(120_001);
  expect(takeFloatRequest(120_001)).toBeNull();
});
