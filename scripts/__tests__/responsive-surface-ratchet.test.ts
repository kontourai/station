import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  discoverResponsiveActionSurfaces,
  discoverResponsiveSurfaces,
  validateResponsiveSurfaceInventory,
} from '../responsive-surface-ratchet.mjs';

describe('responsive surface inventory', () => {
  it('classifies every modal, drawer, and popover source exactly once', () => {
    expect(discoverResponsiveSurfaces().length).toBeGreaterThan(20);
    expect(validateResponsiveSurfaceInventory()).toMatchObject({
      total: discoverResponsiveSurfaces().length,
      actionTotal: discoverResponsiveActionSurfaces().length,
    });
    expect(discoverResponsiveActionSurfaces().length).toBeGreaterThan(40);
  });

  it('keeps the global mobile action floor aligned with discovery vocabulary', () => {
    const css = readFileSync('src-ui/src/index.css', 'utf8');
    for (const token of ['__actions', '__footer', '__toolbar']) {
      expect(css).toContain(`[class*="${token}"]`);
    }
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('flex-wrap: wrap');
  });
});
