/**
 * archive#3079 — the service-owns-home state became reachable when the
 * supervisor started publishing liveness (#3064), and this banner reported
 * it as "your local Station is stopped" with a Restart button whose only
 * possible outcome is an error: `restart_bundled_server` fails closed for a
 * non-sidecar owner.
 */
// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  BANNER_IDS,
  BANNER_PRIORITY,
  bannerStore,
} from '../../contexts/banner-store';
import { BundledServiceBanner } from '../BundledServiceBanner';

const baseStatus = {
  phase: 'stopped' as const,
  attempt: 0,
  maxAttempts: 3,
  apiBase: null,
  port: 38141,
  lastExitCode: null,
  nextRetryInMs: null,
  logPath: null,
  desktopLogPath: null,
  canRunInBackground: false,
  failClosed: false,
  // A SENTINEL, not a paraphrase of the component's own fallback. With the
  // fallback text here, deleting `status.message ||` from the component kept
  // this suite green — and "the host already narrates it accurately" is half
  // the thesis of the fix.
  message: 'HOST-NARRATION-SENTINEL owns this home.',
  detail: 'Service prod is registered on port 38141.',
};

function presented() {
  const calls: Parameters<typeof bannerStore.present>[0][] = [];
  vi.spyOn(bannerStore, 'present').mockImplementation((item) => {
    calls.push(item);
    return '' as never;
  });
  vi.spyOn(bannerStore, 'dismiss').mockImplementation(() => undefined as never);
  return calls;
}

/** Both sides of the decision: what was presented, and what was dismissed. */
function observed() {
  const dismissed: string[] = [];
  const calls: Parameters<typeof bannerStore.present>[0][] = [];
  vi.spyOn(bannerStore, 'present').mockImplementation((item) => {
    calls.push(item);
    return '' as never;
  });
  vi.spyOn(bannerStore, 'dismiss').mockImplementation((id) => {
    dismissed.push(id);
    return undefined as never;
  });
  return { calls, dismissed };
}

describe('BundledServiceBanner (station#3079)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // archive#3476 — the healthy service-owned home is not news.
  test('a healthy service-owned home presents no banner at all', () => {
    // This is `attached_service_status`'s ONLY shape: it hardcodes `stopped`,
    // `fail_closed: false`, `ownership: Service`. The desktop's own sidecar is
    // never `running` here — that is the point of running Station as a durable
    // service — so the `running` dismiss could never fire and this banner was
    // permanent, in the *transient* band, over a configuration the user chose.
    const { calls, dismissed } = observed();
    render(
      <BundledServiceBanner
        status={{ ...baseStatus, ownership: 'service' as const }}
        onRestart={vi.fn()}
        onOpenConnections={vi.fn()}
      />,
    );

    expect(calls).toHaveLength(0);
    // Not merely "did not present": an already-live banner from an earlier
    // state must actively come down, which is the same contract the `running`
    // branch has always had.
    expect(dismissed).toContain(BANNER_IDS.bundledService);
  });

  test.each(['starting', 'restarting', 'stopping'] as const)(
    'a service-owned home presents nothing in phase %s either',
    (phase) => {
      // No producer emits these with `service` today, but the rule is about
      // the state, not the producer: a desktop that does not attach to the
      // durable service has nothing to say about its lifecycle.
      const calls = presented();
      render(
        <BundledServiceBanner
          status={{ ...baseStatus, phase, ownership: 'service' as const }}
          onRestart={vi.fn()}
          onOpenConnections={vi.fn()}
        />,
      );

      expect(calls).toHaveLength(0);
    },
  );

  test('a service-owned home that FAILED is still reported', () => {
    // The exclusion, and the reason this is a `phase !== 'failed'` gate rather
    // than a bare ownership gate: removing noise must not remove faults.
    const calls = presented();
    render(
      <BundledServiceBanner
        status={{
          ...baseStatus,
          phase: 'failed' as const,
          ownership: 'service' as const,
          message: 'HOST-NARRATION-SENTINEL failed.',
        }}
        onRestart={vi.fn()}
        onOpenConnections={vi.fn()}
      />,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.message).toContain('HOST-NARRATION-SENTINEL');
    expect(calls[0]!.badge).toBe('Service owns this home');
  });

  test('an ordinary stopped sidecar still offers Restart', () => {
    // The negative control: this fix must not remove the affordance from the
    // case where it actually works.
    const calls = presented();
    render(
      <BundledServiceBanner
        status={{ ...baseStatus, ownership: 'sidecar' as const }}
        onRestart={vi.fn()}
        onOpenConnections={vi.fn()}
      />,
    );

    const labels = calls[0]!.actions?.map((action) => action.label) ?? [];
    expect(labels).toContain('Restart Station');
  });

  test('an unowned home offers no Restart either, and keeps its detail', () => {
    // `none` is not a theoretical state: an ambiguous or untrusted registry,
    // or a second Desktop that lost the atomic ownership claim, all land
    // here. restart_bundled_server refuses for ANY non-sidecar owner, and
    // the caller discards the error — so the button rendered here did
    // visibly nothing. Gating on "a service owns it" left this case out.
    const calls = presented();
    render(
      <BundledServiceBanner
        status={{
          ...baseStatus,
          phase: 'failed' as const,
          ownership: 'none' as const,
          message: 'Desktop local ownership is not initialized.',
          detail: 'The home-scoped registry is unavailable or ambiguous.',
        }}
        onRestart={vi.fn()}
        onOpenConnections={vi.fn()}
      />,
    );

    const labels = calls[0]!.actions?.map((action) => action.label) ?? [];
    expect(labels).not.toContain('Restart Station');
    expect(labels).toContain('Manage Stations');
    // The failed arm dropped `detail` entirely — the sentence that says WHY
    // ownership could not be established.
    expect(calls[0]!.message).toContain('registry is unavailable');
  });

  test('a crashed sidecar keeps its stderr out of the banner', () => {
    // `detail` carries two different kinds of thing depending on who wrote
    // it. On the sidecar crash path the host stores the last 16 lines of the
    // child's stderr there — and BannerHost renders `message` as plain text
    // with no clamp, so appending it pastes a stack trace and absolute home
    // paths into chrome.
    const calls = presented();
    render(
      <BundledServiceBanner
        status={{
          ...baseStatus,
          phase: 'failed' as const,
          ownership: 'sidecar' as const,
          message: 'Station tried to restart it 5 times without success.',
          detail:
            'Error: listen EADDRINUSE\n    at Server.setupListenHandle\n' +
            '/Users/someone/Library/Application Support/station/logs/x.log',
        }}
        onRestart={vi.fn()}
        onOpenConnections={vi.fn()}
      />,
    );

    expect(calls[0]!.message).toContain('5 times without success');
    expect(calls[0]!.message).not.toContain('EADDRINUSE');
    expect(calls[0]!.message).not.toContain('/Users/someone');
    // It CAN still be restarted, so the affordance stays.
    const labels = calls[0]!.actions?.map((action) => action.label) ?? [];
    expect(labels).toContain('Restart Station');
  });

  test('a fail-closed home offers no Restart, because restarting cannot fix it', () => {
    // The host's own message says so. Ownership alone let the button through.
    const calls = presented();
    render(
      <BundledServiceBanner
        status={{
          ...baseStatus,
          phase: 'failed' as const,
          ownership: 'sidecar' as const,
          failClosed: true,
          message:
            'The Station home has an incompatible schema. Restarting cannot fix this.',
        }}
        onRestart={vi.fn()}
        onOpenConnections={vi.fn()}
      />,
    );

    const labels = calls[0]!.actions?.map((action) => action.label) ?? [];
    expect(labels).not.toContain('Restart Station');
  });

  test('an unresolved owner is not reported as a stopped local Station', () => {
    const calls = presented();
    render(
      <BundledServiceBanner
        status={{
          ...baseStatus,
          phase: 'failed' as const,
          ownership: 'none' as const,
          message: 'Station could not select a safe local owner.',
        }}
        onRestart={vi.fn()}
        onOpenConnections={vi.fn()}
      />,
    );

    // In the ambiguous-registry case a service may well be running. Nothing
    // here observed that either way, so the badge must not claim it.
    expect(calls[0]!.badge).not.toBe('Local Station stopped');
    expect(calls[0]!.badge).toBe('Local owner unresolved');
  });
});

describe('BundledServiceBanner dismissibility (station#3476)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    bannerStore.reset();
  });

  test.each([
    ['stopped', 'sidecar'],
    ['stopped', 'none'],
    ['starting', 'sidecar'],
    ['restarting', 'sidecar'],
    ['stopping', 'none'],
  ] as const)(
    'a non-blocking %s/%s notice can be dismissed',
    (phase, ownership) => {
      const calls = presented();
      render(
        <BundledServiceBanner
          status={{ ...baseStatus, phase, ownership }}
          onRestart={vi.fn()}
          onOpenConnections={vi.fn()}
        />,
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]!.priority).toBe(BANNER_PRIORITY.connectionTransient);
      // BannerHost gates BOTH the close button and swipe-to-dismiss on this
      // one field — the owner's complaint was that neither was available.
      expect(calls[0]!.dismissible).toBe(true);
    },
  );

  test.each(['sidecar', 'none'] as const)(
    'a failed %s home stays non-dismissible (station#3432)',
    (ownership) => {
      // Unchanged on purpose: dismissing a connection-blocking banner hides
      // the action needed to get a Station back.
      const calls = presented();
      render(
        <BundledServiceBanner
          status={{ ...baseStatus, phase: 'failed' as const, ownership }}
          onRestart={vi.fn()}
          onOpenConnections={vi.fn()}
        />,
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]!.priority).toBe(BANNER_PRIORITY.connectionBlocking);
      expect(calls[0]!.tone).toBe('error');
      expect(calls[0]!.dismissible).toBe(false);
    },
  );

  test('dismissing the stopped notice does not swallow the failure that follows', () => {
    // Against the REAL store, because this is a store-contract hazard rather
    // than a component one: user-dismissal suppression is keyed by
    // `id` + `occurrence`, and a dismissible banner with NO occurrence stays
    // suppressed until `clear`. Without `occurrence` the failed banner below
    // is silently dropped — a genuinely broken Station reported to nobody,
    // caused by the dismissibility this change adds.
    const view = render(
      <BundledServiceBanner
        status={{ ...baseStatus, ownership: 'sidecar' as const }}
        onRestart={vi.fn()}
        onOpenConnections={vi.fn()}
      />,
    );
    expect(bannerStore.getSnapshot()).toHaveLength(1);

    bannerStore.dismiss(BANNER_IDS.bundledService, { reason: 'user' });
    bannerStore.flushExits();
    expect(bannerStore.getSnapshot()).toHaveLength(0);

    view.rerender(
      <BundledServiceBanner
        status={{
          ...baseStatus,
          phase: 'failed' as const,
          ownership: 'sidecar' as const,
          message: 'HOST-NARRATION-SENTINEL crashed.',
        }}
        onRestart={vi.fn()}
        onOpenConnections={vi.fn()}
      />,
    );

    const live = bannerStore.getSnapshot();
    expect(live).toHaveLength(1);
    expect(live[0]!.message).toContain('HOST-NARRATION-SENTINEL');
    expect(live[0]!.dismissible).toBe(false);
  });

  test('a dismissed notice stays dismissed while its state is unchanged', () => {
    // The other half of the occurrence contract: keying it too finely (on a
    // field that churns, e.g. `attempt`) would re-present a banner the user
    // just closed on the next status poll.
    const view = render(
      <BundledServiceBanner
        status={{ ...baseStatus, ownership: 'sidecar' as const }}
        onRestart={vi.fn()}
        onOpenConnections={vi.fn()}
      />,
    );
    bannerStore.dismiss(BANNER_IDS.bundledService, { reason: 'user' });
    bannerStore.flushExits();

    // A fresh object with the same decisive fields — what a status poll emits.
    view.rerender(
      <BundledServiceBanner
        status={{ ...baseStatus, ownership: 'sidecar' as const, attempt: 2 }}
        onRestart={vi.fn()}
        onOpenConnections={vi.fn()}
      />,
    );

    expect(bannerStore.getSnapshot()).toHaveLength(0);
  });
});
