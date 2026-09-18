import { describe, expect, it } from 'vitest';
import {
  clientOriginSurfaceForProfile,
  hasLocalStationForProfile,
} from '../client-origin-surface.js';

describe('client origin platform surface', () => {
  it.each([
    [{ isMobile: true, isDesktop: false }, 'mobile'],
    [{ isMobile: false, isDesktop: true }, 'desktop'],
    [{ isMobile: false, isDesktop: false }, 'web'],
  ] as const)('classifies trusted platform profile %#', (profile, expected) => {
    expect(clientOriginSurfaceForProfile(profile)).toBe(expected);
  });
});

describe('hasLocalStationForProfile', () => {
  it('is true for web (served by a Station)', () => {
    expect(hasLocalStationForProfile({ isTauri: false, isMobile: false })).toBe(
      true,
    );
  });

  it('is true for desktop Tauri (supervises a local Station)', () => {
    expect(hasLocalStationForProfile({ isTauri: true, isMobile: false })).toBe(
      true,
    );
  });

  it('is false for phone Tauri (client of some other Station)', () => {
    expect(hasLocalStationForProfile({ isTauri: true, isMobile: true })).toBe(
      false,
    );
  });
});
