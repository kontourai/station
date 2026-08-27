/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

/**
 * station#3677 PR 3 — the trusted-approval flow on a native-broker host.
 * The claim under test: when the host reports the native consent broker,
 * `requestTrustedApproval` opens NO popup and resolves from the broker's
 * server-settled status; refusals and denials both resolve to "not granted".
 * The web popup flow stays byte-identical when the broker is absent.
 */

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3141' }),
}));

const nativeBroker = vi.hoisted(() => ({
  reviewer: null as
    | null
    | ((requestId: string) => Promise<{ status: string; value?: unknown }>),
}));
vi.mock('../../platform/native/useNativeConsentBroker', () => ({
  useNativeConsentBroker: () => nativeBroker.reviewer,
}));

import { PermissionManager, usePermissions } from '../PermissionManager';

function Harness({ onResult }: { onResult: (granted: boolean) => void }) {
  const { requestConsent } = usePermissions();
  return (
    <button
      type="button"
      onClick={() => {
        void requestConsent('demo-plugin', 'Demo Plugin', [
          { permission: 'plugin.server', tier: 'trusted' },
        ]).then(onResult);
      }}
    >
      Ask
    </button>
  );
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  nativeBroker.reviewer = null;
});

async function driveTrustedApproval(onResult: (granted: boolean) => void) {
  render(
    <PermissionManager>
      <Harness onResult={onResult} />
    </PermissionManager>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
  // The in-app modal (which only OPENS the request) appears first.
  fireEvent.click(
    await screen.findByRole('button', { name: 'Review trusted access' }),
  );
}

test('native broker host: no popup, approval resolves from the broker status', async () => {
  fetchMock.mockResolvedValue(
    jsonResponse({ approval: { id: 'txn-1', reviewUrl: '/consent/review' } }),
  );
  const reviewed: string[] = [];
  nativeBroker.reviewer = async (requestId) => {
    reviewed.push(requestId);
    return { status: 'ok', value: { status: 'approved' } };
  };
  const open = vi.spyOn(window, 'open');
  const results: boolean[] = [];

  await driveTrustedApproval((granted) => results.push(granted));

  await waitFor(() => expect(results).toEqual([true]));
  expect(reviewed).toEqual(['txn-1']);
  expect(open).not.toHaveBeenCalled();
});

test('native broker host: a server-settled denial resolves false', async () => {
  fetchMock.mockResolvedValue(
    jsonResponse({ approval: { id: 'txn-2', reviewUrl: '/consent/review' } }),
  );
  nativeBroker.reviewer = async () => ({
    status: 'ok',
    value: { status: 'denied' },
  });
  const results: boolean[] = [];

  await driveTrustedApproval((granted) => results.push(granted));

  await waitFor(() => expect(results).toEqual([false]));
});

test('native broker host: a broker refusal resolves false, never a silent grant', async () => {
  fetchMock.mockResolvedValue(
    jsonResponse({ approval: { id: 'txn-3', reviewUrl: '/consent/review' } }),
  );
  nativeBroker.reviewer = async () => ({
    status: 'error',
    message: 'This dialog is stale',
  });
  const results: boolean[] = [];

  await driveTrustedApproval((granted) => results.push(granted));

  await waitFor(() => expect(results).toEqual([false]));
});

test('station#3731: no review URL and no native broker resolves false, and opens no popup', async () => {
  // The listener is down and this caller cannot decide natively, so the
  // server returns a transaction with no browser way in. Opening a popup at
  // nothing would stall the user on a blank window; the honest outcome is
  // "not granted".
  fetchMock.mockResolvedValue(
    jsonResponse({ approval: { id: 'txn-5', reviewUrl: null } }),
  );
  const open = vi.spyOn(window, 'open');
  const results: boolean[] = [];

  await driveTrustedApproval((granted) => results.push(granted));

  await waitFor(() => expect(results).toEqual([false]));
  expect(open).not.toHaveBeenCalled();
});

test('without the broker, the popup flow still opens the distinct-origin page', async () => {
  fetchMock
    .mockResolvedValueOnce(
      jsonResponse({
        approval: {
          id: 'txn-4',
          reviewUrl: 'http://localhost:4141/consent/review',
        },
      }),
    )
    .mockResolvedValue(
      jsonResponse({ approval: { id: 'txn-4', status: 'approved' } }),
    );
  const opened: string[] = [];
  const reviewWindow = {
    opener: {} as unknown,
    closed: false,
    location: {
      replace: (url: string) => {
        opened.push(url);
      },
    },
  };
  vi.spyOn(window, 'open').mockReturnValue(reviewWindow as unknown as Window);
  const results: boolean[] = [];

  await driveTrustedApproval((granted) => results.push(granted));

  await waitFor(() => expect(results).toEqual([true]), { timeout: 5000 });
  expect(opened).toEqual(['http://localhost:4141/consent/review']);
  expect(reviewWindow.opener).toBeNull();
});
