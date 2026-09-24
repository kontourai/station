import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('application provider order', () => {
  // COMPOSITION BOUNDARY (hosted connect-modal regression): the recovery
  // shell used to sit below `PermissionManager` inside the authority
  // subtree, so every activation transition unmounted the open
  // access-request flow. It now mounts ABOVE `AuthorityQueryProvider` in
  // `RecoveryQueryBoundary` while the application shell stays INSIDE it.
  // The preserved core of the old assertion is the single toast provider
  // covering BOTH lifetimes — toasts must survive a connection switch —
  // plus navigation above both (the recovery shell navigates).
  test('keeps recovery and the application shell inside one toast provider, split by the authority boundary', () => {
    const source = readFileSync(
      new URL('../main.tsx', import.meta.url),
      'utf8',
    );
    const navOpen = source.indexOf('<NavigationProvider>');
    const toastOpen = source.indexOf('<ToastProvider>');
    const recoveryOpen = source.indexOf('<RecoveryQueryBoundary>');
    const onboardingBoundary = source.indexOf('id="connection-recovery"');
    const recoveryClose = source.indexOf('</RecoveryQueryBoundary>');
    // Trailing space: the bare prefix also matches a prose comment
    // mentioning the provider; the JSX open tag is the one with props.
    const authorityOpen = source.indexOf('<AuthorityQueryProvider ');
    const authorityClose = source.indexOf('</AuthorityQueryProvider>');
    const app = source.indexOf('<App />');
    const toastClose = source.indexOf('</ToastProvider>');

    expect(navOpen).toBeGreaterThan(-1);
    expect(toastOpen).toBeGreaterThan(navOpen);
    // Stable recovery lifetime above the replaceable protected one.
    expect(recoveryOpen).toBeGreaterThan(toastOpen);
    expect(onboardingBoundary).toBeGreaterThan(recoveryOpen);
    expect(recoveryClose).toBeGreaterThan(onboardingBoundary);
    expect(authorityOpen).toBeGreaterThan(recoveryClose);
    // Protected data lifetime still owns the application shell.
    expect(app).toBeGreaterThan(authorityOpen);
    expect(authorityClose).toBeGreaterThan(app);
    // One toast provider covers both lifetimes.
    expect(toastClose).toBeGreaterThan(authorityClose);
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
