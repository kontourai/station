/** @vitest-environment jsdom */

import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  applyBrandingTheme,
  BRANDING_FOCUS_ATTRIBUTE,
  BRANDING_THEME_STORAGE_KEY,
} from '../../lib/branding-theme';
import { BrandingThemeBridge } from '../BrandingThemeBridge';

let branding: { theme: unknown; loaded: boolean };

vi.mock('../../hooks/useBranding', () => ({
  useBranding: () => branding,
}));

const root = document.documentElement;

beforeEach(() => {
  root.setAttribute('data-theme', 'light');
  localStorage.clear();
});

afterEach(() => {
  applyBrandingTheme(root, null);
  root.removeAttribute('data-theme');
  vi.restoreAllMocks();
});

describe('BrandingThemeBridge', () => {
  test("applies the branding provider's theme to the theme-scope element", () => {
    branding = {
      loaded: true,
      theme: {
        // Flat: expanded into both modes, and readable in both.
        '--k-focus': '#3b82f6',
        light: {
          '--k-action': '#1d4ed8',
          '--k-action-contrast': '#ffffff',
        },
      },
    };
    render(<BrandingThemeBridge />);
    expect(root.style.getPropertyValue('--k-action')).toBe('#1d4ed8');
    expect(root.style.getPropertyValue('--k-action-contrast')).toBe('#ffffff');
    expect(root.style.getPropertyValue('--k-focus')).toBe('#3b82f6');
    // The theme chose a focus colour, so index.css paints the ring from it.
    expect(root.hasAttribute(BRANDING_FOCUS_ATTRIBUTE)).toBe(true);
    // The validated, expanded result is what the boot path reads next time.
    expect(
      JSON.parse(localStorage.getItem(BRANDING_THEME_STORAGE_KEY) ?? 'null'),
    ).toEqual({
      dark: { '--k-focus': '#3b82f6' },
      light: {
        '--k-focus': '#3b82f6',
        '--k-action': '#1d4ed8',
        '--k-action-contrast': '#ffffff',
      },
    });
  });

  test('keeps the default when the provider supplies a pale action pair', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    branding = {
      loaded: true,
      theme: {
        light: {
          '--k-action': '#a7f3d0',
          '--k-action-contrast': '#ffffff',
          '--k-focus': '#1d4ed8', // valid alone; all-or-nothing drops it too
        },
      },
    };
    render(<BrandingThemeBridge />);
    expect(root.style.getPropertyValue('--k-action')).toBe('');
    expect(root.style.getPropertyValue('--k-action-contrast')).toBe('');
    expect(root.style.getPropertyValue('--k-focus')).toBe('');
    expect(root.hasAttribute(BRANDING_FOCUS_ATTRIBUTE)).toBe(false);
    expect(localStorage.getItem(BRANDING_THEME_STORAGE_KEY)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'rejected (contrast) light: --k-action-contrast #ffffff on --k-action #a7f3d0',
      ),
    );
  });

  test('rejects hostile keys and values without writing them', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    branding = {
      loaded: true,
      theme: {
        '--k-bg': '#000000',
        '--k-focus': 'red; background:url(x)',
      },
    };
    render(<BrandingThemeBridge />);
    expect(root.style.getPropertyValue('--k-bg')).toBe('');
    expect(root.style.getPropertyValue('--k-focus')).toBe('');
    expect(root.getAttribute('style') ?? '').not.toContain('url(');
  });

  test('leaves the boot-applied theme alone until the server answers', () => {
    applyBrandingTheme(root, { light: { '--k-focus': '#1d4ed8' } });
    branding = { loaded: false, theme: null };
    render(<BrandingThemeBridge />);
    expect(root.style.getPropertyValue('--k-focus')).toBe('#1d4ed8');
  });

  test('clears a cached theme when the server answers with none', () => {
    applyBrandingTheme(root, { light: { '--k-focus': '#1d4ed8' } });
    localStorage.setItem(BRANDING_THEME_STORAGE_KEY, '{}');
    branding = { loaded: true, theme: null };
    render(<BrandingThemeBridge />);
    expect(root.style.getPropertyValue('--k-focus')).toBe('');
    expect(root.hasAttribute(BRANDING_FOCUS_ATTRIBUTE)).toBe(false);
    expect(localStorage.getItem(BRANDING_THEME_STORAGE_KEY)).toBeNull();
  });

  test('leaves the focus ring to the accent when the theme sets no focus colour', () => {
    branding = {
      loaded: true,
      theme: {
        light: { '--k-action': '#1d4ed8', '--k-action-contrast': '#ffffff' },
      },
    };
    render(<BrandingThemeBridge />);
    expect(root.style.getPropertyValue('--k-action')).toBe('#1d4ed8');
    expect(root.hasAttribute(BRANDING_FOCUS_ATTRIBUTE)).toBe(false);
  });

  test('marks theme focus per mode, following data-theme flips', async () => {
    branding = { loaded: true, theme: { light: { '--k-focus': '#1d4ed8' } } };
    render(<BrandingThemeBridge />);
    expect(root.hasAttribute(BRANDING_FOCUS_ATTRIBUTE)).toBe(true);
    // Dark has no theme focus, so the ring goes back to the accent there.
    root.setAttribute('data-theme', 'dark');
    await vi.waitFor(() =>
      expect(root.hasAttribute(BRANDING_FOCUS_ATTRIBUTE)).toBe(false),
    );
    root.setAttribute('data-theme', 'light');
    await vi.waitFor(() =>
      expect(root.hasAttribute(BRANDING_FOCUS_ATTRIBUTE)).toBe(true),
    );
  });
});
