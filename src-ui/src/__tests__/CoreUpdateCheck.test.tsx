/**
 * @vitest-environment jsdom
 */

import type {
  CoreUpdateRestartExpectation,
  CoreUpdateRestartStatus,
  CoreUpdateStatus,
} from '@kontourai/station-sdk';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const { requestCoreUpdateRestartStatus } = vi.hoisted(() => ({
  requestCoreUpdateRestartStatus: vi.fn(),
}));

const queryState: {
  data: CoreUpdateStatus | undefined;
  isFetching: boolean;
  error: Error | null;
  refetch: () => void;
} = {
  data: undefined,
  isFetching: false,
  error: null,
  refetch: vi.fn(),
};

let applyOptions:
  | {
      onSuccess?: (data: {
        success: boolean;
        updating?: boolean;
        restarting?: boolean;
        restart?: CoreUpdateRestartExpectation;
      }) => void;
    }
  | undefined;

vi.mock('@kontourai/station-sdk', () => ({
  useCoreUpdateStatusQuery: () => queryState,
  useApplyCoreUpdateMutation: (
    _apiBase: string,
    options: typeof applyOptions,
  ) => {
    applyOptions = options;
    return {
      mutate: vi.fn(),
      isPending: false,
      error: null,
    };
  },
}));

vi.mock('@kontourai/station-sdk/core-update-restart-status', () => ({
  requestCoreUpdateRestartStatus,
}));

const { CoreUpdateCheck } = await import('../views/settings/CoreUpdateCheck');

const STARTED_AT = new Date('2026-08-09T12:00:00.000Z');

function expectedRestart(
  overrides: Partial<CoreUpdateRestartExpectation> = {},
): CoreUpdateRestartExpectation {
  return {
    expectedHash: 'bbbbbbb',
    expectedInstanceId: 'instance-1',
    deadlineAt: new Date(STARTED_AT.getTime() + 95_000).toISOString(),
    ...overrides,
  };
}

function restartStatus(
  status: 'pending' | 'verified' | 'failed',
  expected = expectedRestart(),
): CoreUpdateRestartStatus {
  return status === 'pending'
    ? { status, ...expected }
    : {
        status,
        ...expected,
        resolvedAt: new Date(STARTED_AT.getTime() + 1_000).toISOString(),
      };
}

function renderWith(status: CoreUpdateStatus) {
  queryState.data = status;
  return render(<CoreUpdateCheck apiBase="http://localhost:3141" />);
}

afterEach(() => {
  vi.useRealTimers();
  requestCoreUpdateRestartStatus.mockReset();
  vi.mocked(queryState.refetch).mockReset();
  applyOptions = undefined;
});

describe('CoreUpdateCheck affordances by applyMethod (AC5)', () => {
  test('a bundle with an update shows reinstall guidance, never the apply button', () => {
    renderWith({
      installKind: 'desktop-bundle',
      applyMethod: 'reinstall',
      channel: 'nightly',
      branch: 'main',
      currentHash: 'aaaaaaa',
      remoteHash: 'bbbbbbb',
      updateAvailable: true,
    });
    expect(screen.queryByRole('button', { name: /^Update \(/ })).toBeNull();
    expect(
      screen.getByText(/Update available on the nightly channel/),
    ).toBeTruthy();
    expect(screen.getByText(/Channel: nightly/)).toBeTruthy();
  });

  test('a source checkout with an update keeps the apply button', () => {
    renderWith({
      installKind: 'source-checkout',
      applyMethod: 'git-pull',
      branch: 'main',
      currentHash: 'aaaaaaa',
      remoteHash: 'bbbbbbb',
      behind: 2,
      ahead: 0,
      updateAvailable: true,
    });
    expect(
      screen.getByRole('button', { name: 'Update (2 commits behind)' }),
    ).toBeTruthy();
  });

  test('an unknown install renders its message without a bare "Current:" label', () => {
    renderWith({
      installKind: 'unknown',
      updateAvailable: false,
      message:
        'This install carries no update provenance (no git checkout and no build stamp), so updates cannot be checked from here.',
    });
    expect(screen.getByText(/no update provenance/).className).toContain(
      'settings__update-msg--warning',
    );
// No provenance fields → no meta row at all, not empty labels.
    expect(screen.queryByText(/Current:/)).toBeNull();
    expect(screen.queryByText(/Branch:/)).toBeNull();
  });

  test('remoteUnreachable renders the message as a warning, not an error', () => {
    renderWith({
      installKind: 'desktop-bundle',
      applyMethod: 'reinstall',
      channel: 'nightly',
      branch: 'main',
      currentHash: 'aaaaaaa',
      updateAvailable: false,
      remoteUnreachable: true,
      message: 'Could not reach https://github.com/kontourai/station.git.',
    });
    const message = screen.getByText(/Could not reach/);
    expect(message.className).toContain('settings__update-msg--warning');
// No false "Up to date" claim while the remote is unknown.
    expect(screen.queryByText(/Up to date/)).toBeNull();
  });
});

/**
 * 6-. A `git ls-remote` against a cold remote took ~30 s in the audit,
 * and for that whole window the card replaced Channel/Branch/Current/Latest
 * with one disabled "Checking…" — so the user LOST the answer they already had
 * in order to be told an answer was coming. The review confirmed the source
 * keeps `status` visible during `isFetching` but found the transition itself
 * unpinned, which is the only place it can regress.
 */
describe('re-check keeps the last known state (6-OPS-44)', () => {
  const KNOWN: CoreUpdateStatus = {
    installKind: 'source-checkout',
    applyMethod: 'git-pull',
    channel: 'nightly',
    branch: 'main',
    currentHash: 'aaaaaaa',
    remoteHash: 'aaaaaaa',
    behind: 0,
    ahead: 0,
    updateAvailable: false,
  };

  test('a first check with nothing known shows the wait alone', () => {
    queryState.isFetching = true;
    queryState.data = undefined;
    render(<CoreUpdateCheck apiBase="http://localhost:3141" />);

    expect(screen.getByLabelText('Checking for updates')).toBeTruthy();
    expect(screen.queryByText(/Channel: nightly/)).toBeNull();
    expect(screen.queryByText(/showing the last result/)).toBeNull();
    queryState.isFetching = false;
  });

  test('a RE-check annotates the known state instead of replacing it', () => {
    queryState.isFetching = false;
    const { rerender } = renderWith(KNOWN);
    expect(screen.getByText(/Channel: nightly/)).toBeTruthy();

// The transition under test: the same card, now refetching.
    queryState.isFetching = true;
    rerender(<CoreUpdateCheck apiBase="http://localhost:3141" />);

    expect(screen.getByText(/Channel: nightly/)).toBeTruthy();
    expect(screen.getByText(/Current: aaaaaaa/)).toBeTruthy();
    expect(screen.getByText(/showing the last result/)).toBeTruthy();
// The skeleton is for a wait with nothing to preserve; this is not one.
    expect(screen.queryByLabelText('Checking for updates')).toBeNull();
    queryState.isFetching = false;
  });
});

describe('git-based self-update affordances (#1624)', () => {
  test('self-update shows the real Update & restart button', () => {
    renderWith({
      installKind: 'desktop-bundle',
      applyMethod: 'self-update',
      channel: 'nightly',
      branch: 'main',
      currentHash: 'aaaaaaa',
      remoteHash: 'bbbbbbb',
      updateAvailable: true,
    });
    expect(
      screen.getByRole('button', {
        name: 'Update & restart (aaaaaaa → bbbbbbb)',
      }),
    ).toBeTruthy();
// No reinstall guidance when a real apply path exists.
    expect(screen.queryByText(/Update by reinstalling/)).toBeNull();
  });

  function renderRestartingUpdate() {
    return renderWith({
      installKind: 'source-checkout',
      applyMethod: 'git-pull',
      updateAvailable: true,
      currentHash: 'aaaaaaa',
      remoteHash: 'bbbbbbb',
      behind: 1,
    });
  }

  function beginRestart(restart = expectedRestart()) {
    act(() => {
      applyOptions?.onSuccess?.({ success: true, restarting: true, restart });
    });
  }

  test('aborts a never-resolving watchdog-status request at the authoritative deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STARTED_AT);
    let signal: AbortSignal | undefined;
    requestCoreUpdateRestartStatus.mockImplementation(
      (_apiBase: string, requestSignal: AbortSignal) =>
        new Promise<CoreUpdateRestartStatus>((_resolve, reject) => {
          signal = requestSignal;
          requestSignal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    renderRestartingUpdate();
    beginRestart();
    await act(async () => {});

    expect(signal?.aborted).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(95_000);
    });

    expect(signal?.aborted).toBe(true);
    expect(screen.getByText(/could not verify the expected restarted server/));
    expect(queryState.refetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check for Updates' }));
    expect(
      screen.queryByText(/could not verify the expected restarted server/),
    ).toBeNull();
  });

  test('only accepts a matching durable verified watchdog record, never a stale 200-equivalent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STARTED_AT);
    requestCoreUpdateRestartStatus.mockResolvedValue(
      restartStatus('verified', expectedRestart({ expectedHash: 'oldhash' })),
    );
    renderRestartingUpdate();
    beginRestart();
    await act(async () => {});

    expect(screen.getByText(/could not verify the expected restarted server/));
    expect(queryState.refetch).not.toHaveBeenCalled();
  });

  test('refreshes only after the matching watchdog writes verified', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STARTED_AT);
    const expected = expectedRestart();
    requestCoreUpdateRestartStatus
      .mockResolvedValueOnce(restartStatus('pending', expected))
      .mockResolvedValueOnce(restartStatus('verified', expected));
    renderRestartingUpdate();
    beginRestart(expected);
    await act(async () => {});
    expect(screen.getByText(/Restarting — verifying/)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(queryState.refetch).toHaveBeenCalled();
    expect(screen.queryByText(/Restarting — verifying/)).toBeNull();
  });

  test('surfaces a durable watchdog failure rather than retrying it as health', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STARTED_AT);
    requestCoreUpdateRestartStatus.mockResolvedValue(restartStatus('failed'));
    renderRestartingUpdate();
    beginRestart();
    await act(async () => {});

    expect(screen.getByText(/could not verify the expected restarted server/));
    expect(queryState.refetch).not.toHaveBeenCalled();
  });

  test('aborts and ignores a late status result when apiBase changes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STARTED_AT);
    let resolveStatus: ((status: CoreUpdateRestartStatus) => void) | undefined;
    let signal: AbortSignal | undefined;
    requestCoreUpdateRestartStatus.mockImplementation(
      (_apiBase: string, requestSignal: AbortSignal) =>
        new Promise<CoreUpdateRestartStatus>((resolve) => {
          signal = requestSignal;
          resolveStatus = resolve;
        }),
    );
    const rendered = renderRestartingUpdate();
    beginRestart();
    await act(async () => {});

    rendered.rerender(<CoreUpdateCheck apiBase="http://localhost:4141" />);
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByText(/Restarting — verifying/)).toBeNull();
    expect(
      screen.queryByText(/could not verify the expected restarted server/),
    ).toBeNull();
    await act(async () => {
      resolveStatus?.(restartStatus('verified'));
    });

    expect(queryState.refetch).not.toHaveBeenCalled();
    expect(requestCoreUpdateRestartStatus).toHaveBeenCalledWith(
      'http://localhost:3141',
      signal,
    );
  });

  test('rejects a malformed terminal result from the SDK boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STARTED_AT);
    requestCoreUpdateRestartStatus.mockResolvedValue({
      status: 'verified',
      ...expectedRestart(),
    } as never);
    renderRestartingUpdate();
    beginRestart();
    await act(async () => {});

    expect(screen.getByText(/could not verify the expected restarted server/));
    expect(queryState.refetch).not.toHaveBeenCalled();
  });

  test('aborts an in-flight status request when the user rechecks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STARTED_AT);
    let signal: AbortSignal | undefined;
    requestCoreUpdateRestartStatus.mockImplementation(
      (_apiBase: string, requestSignal: AbortSignal) =>
        new Promise<CoreUpdateRestartStatus>(() => {
          signal = requestSignal;
        }),
    );
    renderRestartingUpdate();
    beginRestart();
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Check for Updates' }));
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByText(/Restarting — verifying/)).toBeNull();
  });

  test('aborts an in-flight status request on unmount', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STARTED_AT);
    let signal: AbortSignal | undefined;
    requestCoreUpdateRestartStatus.mockImplementation(
      (_apiBase: string, requestSignal: AbortSignal) =>
        new Promise<CoreUpdateRestartStatus>(() => {
          signal = requestSignal;
        }),
    );
    const rendered = renderRestartingUpdate();
    beginRestart();
    await act(async () => {});

    rendered.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
