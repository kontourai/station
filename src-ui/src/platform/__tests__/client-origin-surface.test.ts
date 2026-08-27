import { describe, expect, it } from 'vitest';
import { clientOriginSurfaceForProfile } from '../client-origin-surface.js';

describe('client origin platform surface', () => {
  it.each([
    [{ isMobile: true, isDesktop: false }, 'mobile'],
    [{ isMobile: false, isDesktop: true }, 'desktop'],
    [{ isMobile: false, isDesktop: false }, 'web'],
  ] as const)('classifies trusted platform profile %#', (profile, expected) => {
    expect(clientOriginSurfaceForProfile(profile)).toBe(expected);
  });
});
