import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BannerItem } from '../contexts/banner-store';
import {
  BANNER_EXIT_MS,
  BANNER_PRIORITY,
  BANNER_PRIORITY_BANDS,
  bannerStackCapLabel,
  bannerStore,
  buildBannerStackView,
  effectiveBannerPriority,
  sortBanners,
} from '../contexts/banner-store';

afterEach(() => {
  bannerStore.reset();
  vi.useRealTimers();
});

describe('bannerStore', () => {
  it('runs onDismiss at the moment of user dismissal, not after the exit', () => {
// A system dismiss (profile switch, teardown) landing inside the 160ms
// exit window used to cancel the timer and silently discard the durable
// side of a dismissal the user had already made.
    const onDismiss = vi.fn();
    bannerStore.present({
      id: 'chrome:test:durable-dismiss',
      priority: BANNER_PRIORITY.info,
      tone: 'info',
      message: 'Dismiss me durably.',
      dismissible: true,
      onDismiss,
    });
    bannerStore.dismiss('chrome:test:durable-dismiss', { reason: 'user' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
// A system dismiss during the exit cannot un-run it.
    bannerStore.dismiss('chrome:test:durable-dismiss');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('replaces an action whose link target changed under the same id', () => {
    const present = (href: string) =>
      bannerStore.present({
        id: 'chrome:update:available',
        priority: BANNER_PRIORITY.info,
        tone: 'info',
        message: 'Station 2.0.0 is available.',
        actions: [{ label: 'Update Station', href }],
      });
    present('https://updates.example.test/old');
    present('https://updates.example.test/corrected');
// Everything else about the banner is identical, so an equality check
// that ignores href leaves the only action pointing at the stale URL.
    expect(bannerStore.getSnapshot()[0].actions?.[0].href).toBe(
      'https://updates.example.test/corrected',
    );
  });

  it('orders by priority descending', () => {
    bannerStore.present({
      id: 'low',
      priority: BANNER_PRIORITY.info,
      tone: 'info',
      message: 'low',
    });
    bannerStore.present({
      id: 'high',
      priority: BANNER_PRIORITY.connectionBlocking,
      tone: 'blocked',
      message: 'high',
    });
    const snap = bannerStore.getSnapshot();
    expect(snap.map((b) => b.id)).toEqual(['high', 'low']);
  });

  it('documents priority bands in descending order', () => {
    const values = BANNER_PRIORITY_BANDS.map((band) => BANNER_PRIORITY[band]);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i - 1]!).toBeGreaterThan(values[i]!);
    }
    expect(BANNER_PRIORITY_BANDS).toEqual([
      'connectionBlocking',
      'versionMismatch',
      'connectionTransient',
      'capabilityFailure',
      'setup',
      'info',
    ]);
  });

  it('dismiss removes an item', () => {
    bannerStore.present({
      id: 'a',
      priority: 1,
      tone: 'info',
      message: 'a',
    });
    bannerStore.dismiss('a');
    expect(bannerStore.getSnapshot()).toEqual([]);
  });

  it('only user dismiss runs onDismiss (system/cleanup must not latch)', () => {
    let calls = 0;
    bannerStore.present({
      id: 'a',
      priority: 1,
      tone: 'info',
      message: 'a',
      onDismiss: () => {
        calls += 1;
      },
    });
    bannerStore.dismiss('a');
    expect(calls).toBe(0);
    bannerStore.present({
      id: 'a',
      priority: 1,
      tone: 'info',
      message: 'a',
      dismissible: true,
      onDismiss: () => {
        calls += 1;
      },
    });
    vi.useFakeTimers();
    bannerStore.dismiss('a', { reason: 'user' });
    expect(bannerStore.getSnapshot()[0]?.phase).toBe('exiting');
// The user's decision completes at dismissal; the exit is presentation
// only. Deferring onDismiss to the timer let a system dismiss inside the
// exit window cancel it and drop the durable side of the dismissal.
    expect(calls).toBe(1);
    vi.advanceTimersByTime(BANNER_EXIT_MS);
    expect(calls).toBe(1);
    expect(bannerStore.getSnapshot()).toEqual([]);
  });

  it('present with the same id replaces content', () => {
    bannerStore.present({
      id: 'a',
      priority: 1,
      tone: 'info',
      message: 'one',
    });
    bannerStore.present({
      id: 'a',
      priority: 1,
      tone: 'warning',
      message: 'two',
    });
    const snap = bannerStore.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]?.message).toBe('two');
    expect(snap[0]?.tone).toBe('warning');
  });

  it('suppresses a user-dismissed occurrence but presents a different occurrence', () => {
    vi.useFakeTimers();
    const present = (occurrence: string) =>
      bannerStore.present({
        id: 'a',
        occurrence,
        priority: 1,
        tone: 'info',
        message: occurrence,
        dismissible: true,
      });
    present('first');
    bannerStore.dismiss('a', { reason: 'user' });
    vi.advanceTimersByTime(BANNER_EXIT_MS);
    present('first');
    expect(bannerStore.getSnapshot()).toEqual([]);
    present('second');
    expect(bannerStore.getSnapshot()[0]?.occurrence).toBe('second');
  });

  it('teardown dismissal neither releases nor latches occurrence suppression', () => {
    vi.useFakeTimers();
    const item = {
      id: 'a',
      occurrence: 'attempt-1',
      priority: 1,
      tone: 'info' as const,
      message: 'failure',
      dismissible: true,
    };
    bannerStore.present(item);
    bannerStore.dismiss('a', { reason: 'user' });
    vi.advanceTimersByTime(BANNER_EXIT_MS);
    bannerStore.dismiss('a');
    bannerStore.present(item);
    expect(bannerStore.getSnapshot()).toEqual([]);
// A teardown/remount is not a new condition occurrence, so the user's
// dismissal must remain authoritative.
  });

  it('clear releases user-dismissal suppression', () => {
    vi.useFakeTimers();
    const item = {
      id: 'a',
      occurrence: 'same',
      priority: 1,
      tone: 'info' as const,
      message: 'a',
      dismissible: true,
    };
    bannerStore.present(item);
    bannerStore.dismiss('a', { reason: 'user' });
    vi.advanceTimersByTime(BANNER_EXIT_MS);
    bannerStore.clear();
    bannerStore.present(item);
    expect(bannerStore.getSnapshot()).toHaveLength(1);
  });

  it('user-dismiss keeps the exiting slot while the cap counts only live banners', () => {
    bannerStore.present({
      id: 'high',
      priority: 100,
      tone: 'blocked',
      message: 'high',
      dismissible: true,
    });
    bannerStore.present({
      id: 'mid',
      priority: 50,
      tone: 'warning',
      message: 'mid',
      dismissible: true,
    });
    bannerStore.present({
      id: 'low',
      priority: 10,
      tone: 'info',
      message: 'low',
      dismissible: true,
    });

    vi.useFakeTimers();
    bannerStore.dismiss('mid', { reason: 'user' });

    const during = bannerStore.getSnapshot();
    expect(during.map((b) => b.id)).toEqual(['high', 'mid', 'low']);
    expect(during.find((b) => b.id === 'mid')?.phase).toBe('exiting');

// Collapsed view during the exit: exiting mid neither counts toward the
// cap nor donates its (warning) tone — the first hidden LIVE banner does.
    const view = buildBannerStackView(during, false);
    expect(view.visible.map((b) => b.id)).toEqual(['high']);
    expect(view.cap).toEqual({ hiddenCount: 1, tone: 'info', toneCount: 1 });

    vi.advanceTimersByTime(BANNER_EXIT_MS);
    expect(bannerStore.getSnapshot().map((b) => b.id)).toEqual(['high', 'low']);
  });
});

describe('sortBanners / buildBannerStackView', () => {
  it('sorts by priority then id', () => {
    const sorted = sortBanners([
      { id: 'b', priority: 10, tone: 'info', message: 'b' },
      { id: 'a', priority: 10, tone: 'info', message: 'a' },
      { id: 'c', priority: 90, tone: 'error', message: 'c' },
    ]);
    expect(sorted.map((b) => b.id)).toEqual(['c', 'a', 'b']);
  });

  it('collapsed shows only the front banner with a cap tinted by the first hidden banner', () => {
    const banners = sortBanners([
      { id: 'a', priority: 100, tone: 'blocked', message: 'a', phase: 'live' },
      { id: 'b', priority: 50, tone: 'error', message: 'b', phase: 'live' },
      { id: 'c', priority: 10, tone: 'info', message: 'c', phase: 'live' },
    ]);
    const view = buildBannerStackView(banners, false);
    expect(view.visible.map((b) => b.id)).toEqual(['a']);
// The cap's tint derives from the FIRST hidden banner's tone (highest
// priority among the hidden), never the front's and never a later one's.
    expect(view.cap).toEqual({ hiddenCount: 2, tone: 'error', toneCount: 1 });
  });

  it('expanded shows every banner and no cap', () => {
    const banners = sortBanners([
      { id: 'a', priority: 100, tone: 'blocked', message: 'a', phase: 'live' },
      { id: 'b', priority: 10, tone: 'info', message: 'b', phase: 'live' },
    ]);
    const view = buildBannerStackView(banners, true);
    expect(view.visible.map((b) => b.id)).toEqual(['a', 'b']);
    expect(view.cap).toBeNull();
  });

  it('renders a single banner without a cap and an empty store as nothing', () => {
    const only = buildBannerStackView(
      [{ id: 'a', priority: 10, tone: 'info', message: 'a', phase: 'live' }],
      false,
    );
    expect(only.visible).toHaveLength(1);
    expect(only.cap).toBeNull();
    expect(buildBannerStackView([], false)).toEqual({
      visible: [],
      cap: null,
    });
  });

  it('an exiting hidden banner neither counts nor tints the cap', () => {
    const banners = sortBanners([
      { id: 'a', priority: 100, tone: 'blocked', message: 'a', phase: 'live' },
      {
        id: 'b',
        priority: 50,
        tone: 'error',
        message: 'b',
        phase: 'exiting',
      },
      { id: 'c', priority: 10, tone: 'warning', message: 'c', phase: 'live' },
    ]);
    const view = buildBannerStackView(banners, false);
    expect(view.cap).toEqual({ hiddenCount: 1, tone: 'warning', toneCount: 1 });
  });

  it('counts how many hidden banners carry the cap tone', () => {
    const banners = sortBanners([
      { id: 'a', priority: 100, tone: 'blocked', message: 'a', phase: 'live' },
      { id: 'b', priority: 90, tone: 'blocked', message: 'b', phase: 'live' },
      { id: 'c', priority: 80, tone: 'blocked', message: 'c', phase: 'live' },
      { id: 'd', priority: 10, tone: 'info', message: 'd', phase: 'live' },
    ]);
    const view = buildBannerStackView(banners, false);
    expect(view.cap).toEqual({
      hiddenCount: 3,
      tone: 'blocked',
      toneCount: 2,
    });
  });

  it('names the cap severity in words so the tint is not the only signal', () => {
    expect(
      bannerStackCapLabel({ hiddenCount: 2, tone: 'blocked', toneCount: 1 }),
    ).toBe('2 more notices, 1 blocking');
    expect(
      bannerStackCapLabel({ hiddenCount: 1, tone: 'warning', toneCount: 1 }),
    ).toBe('1 more notice, 1 warning');
// The noun tones agree with their count; the adjective tones do not
// inflect. This is an accessible name a screen reader speaks verbatim,
// so "3 error" was a defect and this test previously pinned it.
    expect(
      bannerStackCapLabel({ hiddenCount: 3, tone: 'error', toneCount: 3 }),
    ).toBe('3 more notices, 3 errors');
    expect(
      bannerStackCapLabel({ hiddenCount: 4, tone: 'warning', toneCount: 2 }),
    ).toBe('4 more notices, 2 warnings');
    expect(
      bannerStackCapLabel({ hiddenCount: 3, tone: 'blocked', toneCount: 3 }),
    ).toBe('3 more notices, 3 blocking');
    expect(
      bannerStackCapLabel({ hiddenCount: 2, tone: 'info', toneCount: 2 }),
    ).toBe('2 more notices, 2 informational');
  });

  it('promotes the first live banner to the front while the head is exiting', () => {
// Under `prefers-reduced-motion` an exiting item is `display: none`.
// Taking `banners[0]` unconditionally left the collapsed host rendering
// nothing but its cap for the whole exit budget after a dismissal.
    const banners = sortBanners([
      {
        id: 'a',
        priority: 100,
        tone: 'blocked',
        message: 'a',
        phase: 'exiting',
      },
      { id: 'b', priority: 50, tone: 'error', message: 'b', phase: 'live' },
      { id: 'c', priority: 10, tone: 'info', message: 'c', phase: 'live' },
    ]);
    const view = buildBannerStackView(banners, false);
// The exiting head is still rendered so its collapse animates; the live
// front rides with it rather than waiting for the timer.
    expect(view.visible.map((b) => b.id)).toEqual(['a', 'b']);
    expect(view.cap).toEqual({ hiddenCount: 1, tone: 'info', toneCount: 1 });
  });

  it('renders every banner when they are all exiting', () => {
    const banners = sortBanners([
      {
        id: 'a',
        priority: 100,
        tone: 'blocked',
        message: 'a',
        phase: 'exiting',
      },
      { id: 'b', priority: 50, tone: 'error', message: 'b', phase: 'exiting' },
    ]);
    const view = buildBannerStackView(banners, false);
    expect(view.visible.map((b) => b.id)).toEqual(['a', 'b']);
    expect(view.cap).toBeNull();
  });

  it('keeps every connectionBlocking banner visible and caps only the bands below it (station#3432)', () => {
// The class this fixes: a declined phone and a still-pending credential
// reminder are BOTH true and both connectionBlocking. An index slice can
// only ever show one; the band rule shows both.
    const banners = sortBanners([
      {
        id: 'chrome:onboarding:pairing-failure',
        priority: BANNER_PRIORITY.connectionBlocking,
        tone: 'blocked',
        message: 'The host declined this device',
        phase: 'live',
      },
      {
        id: 'chrome:onboarding:credential',
        priority: BANNER_PRIORITY.connectionBlocking,
        tone: 'blocked',
        message: 'Credential required to reconnect',
        phase: 'live',
      },
      {
        id: 'chrome:connection:offline',
        priority: BANNER_PRIORITY.connectionTransient,
        tone: 'warning',
        message: 'Reconnecting…',
        phase: 'live',
      },
      {
        id: 'chrome:update:available',
        priority: BANNER_PRIORITY.info,
        tone: 'info',
        message: 'Station 2.0.0 is available.',
        phase: 'live',
      },
    ]);
    const view = buildBannerStackView(banners, false);
// Both blocking banners render, sorted within the band as usual.
    expect(view.visible.map((b) => b.id)).toEqual([
      'chrome:onboarding:credential',
      'chrome:onboarding:pairing-failure',
    ]);
// The cap counts and tints only the two lower-band banners, never the
// connectionBlocking members that are already visible.
    expect(view.cap).toEqual({ hiddenCount: 2, tone: 'warning', toneCount: 1 });
  });

  it('renders no cap when nothing outside the connectionBlocking band is hidden', () => {
    const banners = sortBanners([
      {
        id: 'a',
        priority: BANNER_PRIORITY.connectionBlocking,
        tone: 'blocked',
        message: 'a',
        phase: 'live',
      },
      {
        id: 'b',
        priority: BANNER_PRIORITY.connectionBlocking,
        tone: 'blocked',
        message: 'b',
        phase: 'live',
      },
    ]);
    const view = buildBannerStackView(banners, false);
    expect(view.visible.map((b) => b.id)).toEqual(['a', 'b']);
    expect(view.cap).toBeNull();
  });

  it('a connectionBlocking banner mid-exit still stays visible alongside a live one', () => {
    const banners = sortBanners([
      {
        id: 'a',
        priority: BANNER_PRIORITY.connectionBlocking,
        tone: 'blocked',
        message: 'a',
        phase: 'exiting',
      },
      {
        id: 'b',
        priority: BANNER_PRIORITY.connectionBlocking,
        tone: 'blocked',
        message: 'b',
        phase: 'live',
      },
      {
        id: 'c',
        priority: BANNER_PRIORITY.info,
        tone: 'info',
        message: 'c',
        phase: 'live',
      },
    ]);
    const view = buildBannerStackView(banners, false);
    expect(view.visible.map((b) => b.id)).toEqual(['a', 'b']);
    expect(view.cap).toEqual({ hiddenCount: 1, tone: 'info', toneCount: 1 });
  });

  it('an exiting connectionBlocking banner sorted AFTER a live one still renders, so it animates out', () => {
// The case the fixture above does not cover: there the exiting member
// sorts BEFORE the live one, which the old single-front-index selection
// already included (anything up to and including the first live index).
// Here the exiting member sorts AFTER the live one ('a' live < 'b'
// exiting by id, same priority) — under the old logic this would have
// been silently dropped (index past `frontIndex`), no exit animation.
// Band membership, not array position, decides `visible` now.
    const banners = sortBanners([
      {
        id: 'a',
        priority: BANNER_PRIORITY.connectionBlocking,
        tone: 'blocked',
        message: 'a',
        phase: 'live',
      },
      {
        id: 'b',
        priority: BANNER_PRIORITY.connectionBlocking,
        tone: 'blocked',
        message: 'b',
        phase: 'exiting',
      },
    ]);
    const view = buildBannerStackView(banners, false);
    expect(view.visible.map((b) => b.id)).toEqual(['a', 'b']);
  });

  it('the band boundary is exactly connectionBlocking: a live versionMismatch banner does not join it', () => {
// Pins the cutoff `banner.priority < BANNER_PRIORITY.connectionBlocking`
// deliberately. Nothing in this suite previously constructed a live
// versionMismatch banner alongside a live connectionBlocking one, so a
// regression widening the band (e.g. to `<= BANNER_PRIORITY.versionMismatch`)
// was only ever caught by the boundary happening to agree with an
// unrelated fixture, not by a test naming the boundary itself.
    const banners = sortBanners([
      {
        id: 'blocking',
        priority: BANNER_PRIORITY.connectionBlocking,
        tone: 'blocked',
        message: 'blocking',
        phase: 'live',
      },
      {
        id: 'mismatch',
        priority: BANNER_PRIORITY.versionMismatch,
        tone: 'error',
        message: 'mismatch',
        phase: 'live',
      },
      {
        id: 'info',
        priority: BANNER_PRIORITY.info,
        tone: 'info',
        message: 'info',
        phase: 'live',
      },
    ]);
    const view = buildBannerStackView(banners, false);
// Only the connectionBlocking member is in the band; versionMismatch
// collapses behind the cap along with everything lower.
    expect(view.visible.map((b) => b.id)).toEqual(['blocking']);
    expect(view.cap).toEqual({ hiddenCount: 2, tone: 'error', toneCount: 1 });
  });

  it('within one priority tier, a userInitiated banner outranks a passive one that would otherwise sort first by id (station#3823)', () => {
    const sorted = sortBanners([
      {
        id: 'chrome:capability',
        priority: BANNER_PRIORITY.info,
        tone: 'info',
        message: 'capability',
      },
      {
        id: 'chrome:redirect',
        priority: BANNER_PRIORITY.info,
        tone: 'info',
        message: 'redirect',
        userInitiated: true,
      },
    ]);
// 'chrome:capability' sorts before 'chrome:redirect' by id alone — this
// proves `userInitiated`, not id, decided the order.
    expect(sorted.map((b) => b.id)).toEqual([
      'chrome:redirect',
      'chrome:capability',
    ]);
  });

  it('a userInitiated info-priority notice is visible over a full stack of older passive banners, not capped (station#3823)', () => {
// The board redirect's own scenario: several passive `info`-tier chrome
// banners (a stale update-check notice, a capability notice) are already
// live when the user-initiated redirect notice arrives.
    const banners = sortBanners([
      {
        id: 'chrome:capability',
        priority: BANNER_PRIORITY.info,
        tone: 'info',
        message: 'capability',
        phase: 'live',
      },
      {
        id: 'chrome:update:available',
        priority: BANNER_PRIORITY.info,
        tone: 'info',
        message: 'Station 2.0.0 is available.',
        phase: 'live',
      },
      {
        id: 'chrome:board:unavailable',
        priority: BANNER_PRIORITY.info,
        tone: 'info',
        message:
          'This project has no Builder runs yet; the Board appears when one starts',
        phase: 'live',
        userInitiated: true,
      },
    ]);
    const view = buildBannerStackView(banners, false);
// No connectionBlocking band is live, so the single front slot goes to
// the userInitiated banner rather than to whichever passive one happens
// to sort first by id.
    expect(view.visible.map((b) => b.id)).toEqual(['chrome:board:unavailable']);
    expect(view.cap).toEqual({ hiddenCount: 2, tone: 'info', toneCount: 2 });
  });

  it('a passive banner presented after a userInitiated one does not displace it from the front (station#3823)', () => {
    bannerStore.present({
      id: 'chrome:board:unavailable',
      priority: BANNER_PRIORITY.info,
      tone: 'info',
      message:
        'This project has no Builder runs yet; the Board appears when one starts',
      userInitiated: true,
    });
// Arrives AFTER the redirect notice — an older passive banner catching
// up (e.g. a delayed capability poll) must not bump it out of view.
    bannerStore.present({
      id: 'chrome:capability',
      priority: BANNER_PRIORITY.info,
      tone: 'info',
      message: 'capability',
    });
    const view = buildBannerStackView(bannerStore.getSnapshot(), false);
    expect(view.visible.map((b) => b.id)).toEqual(['chrome:board:unavailable']);
  });

  it('the redirect notice is read before the passive banners that actually bury it — the real priorities, not info-vs-info (station#3823)', () => {
// FIXTURE-VS-REALITY: a same-tier tiebreak passes an info-vs-info test and
// still fails in the app. Every passive chrome source that LINGERS on a
// long-lived instance presents above `info` — deferred capability, the
// plugin registry gate and resource posture all at `capabilityFailure`,
// the mobile connection notice at `setup` — while the redirect notice is
// `info`. These are the exact priorities those sources pass today.
    const banners = sortBanners([
      {
        id: 'chrome:capability',
        priority: BANNER_PRIORITY.capabilityFailure,
        tone: 'warning',
        message: 'A capability failed',
        phase: 'live',
      },
      {
        id: 'chrome:resource-posture',
        priority: BANNER_PRIORITY.capabilityFailure,
        tone: 'warning',
        message: 'Resource posture degraded',
        phase: 'live',
      },
      {
        id: 'chrome:onboarding:device-connection',
        priority: BANNER_PRIORITY.setup,
        tone: 'info',
        message: 'Finish setup',
        phase: 'live',
      },
      {
        id: 'chrome:board:unavailable',
        priority: BANNER_PRIORITY.info,
        tone: 'info',
        message:
          'This project has no Builder runs yet; the Board appears when one starts',
        phase: 'live',
        userInitiated: true,
      },
    ]);
    expect(banners[0]?.id).toBe('chrome:board:unavailable');
    const view = buildBannerStackView(banners, false);
    expect(view.visible.map((b) => b.id)).toEqual(['chrome:board:unavailable']);
  });

  it('a user-initiated notice never displaces a banner about the connection itself (station#3823)', () => {
// The lift stops at `capabilityFailure`. The three bands above it all
// describe whether the product can reach its Station at all, and one of
// them is frequently the REASON the user's action did nothing.
    for (const passivePriority of [
      BANNER_PRIORITY.connectionTransient,
      BANNER_PRIORITY.versionMismatch,
      BANNER_PRIORITY.connectionBlocking,
    ]) {
      const banners = sortBanners([
        {
          id: 'chrome:board:unavailable',
          priority: BANNER_PRIORITY.info,
          tone: 'info',
          message: 'redirect',
          phase: 'live',
          userInitiated: true,
        },
        {
          id: 'chrome:connection',
          priority: passivePriority,
          tone: 'error',
          message: 'connection',
          phase: 'live',
        },
      ]);
      expect(banners.map((b) => b.id)).toEqual([
        'chrome:connection',
        'chrome:board:unavailable',
      ]);
    }
  });

  it('the lift is sort-only: it never rewrites priority, so the connectionBlocking band slice still agrees (station#3823)', () => {
// `buildBannerStackView` finds the band end with the RAW priority field.
// If the lift mutated `priority` instead of being derived at sort time,
// that boundary and the sorted order could disagree.
    const lifted: BannerItem = {
      id: 'chrome:board:unavailable',
      priority: BANNER_PRIORITY.info,
      tone: 'info',
      message: 'redirect',
      phase: 'live',
      userInitiated: true,
    };
    const sorted = sortBanners([lifted]);
    expect(sorted[0]?.priority).toBe(BANNER_PRIORITY.info);
    expect(effectiveBannerPriority(lifted)).toBe(
      BANNER_PRIORITY.capabilityFailure,
    );
    expect(effectiveBannerPriority({ ...lifted, userInitiated: false })).toBe(
      BANNER_PRIORITY.info,
    );
// A user-initiated banner that is ALREADY above the ceiling keeps its own
// priority — the lift is a floor, never a demotion.
    expect(
      effectiveBannerPriority({
        ...lifted,
        priority: BANNER_PRIORITY.connectionBlocking,
      }),
    ).toBe(BANNER_PRIORITY.connectionBlocking);
  });

  it('the connectionBlocking band still wins over a userInitiated banner (station#3432 x station#3823)', () => {
    const banners = sortBanners([
      {
        id: 'chrome:onboarding:credential',
        priority: BANNER_PRIORITY.connectionBlocking,
        tone: 'blocked',
        message: 'Credential required to reconnect',
        phase: 'live',
      },
      {
        id: 'chrome:board:unavailable',
        priority: BANNER_PRIORITY.info,
        tone: 'info',
        message:
          'This project has no Builder runs yet; the Board appears when one starts',
        phase: 'live',
        userInitiated: true,
      },
    ]);
    const view = buildBannerStackView(banners, false);
// A blocking credential banner is never pushed behind a redirect notice,
// however recently the user caused it — `userInitiated` only breaks ties
// WITHIN a priority tier, it never crosses tiers.
    expect(view.visible.map((b) => b.id)).toEqual([
      'chrome:onboarding:credential',
    ]);
    expect(view.cap).toEqual({ hiddenCount: 1, tone: 'info', toneCount: 1 });
  });
});
