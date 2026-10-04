/**
 * @vitest-environment jsdom
 *
 * #3157: the usage-limit banner, rendered as the real component over the real
 * query hook. Only the network is stubbed: each response is the exact
 * envelope and projection shape the server's `/usage-limit` routes produce
 * (`ConnectionRecoveryProjection` from `readRecoveryProjection`, and
 * `{ result, recovery }` from `actOnUsageLimitRecovery`).
 */

import type { ConnectionRecoveryProjection } from '@kontourai/station-contracts/connection-recovery';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { UsageLimitBanner } from '../components/chat-dock/UsageLimitBanner';

const API = 'http://localhost:3242';
const THREAD = 'limited-session';
const NOW = new Date('2026-09-24T21:00:00.000Z');
const RESET_AT = '2026-09-24T23:00:00.000Z';

function projection(
  patch: Partial<ConnectionRecoveryProjection> = {},
): ConnectionRecoveryProjection {
  return {
    failureKind: 'rate-limit',
    scope: 'account',
    decision: 'wait-until-reset',
    outcome: 'armed',
    dueAt: RESET_AT,
    attempts: 0,
    maxAttempts: 1,
    usageLimit: true,
    autoResume: true,
    updatedAt: '2026-09-24T21:00:00.000Z',
    ...patch,
  };
}

interface Call {
  method: string;
  url: string;
}
let calls: Call[];
/** What each route answers next; a function is consulted per request. */
let answers: {
  read: () => unknown;
  resume: () => unknown;
  cancel: () => unknown;
  status?: number;
};

function envelope(data: unknown, status = 200) {
  return new Response(JSON.stringify({ success: status === 200, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubEnv('TZ', 'UTC');
  // Only the clock is fixed: real timers keep running for the query.
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  calls = [];
  answers = {
    read: () => ({ recovery: projection() }),
    resume: () => ({
      result: { kind: 'resumed' },
      recovery: projection({ outcome: 'resumed', attempts: 1 }),
    }),
    cancel: () => ({
      result: { kind: 'canceled' },
      recovery: projection({
        outcome: 'canceled',
        outcomeReason: 'user-canceled',
      }),
    }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      const leaf = url.endsWith('/resume')
        ? 'resume'
        : url.endsWith('/cancel')
          ? 'cancel'
          : 'read';
      return envelope(answers[leaf](), answers.status ?? 200);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function renderBanner(
  props: Partial<Parameters<typeof UsageLimitBanner>[0]> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (extra: typeof props = {}) => (
    <QueryClientProvider client={queryClient}>
      <UsageLimitBanner
        apiBase={API}
        scope={undefined}
        threadId={THREAD}
        active
        refreshKey="1"
        {...props}
        {...extra}
      />
    </QueryClientProvider>
  );
  const view = render(ui());
  return {
    ...view,
    rerenderWith: (extra: typeof props) => view.rerender(ui(extra)),
  };
}

const banner = () => screen.findByTestId('usage-limit-banner');
const button = (name: string) => screen.queryByRole('button', { name });
const posts = () => calls.filter((call) => call.method === 'POST');

describe('UsageLimitBanner (#3157)', () => {
  test('shows the reset as a local time and says it will resume when auto-resume is on', async () => {
    renderBanner();
    const element = await banner();
    expect(element.textContent).toContain(
      'Usage limit reached · Resets 11:00 PM',
    );
    expect(element.querySelector('time')?.getAttribute('datetime')).toBe(
      RESET_AT,
    );
    expect(element.textContent).toContain(
      'Station will resume this conversation at 11:00 PM.',
    );
    expect(button('Resume now')).not.toBeNull();
    expect(button('Cancel auto-resume')).not.toBeNull();
    // It reads this Session's own projection, on the documented route.
    expect(calls[0]).toEqual({
      method: 'GET',
      url: `${API}/api/orchestration/sessions/${THREAD}/usage-limit`,
    });
  });

  test('with auto-resume off it says so and holds Resume now until the reset passes', async () => {
    answers.read = () => ({
      recovery: projection({
        autoResume: false,
        dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });
    renderBanner();
    const element = await banner();
    expect(element.textContent).toContain('Auto-resume is off.');
    expect(element.textContent).not.toContain('will resume');
    expect(button('Resume now')).toBeNull();
    expect(button('Cancel auto-resume')).toBeNull();
  });

  test('with auto-resume off, the reset passing reads the settled stop and offers Resume now', async () => {
    vi.useRealTimers();
    const dueAt = new Date(Date.now() + 2_000).toISOString();
    answers.read = () =>
      Date.now() < Date.parse(dueAt)
        ? { recovery: projection({ autoResume: false, dueAt }) }
        : {
            recovery: projection({
              autoResume: undefined,
              outcome: 'manual',
              outcomeReason: 'auto-resume-off',
              dueAt,
            }),
          };
    renderBanner();
    await banner();
    expect(button('Resume now')).toBeNull();
    await waitFor(() => expect(button('Resume now')).not.toBeNull(), {
      timeout: 6_000,
    });
    expect(screen.getByTestId('usage-limit-banner').textContent).toContain(
      'Reset ',
    );
    expect(button('Cancel auto-resume')).toBeNull();
  }, 10_000);

  test('an unknown reset says plainly that it is manual, and still offers Resume now', async () => {
    answers.read = () => ({
      recovery: projection({
        decision: 'manual',
        outcome: 'manual',
        dueAt: undefined,
        autoResume: undefined,
      }),
    });
    renderBanner();
    const element = await banner();
    expect(element.textContent).toContain('Usage limit reached');
    expect(element.textContent).not.toMatch(/Resets?\s\d/);
    expect(element.textContent).toContain("can't tell when your limit resets");
    expect(button('Resume now')).not.toBeNull();
    expect(button('Cancel auto-resume')).toBeNull();
  });

  test('Resume now dispatches the resume and then shows only that it is resuming', async () => {
    renderBanner();
    await banner();
    fireEvent.click(button('Resume now') as HTMLElement);
    await waitFor(() =>
      expect(screen.getByTestId('usage-limit-banner').textContent).toContain(
        'Resuming this conversation',
      ),
    );
    expect(posts()).toEqual([
      {
        method: 'POST',
        url: `${API}/api/orchestration/sessions/${THREAD}/usage-limit/resume`,
      },
    ]);
    expect(button('Resume now')).toBeNull();
    expect(button('Cancel auto-resume')).toBeNull();
  });

  test('Cancel auto-resume retires the stop through the server and the banner updates to the reason', async () => {
    renderBanner();
    await banner();
    fireEvent.click(button('Cancel auto-resume') as HTMLElement);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'Auto-resume canceled.',
      ),
    );
    expect(posts()).toEqual([
      {
        method: 'POST',
        url: `${API}/api/orchestration/sessions/${THREAD}/usage-limit/cancel`,
      },
    ]);
    // No stale actions once the stop has settled.
    expect(button('Resume now')).toBeNull();
    expect(button('Cancel auto-resume')).toBeNull();
    fireEvent.click(button('Dismiss') as HTMLElement);
    expect(screen.queryByTestId('usage-limit-banner')).toBeNull();
  });

  test('a click on a banner that has since settled reads back the real state and offers nothing', async () => {
    answers.resume = () => ({
      result: { kind: 'not-waiting' },
      recovery: projection({
        outcome: 'canceled',
        outcomeReason: 'superseded',
      }),
    });
    renderBanner();
    await banner();
    fireEvent.click(button('Resume now') as HTMLElement);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'a newer message was sent',
      ),
    );
    expect(button('Resume now')).toBeNull();
    expect(button('Cancel auto-resume')).toBeNull();
  });

  test('a stop retired while the banner is open shows its reason and drops the actions', async () => {
    const { rerenderWith } = renderBanner();
    await banner();
    answers.read = () => ({
      recovery: projection({
        outcome: 'canceled',
        outcomeReason: 'request-pending',
      }),
    });
    rerenderWith({ refreshKey: '2' });
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'Auto-resume canceled: the conversation was waiting on a request.',
      ),
    );
    expect(button('Resume now')).toBeNull();
    expect(button('Cancel auto-resume')).toBeNull();
  });

  test('a stop that settled before the banner opened is not announced and offers nothing', async () => {
    answers.read = () => ({
      recovery: projection({
        outcome: 'canceled',
        outcomeReason: 'session-ended',
      }),
    });
    renderBanner();
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('usage-limit-banner')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('no banner without a usage-limit intent', async () => {
    answers.read = () => ({ recovery: null });
    renderBanner();
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('usage-limit-banner')).toBeNull();
  });

  test('a conversation the snapshot does not call limited renders nothing and asks the server nothing', async () => {
    renderBanner({ active: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('usage-limit-banner')).toBeNull();
    expect(calls).toEqual([]);
  });

  test('a failed action says so and keeps the actions so the user can try again', async () => {
    answers.cancel = () => ({ error: 'boom' });
    renderBanner();
    await banner();
    answers.status = 500;
    fireEvent.click(button('Cancel auto-resume') as HTMLElement);
    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull());
    expect(button('Cancel auto-resume')).not.toBeNull();
    expect(button('Resume now')).not.toBeNull();
  });
});
