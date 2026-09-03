import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('application provider order', () => {
  test('keeps onboarding and the application shell inside one toast provider', () => {
    const source = readFileSync(
      new URL('../main.tsx', import.meta.url),
      'utf8',
    );
    const toastOpen = source.indexOf('<ToastProvider>');
    const permissionOpen = source.indexOf('<PermissionManager>');
    const onboardingBoundary = source.indexOf('id="connection-recovery"');
    const toastClose = source.indexOf('</ToastProvider>');

    expect(toastOpen).toBeGreaterThan(-1);
    expect(permissionOpen).toBeGreaterThan(toastOpen);
    expect(onboardingBoundary).toBeGreaterThan(permissionOpen);
    expect(toastClose).toBeGreaterThan(onboardingBoundary);
    expect(source.indexOf('<ToastProvider>', toastOpen + 1)).toBe(-1);
  });

  // Every placement action reaches the region model through
  // `useRegionModelOptional`, so an <App /> mounted outside the provider
  // would turn placement into a silent no-op with a green suite (#928).
  test('mounts the application shell inside the region model provider', () => {
    const source = readFileSync(
      new URL('../main.tsx', import.meta.url),
      'utf8',
    );
    const regionOpen = source.indexOf('<RegionModelProvider>');
    const app = source.indexOf('<App />');
    const regionClose = source.indexOf('</RegionModelProvider>');

    expect(regionOpen).toBeGreaterThan(-1);
    expect(app).toBeGreaterThan(regionOpen);
    expect(regionClose).toBeGreaterThan(app);
  });
});
