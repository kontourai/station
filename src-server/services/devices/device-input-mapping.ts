import type {
  LiveSurfaceDeviceButton,
  LiveSurfaceFrameRotation,
  LiveSurfaceOrientation,
} from '@kontourai/station-contracts/live-surface';
import type { MobileDevicePlatform } from '@kontourai/station-contracts/mobile-device';

/**
 * Pure mappings from live-surface input to the device hub's input protocol
 * (#1970). Nothing here sends anything; the producer does.
 *
 * The hub's two helpers speak different protocols (from t3code's
 * packages/client-runtime/src/device/stream.ts and the hub's own sources):
 * - iOS (serve-sim helper socket): binary `[tag][json]` packets. Touch
 *   `{type:'begin'|'move'|'end', x, y}` in the RAW framebuffer's unit square,
 *   hardware button `{button}`, key `{type:'down'|'up', usage}` (a USB HID
 *   usage), orientation `{orientation}`.
 * - Android (serve-emu socket): JSON. Touch `{type:'touch', action, x, y}`,
 *   buttons `{type:'home'|'back'|'recents'|'power'}`, key
 *   `{type:'key', keycode, action}`, text `{type:'text', text}`.
 *
 * Adapted from t3code (MIT License, Copyright (c) 2026 T3 Tools Inc.):
 * the HID usage table, the Android keycode table and the rotated-point
 * remap (`rawPoint`).
 */

export const IOS_MSG_TOUCH = 0x03;
export const IOS_MSG_BUTTON = 0x04;
export const IOS_MSG_KEY = 0x06;
export const IOS_MSG_ORIENTATION = 0x07;
export const IOS_MSG_HARDWARE_KEYBOARD = 0x0d;
export const IOS_TAG_SCREEN_CONFIG = 0x82;

export type IosHelperOrientation =
  | 'portrait'
  | 'landscape_left'
  | 'portrait_upside_down'
  | 'landscape_right';

const TO_IOS_ORIENTATION: Record<LiveSurfaceOrientation, IosHelperOrientation> =
  {
    portrait: 'portrait',
    'landscape-left': 'landscape_left',
    'portrait-upside-down': 'portrait_upside_down',
    'landscape-right': 'landscape_right',
  };

export function toIosOrientation(
  orientation: LiveSurfaceOrientation,
): IosHelperOrientation {
  return TO_IOS_ORIENTATION[orientation];
}

export function fromIosOrientation(
  value: unknown,
): LiveSurfaceOrientation | undefined {
  for (const [ours, theirs] of Object.entries(TO_IOS_ORIENTATION))
    if (theirs === value) return ours as LiveSurfaceOrientation;
  return undefined;
}

/**
 * How far clockwise a viewer turns a frame to show the device upright.
 * A frame that is already wider than tall is already landscape (the helper
 * rotated it), so it needs no turn; a portrait framebuffer from a device held
 * sideways does. Android's encoder restarts at the rotated size, so its
 * frames never need turning.
 */
export function frameRotationFor(
  platform: MobileDevicePlatform,
  orientation: LiveSurfaceOrientation | undefined,
  frame: { width: number; height: number },
): LiveSurfaceFrameRotation {
  if (platform !== 'ios' || !orientation || frame.width > frame.height)
    return 0;
  switch (orientation) {
    case 'landscape-left':
      return 90;
    case 'landscape-right':
      return 270;
    case 'portrait-upside-down':
      return 180;
    default:
      return 0;
  }
}

/** A point in the unit square (0..1 on each axis). */
export interface UnitPoint {
  x: number;
  y: number;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Map a live-surface pointer (surface pixels of the frame AS SHOWN, i.e.
 * after the viewer applied `rotation`) to the unit square of the RAW frame
 * the device helper addresses.
 *
 * `raw` is the frame's encoded size (header width/height). Surface pixels
 * are image pixels (the device producer publishes deviceScaleFactor 1), so
 * the shown size is `raw` with the axes swapped for a quarter turn.
 */
export function surfacePointToRawUnit(
  point: { x: number; y: number },
  raw: { width: number; height: number },
  rotation: LiveSurfaceFrameRotation,
): UnitPoint {
  const quarter = rotation === 90 || rotation === 270;
  const shownWidth = quarter ? raw.height : raw.width;
  const shownHeight = quarter ? raw.width : raw.height;
  const x = clampUnit(point.x / shownWidth);
  const y = clampUnit(point.y / shownHeight);
  // The shown frame is the raw one turned clockwise by `rotation`; undo it.
  switch (rotation) {
    case 90:
      return { x: y, y: 1 - x };
    case 180:
      return { x: 1 - x, y: 1 - y };
    case 270:
      return { x: 1 - y, y: x };
    default:
      return { x, y };
  }
}

/** How far a cancel slides, in the unit square: well past tap slop. */
export const CANCEL_SLIDE_DISTANCE = 0.06;
const CANCEL_SLIDE_STEPS = 4;

/**
 * The path a held touch slides along so it ENDS without tapping (see the
 * producer's `cancelHeldInput`); the last point is where it lifts.
 *
 * Neither helper protocol has a touch-cancel (serve-emu accepts touch
 * actions `down|move|up` only; serve-sim `begin|move|end`). So a cancel
 * slides a short way PARALLEL to the nearest screen edge, in small steps,
 * and lifts: far enough past tap slop that nothing is tapped where it was
 * pressed, short and edge-parallel so it does not read as an edge swipe
 * (home, app switcher, notification shade are all swipes AWAY from an
 * edge). What remains: it can still nudge a scroll view or a slider under
 * the finger by that distance.
 */
export function cancelSlidePath(press: UnitPoint): UnitPoint[] {
  const toLeft = press.x;
  const toRight = 1 - press.x;
  const toTop = press.y;
  const toBottom = 1 - press.y;
  // A corner (a tie) counts as top/bottom: a horizontal slide there.
  const nearestIsSide = Math.min(toLeft, toRight) < Math.min(toTop, toBottom);
  // Parallel to a side edge is vertical; to the top/bottom, horizontal.
  // Slide toward whichever way has more room.
  const along = nearestIsSide ? 'y' : 'x';
  const direction = press[along] <= 0.5 ? 1 : -1;
  const path: UnitPoint[] = [];
  for (let step = 1; step <= CANCEL_SLIDE_STEPS; step += 1) {
    const offset =
      (direction * CANCEL_SLIDE_DISTANCE * step) / CANCEL_SLIDE_STEPS;
    path.push(
      along === 'y'
        ? { x: press.x, y: press.y + offset }
        : { x: press.x + offset, y: press.y },
    );
  }
  return path;
}

/**
 * The typed hardware-button command for a platform, or null when the
 * platform has no such button. This is a WHITELIST: only these names ever
 * reach a helper, whatever else arrives.
 */
export type DeviceButtonCommand =
  | { platform: 'ios'; button: 'home' | 'lock' | 'app_switcher' }
  | { platform: 'android'; type: 'home' | 'back' | 'recents' | 'power' };

const IOS_BUTTONS: Partial<
  Record<LiveSurfaceDeviceButton, 'home' | 'lock' | 'app_switcher'>
> = { home: 'home', power: 'lock', recents: 'app_switcher' };

const ANDROID_BUTTONS: Record<
  LiveSurfaceDeviceButton,
  'home' | 'back' | 'recents' | 'power'
> = { home: 'home', back: 'back', recents: 'recents', power: 'power' };

export function deviceButtonCommand(
  platform: MobileDevicePlatform,
  button: unknown,
): DeviceButtonCommand | null {
  if (typeof button !== 'string') return null;
  if (platform === 'ios') {
    const name = Object.hasOwn(IOS_BUTTONS, button)
      ? IOS_BUTTONS[button as LiveSurfaceDeviceButton]
      : undefined;
    return name ? { platform: 'ios', button: name } : null;
  }
  const type = Object.hasOwn(ANDROID_BUTTONS, button)
    ? ANDROID_BUTTONS[button as LiveSurfaceDeviceButton]
    : undefined;
  return type ? { platform: 'android', type } : null;
}

const HID_USAGE_BY_CODE: Readonly<Record<string, number>> = {
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  Delete: 0x4c,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  ControlLeft: 0xe0,
  ShiftLeft: 0xe1,
  AltLeft: 0xe2,
  MetaLeft: 0xe3,
  ControlRight: 0xe4,
  ShiftRight: 0xe5,
  AltRight: 0xe6,
  MetaRight: 0xe7,
};

export const HID_SHIFT = 0xe1;

/** The USB HID usage for a `KeyboardEvent.code`, or null. */
export function hidUsageForCode(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) return 0x04 + (code.charCodeAt(3) - 65);
  if (/^Digit[1-9]$/.test(code)) return 0x1e + (code.charCodeAt(5) - 49);
  if (code === 'Digit0') return 0x27;
  return Object.hasOwn(HID_USAGE_BY_CODE, code)
    ? HID_USAGE_BY_CODE[code]!
    : null;
}

/** US-layout character → HID usage + shift, for typing text on iOS. */
const SHIFTED: Readonly<Record<string, string>> = {
  '!': 'Digit1',
  '@': 'Digit2',
  '#': 'Digit3',
  $: 'Digit4',
  '%': 'Digit5',
  '^': 'Digit6',
  '&': 'Digit7',
  '*': 'Digit8',
  '(': 'Digit9',
  ')': 'Digit0',
  _: 'Minus',
  '+': 'Equal',
  '{': 'BracketLeft',
  '}': 'BracketRight',
  '|': 'Backslash',
  ':': 'Semicolon',
  '"': 'Quote',
  '~': 'Backquote',
  '<': 'Comma',
  '>': 'Period',
  '?': 'Slash',
};
const PLAIN: Readonly<Record<string, string>> = {
  ' ': 'Space',
  '\n': 'Enter',
  '\t': 'Tab',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
};

export function hidStrokeForCharacter(
  character: string,
): { usage: number; shift: boolean } | null {
  if (/^[a-z]$/.test(character))
    return { usage: 0x04 + (character.charCodeAt(0) - 97), shift: false };
  if (/^[A-Z]$/.test(character))
    return { usage: 0x04 + (character.charCodeAt(0) - 65), shift: true };
  if (/^[0-9]$/.test(character))
    return {
      usage: hidUsageForCode(`Digit${character}`)!,
      shift: false,
    };
  if (Object.hasOwn(PLAIN, character))
    return { usage: hidUsageForCode(PLAIN[character]!)!, shift: false };
  if (Object.hasOwn(SHIFTED, character))
    return { usage: hidUsageForCode(SHIFTED[character]!)!, shift: true };
  return null;
}

const ANDROID_KEYCODE_BY_KEY: Readonly<Record<string, number>> = {
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Tab: 61,
  Enter: 66,
  Backspace: 67,
  Delete: 112,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
  Escape: 111,
};

export function androidKeycodeForKey(key: string): number | null {
  return Object.hasOwn(ANDROID_KEYCODE_BY_KEY, key)
    ? ANDROID_KEYCODE_BY_KEY[key]!
    : null;
}

/** Tagged serve-sim packet: `[tag][json]`. */
export function iosPacket(tag: number, payload: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const out = new Uint8Array(1 + json.length);
  out[0] = tag;
  out.set(json, 1);
  return out;
}
