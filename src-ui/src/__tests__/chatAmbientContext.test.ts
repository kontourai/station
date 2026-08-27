/**
 * @vitest-environment jsdom
 *
 * #685 — ambient context is delivered out-of-band, never spliced into the
 * typed message. These tests cover the send-path decision helper
 * (`ambientContextForSend`) and the context providers that feed it
 * (timezone enabled/disabled, geolocation), including the `[`-prefix and
 * slash-command short-circuits.
 */
import { contextRegistry } from '@kontourai/station-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { geolocationContextProvider } from '../providers/context/GeolocationContextProvider';
import { timezoneContextProvider } from '../providers/context/TimezoneContextProvider';
import { ambientContextForSend } from '../utils/chatAmbientContext';

describe('ambientContextForSend', () => {
  it('passes the composed context through for a normal send', () => {
    expect(
      ambientContextForSend('[Timezone: America/Denver]', 'what time is it?'),
    ).toBe('[Timezone: America/Denver]');
  });

  it('returns undefined when context is disabled (null/empty composition)', () => {
    expect(ambientContextForSend(null, 'hello')).toBeUndefined();
    expect(ambientContextForSend(undefined, 'hello')).toBeUndefined();
    expect(ambientContextForSend('', 'hello')).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(ambientContextForSend('[Timezone: X]', '')).toBeUndefined();
  });

  it('short-circuits `[`-prefixed input (legacy prefixed messages send untouched)', () => {
    expect(
      ambientContextForSend('[Timezone: X]', '[Timezone: Y]\nold style'),
    ).toBeUndefined();
  });

  it('short-circuits slash commands so they still route to the slash handler', () => {
    expect(ambientContextForSend('[Timezone: X]', '/mcp')).toBeUndefined();
  });
});

describe('timezone context provider feed', () => {
  afterEach(() => {
    timezoneContextProvider.enabled = true;
  });

  it('is enabled by default and yields a [Timezone: …] context', () => {
    const ctx = timezoneContextProvider.getContext();
    expect(ctx).toMatch(/^\[Timezone: .+\]$/);
    expect(ambientContextForSend(ctx, 'what time is it?')).toBe(ctx);
  });

  it('yields no context when disabled, so the send carries none', () => {
    timezoneContextProvider.enabled = false;
    expect(timezoneContextProvider.getContext()).toBeNull();
    expect(
      ambientContextForSend(timezoneContextProvider.getContext(), 'hello'),
    ).toBeUndefined();
  });
});

describe('geolocation context provider feed', () => {
  afterEach(() => {
    geolocationContextProvider.enabled = false;
  });

  function stubGeolocation() {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition: (
          onSuccess: (pos: {
            coords: { latitude: number; longitude: number };
          }) => void,
        ) => {
          onSuccess({ coords: { latitude: 39.7392, longitude: -104.9903 } });
          return 1;
        },
        clearWatch: () => {},
      },
    });
  }

  it('yields a [My location: …] context once enabled with coordinates', () => {
    stubGeolocation();
    geolocationContextProvider.enabled = true;
    const ctx = geolocationContextProvider.getContext();
    expect(ctx).toBe('[My location: 39.73920, -104.99030]');
    expect(ambientContextForSend(ctx, 'where am I?')).toBe(ctx);
  });

  it('is disabled by default and yields no context', () => {
    expect(geolocationContextProvider.getContext()).toBeNull();
  });
});

describe('registry composition feed', () => {
  afterEach(() => {
    contextRegistry.unregister('timezone');
    contextRegistry.unregister('geolocation');
    timezoneContextProvider.enabled = true;
    geolocationContextProvider.enabled = false;
  });

  it('joins enabled providers with newlines and flows through the helper', () => {
    contextRegistry.register(timezoneContextProvider);
    contextRegistry.register(geolocationContextProvider);
    const composed = contextRegistry.getComposedContext();
    expect(composed).toMatch(/^\[Timezone: .+\]$/);
    expect(ambientContextForSend(composed, 'what time is it?')).toBe(composed);
  });
});
