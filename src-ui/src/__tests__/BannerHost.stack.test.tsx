/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { BannerHost } from '../components/notifications/BannerHost';
import { BANNER_PRIORITY, bannerStore } from '../contexts/banner-store';

afterEach(() => {
  act(() => bannerStore.reset());
});

function presentThree() {
  act(() => {
    bannerStore.present({
      id: 'test:blocked',
      priority: 100,
      tone: 'blocked',
      message: 'Access required',
    });
    bannerStore.present({
      id: 'test:error',
      priority: 50,
      tone: 'error',
      message: 'A capability failed',
      dismissible: true,
    });
    bannerStore.present({
      id: 'test:info',
      priority: 10,
      tone: 'info',
      message: 'General notice',
      dismissible: true,
    });
  });
}

describe('BannerHost collapsed stack', () => {
  test('renders only the front banner plus a severity-tinted cap', () => {
    presentThree();
    render(<BannerHost />);

    // Front = highest priority; hidden banners are not in the DOM.
    expect(screen.getByText('Access required')).toBeTruthy();
    expect(screen.queryByText('A capability failed')).toBeNull();
    expect(screen.queryByText('General notice')).toBeNull();

    const cap = screen.getByTestId('banner-stack-cap');
    expect(cap.textContent).toBe('2 more notices, 1 error');
    // The tint mirrors the FIRST hidden banner's severity (error), not the
    // front's (blocked) and not the last one's (info).
    expect(cap.className).toMatch(/banner-host__cap--error/);
    expect(cap.getAttribute('aria-expanded')).toBe('false');
  });

  test('a single banner renders without any cap', () => {
    act(() => {
      bannerStore.present({
        id: 'test:solo',
        priority: 10,
        tone: 'info',
        message: 'Only notice',
      });
    });
    render(<BannerHost />);
    expect(screen.getByText('Only notice')).toBeTruthy();
    expect(screen.queryByTestId('banner-stack-cap')).toBeNull();
  });

  test('clicking the cap expands the full stack and toggles back', () => {
    presentThree();
    render(<BannerHost />);

    fireEvent.click(screen.getByTestId('banner-stack-cap'));

    const host = screen.getByTestId('banner-host');
    expect(host.getAttribute('data-expanded')).toBe('true');
    expect(host.className).toMatch(/banner-host--expanded/);
    expect(screen.getByText('Access required')).toBeTruthy();
    expect(screen.getByText('A capability failed')).toBeTruthy();
    expect(screen.getByText('General notice')).toBeTruthy();

    const toggle = screen.getByTestId('banner-stack-cap');
    expect(toggle.textContent).toBe('Collapse notices');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(toggle);
    expect(
      screen.getByTestId('banner-host').hasAttribute('data-expanded'),
    ).toBe(false);
    expect(screen.queryByText('General notice')).toBeNull();
  });

  test('Escape and an outside tap both collapse an expanded stack', () => {
    presentThree();
    render(<BannerHost />);

    fireEvent.click(screen.getByTestId('banner-stack-cap'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(
      screen.getByTestId('banner-host').hasAttribute('data-expanded'),
    ).toBe(false);

    fireEvent.click(screen.getByTestId('banner-stack-cap'));
    fireEvent.pointerDown(document.body);
    expect(
      screen.getByTestId('banner-host').hasAttribute('data-expanded'),
    ).toBe(false);
  });

  test('Escape neither preventDefaults nor collapses while a dialog is open', () => {
    presentThree();
    render(<BannerHost />);
    fireEvent.click(screen.getByTestId('banner-stack-cap'));

    // The host is chrome underneath the dialog layer. Collapsing here too
    // closes two surfaces on one press, and an unconditional preventDefault
    // suppressed Escape's native effects for the whole document.
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    const notCancelled = fireEvent.keyDown(document, {
      key: 'Escape',
      cancelable: true,
    });
    expect(notCancelled).toBe(true);
    expect(
      screen.getByTestId('banner-host').getAttribute('data-expanded'),
    ).toBe('true');

    dialog.remove();
    const stillNotCancelled = fireEvent.keyDown(document, {
      key: 'Escape',
      cancelable: true,
    });
    expect(stillNotCancelled).toBe(true);
    expect(
      screen.getByTestId('banner-host').hasAttribute('data-expanded'),
    ).toBe(false);
  });

  test('Escape already cancelled by an earlier capture handler is left alone', () => {
    presentThree();
    render(<BannerHost />);
    fireEvent.click(screen.getByTestId('banner-stack-cap'));

    // The host listens on `document` in capture, so it runs before nearly
    // every in-tree handler and `defaultPrevented` is rarely set by the time
    // it reads it. `window` capture is earlier still, which is the one place
    // the check has power — cover it rather than leave the branch unproven.
    const claimEscape = (event: KeyboardEvent) => event.preventDefault();
    window.addEventListener('keydown', claimEscape, true);
    try {
      fireEvent.keyDown(document, { key: 'Escape', cancelable: true });
      expect(
        screen.getByTestId('banner-host').getAttribute('data-expanded'),
      ).toBe('true');
    } finally {
      window.removeEventListener('keydown', claimEscape, true);
    }

    // Same press without the earlier claim still collapses, so the assertion
    // above is about the claim and not about Escape being broken here.
    fireEvent.keyDown(document, { key: 'Escape', cancelable: true });
    expect(
      screen.getByTestId('banner-host').hasAttribute('data-expanded'),
    ).toBe(false);
  });

  test('a user dismissal promotes the next live banner immediately', () => {
    // Under reduced motion the exiting card is `display: none`, so a host that
    // kept rendering only the exiting head showed nothing but its cap until
    // the exit timer fired.
    presentThree();
    render(<BannerHost />);

    act(() => {
      bannerStore.dismiss('test:blocked', { reason: 'user' });
    });

    expect(screen.getByText('A capability failed')).toBeTruthy();
    const cap = screen.getByTestId('banner-stack-cap');
    // The exiting head is neither counted nor tinted by.
    expect(cap.textContent).toBe('1 more notice, 1 informational');
    expect(cap.className).toMatch(/banner-host__cap--info/);
  });

  test('the stack auto-collapses when dismissals leave one live banner', () => {
    presentThree();
    render(<BannerHost />);

    fireEvent.click(screen.getByTestId('banner-stack-cap'));
    act(() => {
      bannerStore.dismiss('test:error');
      bannerStore.dismiss('test:info');
    });

    expect(
      screen.getByTestId('banner-host').hasAttribute('data-expanded'),
    ).toBe(false);
    expect(screen.queryByTestId('banner-stack-cap')).toBeNull();
    expect(screen.getByText('Access required')).toBeTruthy();
  });

  test('dismissing the front banner promotes the next by priority', () => {
    presentThree();
    render(<BannerHost />);

    act(() => {
      bannerStore.dismiss('test:blocked');
    });

    expect(screen.getByText('A capability failed')).toBeTruthy();
    expect(screen.queryByText('Access required')).toBeNull();
    const cap = screen.getByTestId('banner-stack-cap');
    expect(cap.textContent).toBe('1 more notice, 1 informational');
    expect(cap.className).toMatch(/banner-host__cap--info/);
  });

  test('two connectionBlocking banners both render and both announce (station#3432)', () => {
    // The live instance the fix closes: a declined phone (pairing-failure)
    // and a different Station's standing credential reminder are both true
    // and both connectionBlocking. Before the band rule, one always sorted
    // behind the cap and was not in the DOM at all — its role="alert" never
    // reached a screen reader.
    act(() => {
      bannerStore.present({
        id: 'chrome:onboarding:pairing-failure',
        priority: 100,
        tone: 'blocked',
        message: 'The host declined this device',
      });
      bannerStore.present({
        id: 'chrome:onboarding:credential',
        priority: 100,
        tone: 'blocked',
        message: 'Credential required to reconnect',
      });
    });
    render(<BannerHost />);

    const first = screen.getByText('Credential required to reconnect');
    const second = screen.getByText('The host declined this device');
    // Both are present, and both are inside a role="alert" node — the actual
    // user-facing fix: a collapsed banner used to not exist in the DOM.
    expect(first.closest('[role="alert"]')).not.toBeNull();
    expect(second.closest('[role="alert"]')).not.toBeNull();
    // Nothing is hidden, so there is nothing for a cap to describe.
    expect(screen.queryByTestId('banner-stack-cap')).toBeNull();
  });

  test('two connectionBlocking banners plus a lower-band banner: both blocking render, cap counts only the lower band', () => {
    act(() => {
      bannerStore.present({
        id: 'chrome:onboarding:pairing-failure',
        priority: 100,
        tone: 'blocked',
        message: 'The host declined this device',
      });
      bannerStore.present({
        id: 'chrome:onboarding:credential',
        priority: 100,
        tone: 'blocked',
        message: 'Credential required to reconnect',
      });
      bannerStore.present({
        id: 'test:info',
        priority: 10,
        tone: 'info',
        message: 'General notice',
      });
    });
    render(<BannerHost />);

    expect(screen.getByText('The host declined this device')).toBeTruthy();
    expect(screen.getByText('Credential required to reconnect')).toBeTruthy();
    expect(screen.queryByText('General notice')).toBeNull();

    const cap = screen.getByTestId('banner-stack-cap');
    expect(cap.textContent).toBe('1 more notice, 1 informational');
  });
});

describe('test-only passive-chrome clearing hook (station#3823)', () => {
  test('removes passive chrome and never the notice the reader caused', () => {
    // jsdom, deliberately: `banner-store.ts` installs the hook on `window` at
    // module load, so a node-environment suite cannot see it at all — and a
    // spec that calls it through `?.` on a page where it was never installed
    // would silently do nothing and still pass.
    act(() =>
      bannerStore.present({
        id: 'chrome:capability',
        priority: BANNER_PRIORITY.capabilityFailure,
        tone: 'warning',
        message: 'A capability failed',
      }),
    );
    act(() =>
      bannerStore.present({
        id: 'chrome:board:unavailable',
        priority: BANNER_PRIORITY.info,
        tone: 'info',
        message: 'redirect',
        userInitiated: true,
      }),
    );
    const clear = window.__stationClearPassiveChromeBannersForTestsOnly;
    expect(typeof clear).toBe('function');
    act(() => clear?.());
    const live = bannerStore
      .getSnapshot()
      .filter((banner) => banner.phase !== 'exiting');
    expect(live.map((banner) => banner.id)).toEqual([
      'chrome:board:unavailable',
    ]);
  });
});
