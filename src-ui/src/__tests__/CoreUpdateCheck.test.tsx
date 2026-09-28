/**
 * @vitest-environment jsdom
 */

import type { ServiceUpdateProgress } from '@kontourai/station-contracts/system-status';
import type {
  CoreUpdateRestartExpectation,
  CoreUpdateRestartStatus,
  CoreUpdateStatus,
} from '@kontourai/station-sdk';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ConnectedServerUpdateContext } from '../hooks/useConnectedServerUpdateContext';

const { requestCoreUpdateRestartStatus } = vi.hoisted(() => ({
  requestCoreUpdateRestartStatus: vi.fn(),
}));

const queryState: {
  data: CoreUpdateStatus | undefined;
  isFetching: boolean;
  error: Error | null;
  refetch: () => void;
  dataUpdatedAt: number;
} = {
  data: undefined,
  isFetching: false,
  error: null,
  refetch: vi.fn(),
  dataUpdatedAt: 1_786_000_000_000,
};

let applyOptions:
  | {
      onSuccess?: (data: {
        success: boolean;
        updating?: boolean;
        restarting?: boolean;
        restart?: CoreUpdateRestartExpectation;
        serviceUpdate?: { requestId: string };
      }) => void;
    }
  | undefined;
/** The service-update progress poll (#2675 D3): its data and its options. */
const serviceProgressState: {
  data: ServiceUpdateProgress | undefined;
  isError: boolean;
} = { data: undefined, isError: false };
let serviceProgressOptions:
  | {
      enabled: boolean;
      refetchInterval: (
        progress: ServiceUpdateProgress | undefined,
      ) => number | false;
    }
  | undefined;
const scopeOptionsCalls: Array<{ scopeKey?: string } | undefined> = [];
const applyReset = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useCoreUpdateStatusQuery: (
    _apiBase: string,
    _config: unknown,
    scope: { scopeKey?: string } | undefined,
  ) => {
    scopeOptionsCalls.push(scope);
    return queryState;
  },
  useServiceUpdateProgressQuery: (
    _apiBase: string,
    options: typeof serviceProgressOptions,
  ) => {
    serviceProgressOptions = options;
    return serviceProgressState;
  },
  useApplyCoreUpdateMutation: (
    _apiBase: string,
    options: typeof applyOptions,
  ) => {
    applyOptions = options;
    return {
      mutate: vi.fn(),
      reset: applyReset,
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
const VIEW_IDENTITY = {
  instanceId: 'view-instance',
  bootId: '11111111-1111-4111-8111-111111111111',
  sha: 'a'.repeat(40),
};
const ANSWER_IDENTITY = {
  ...VIEW_IDENTITY,
  shaSource: 'build-stamp' as const,
};

function makeContext(
  overrides: Partial<ConnectedServerUpdateContext> = {},
): ConnectedServerUpdateContext {
  return {
    scopeKey: 'scope-a',
    apiBase: 'http://localhost:3141',
    connectionName: 'station',
    reachability: 'connected',
    kind: 'remote-server',
    identity: VIEW_IDENTITY,
    identitySettled: true,
    identityReady: true,
    nativeObservationPending: false,
    claimedOwnerUnresolved: false,
    isCurrent: () => true,
    ...overrides,
  };
}

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

function renderWith(
  status: CoreUpdateStatus,
  context: ConnectedServerUpdateContext | null = makeContext(),
) {
  queryState.data = status;
  queryState.error = null;
  return render(
    <CoreUpdateCheck apiBase="http://localhost:3141" context={context} />,
  );
}

/** A behind source checkout whose answering identity matches the view. */
function behindCheckout(
  overrides: Partial<CoreUpdateStatus> = {},
): CoreUpdateStatus {
  return {
    installKind: 'source-checkout',
    applyMethod: 'git-pull',
    branch: 'main',
    currentHash: 'aaaaaaa',
    remoteHash: 'bbbbbbb',
    behind: 2,
    ahead: 0,
    updateAvailable: true,
    serverIdentity: ANSWER_IDENTITY,
    provenanceIssue: null,
    technicalDetail: null,
    selfUpdateUnavailableReason: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  requestCoreUpdateRestartStatus.mockReset();
  vi.mocked(queryState.refetch).mockReset();
  applyOptions = undefined;
  scopeOptionsCalls.length = 0;
  queryState.isFetching = false;
  serviceProgressState.data = undefined;
  serviceProgressState.isError = false;
  serviceProgressOptions = undefined;
  applyReset.mockReset();
  queryState.dataUpdatedAt = 1_786_000_000_000;
});

describe('CoreUpdateCheck affordances by applyMethod (AC5)', () => {
  test('a reinstall bundle with a differing stamp shows the S10 source-ref facts, never an apply button or release claim', () => {
    renderWith({
      installKind: 'desktop-bundle',
      applyMethod: 'reinstall',
      channel: 'nightly',
      branch: 'main',
      currentHash: 'aaaaaaa',
      remoteHash: 'bbbbbbb',
      updateAvailable: true,
    });
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
    // S10, verbatim: SHA inequality is a build-stamp fact, never a release.
    const differsLine = screen.getByText(
      'This build differs from the configured source ref. This check does not establish whether an installable release is available.',
    );
    // The differs state must NOT speak in the success voice — no success
    // tone class, no success glyph (verifier injection: tone/glyph flipped).
    expect(differsLine.className).toContain('settings__update-msg--warning');
    expect(differsLine.className).not.toContain(
      'settings__update-msg--success',
    );
    expect(differsLine.className).not.toContain(
      'settings__update-text--success',
    );
    expect(differsLine.querySelector('svg')).toBeNull();
    // #2144 slice 6 item C: the channel now states where it came from.
    expect(
      screen.getByText(/Update channel: nightly \(set at install\)/),
    ).toBeTruthy();
    expect(screen.getByText(/Build: aaaaaaa/)).toBeTruthy();
    expect(screen.getByText(/Source ref: bbbbbbb/)).toBeTruthy();
    // The retired heuristics stay retired.
    expect(screen.queryByText(/one-click updates are coming/)).toBeNull();
    expect(screen.queryByText(/Latest:/)).toBeNull();
    expect(
      screen.queryByText(/Update available on the nightly channel/),
    ).toBeNull();
  });

  test('a behind source checkout whose answering identity matches the view offers Update server checkout', () => {
    renderWith(behindCheckout());
    expect(
      screen.getByRole('button', { name: 'Update server checkout' }),
    ).toBeTruthy();
    // S5 wording, with the checkout count carried by the line, not the button.
    expect(
      screen.getByText(
        'Server checkout is 2 commits behind its configured upstream.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Checkout: aaaaaaa/)).toBeTruthy();
    expect(screen.getByText(/Source ref: bbbbbbb/)).toBeTruthy();
  });

  test('a behind checkout under the installed service offers no apply and says how to update instead (#2674)', () => {
    // The exact shape the server writes for a supervised source checkout:
    // the code AND the human remedy, on an otherwise apply-eligible compare.
    renderWith(
      behindCheckout({
        selfUpdateUnavailableCode: 'service-managed',
        selfUpdateUnavailableReason:
          'this server runs under the installed Station service, which restarts it on exit. Stop the service with "station service stop", run "station upgrade", then start it again with "station service start"',
      }),
    );
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
    expect(
      screen.getByText(
        /Server update cannot be applied from here: this server runs under the installed Station service/,
      ).textContent,
    ).toContain('"station service stop", run "station upgrade"');
    // The comparison facts are still reported; only the apply is withheld.
    expect(
      screen.getByText(
        'Server checkout is 2 commits behind its configured upstream.',
      ),
    ).toBeTruthy();
  });

  test('a refusal reason with a code this client does not know still closes the apply offer', () => {
    renderWith(
      behindCheckout({
        selfUpdateUnavailableCode: null,
        selfUpdateUnavailableReason: 'a future refusal',
      }),
    );
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
    expect(
      screen.getByText(
        'Server update cannot be applied from here: a future refusal.',
      ),
    ).toBeTruthy();
  });

  test('an unknown-provenance server renders the explicit refusal with its message collapsed into Technical details', () => {
    renderWith({
      installKind: 'unknown',
      updateAvailable: false,
      message:
        'This install carries no update provenance, so updates cannot be checked from here.',
      technicalDetail:
        'no git checkout and no station-nightly-source.json build stamp near /bundle/dist-server',
      provenanceIssue: 'missing',
    });
    // P2 refusal copy, not the server message, is the main explanation.
    expect(
      screen.getByText(
        'This server install has no usable update provenance. Station cannot determine whether a server update is available. Use the installation method that manages this server.',
      ),
    ).toBeTruthy();
    // No provenance fields → no meta row at all, not empty labels.
    expect(screen.queryByText(/Current:/)).toBeNull();
    expect(screen.queryByText(/Branch:/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
    // The server's own words survive only inside the CLOSED disclosure:
    // present in the DOM as escaped text, visually collapsed.
    const disclosed = screen.getByText(
      'This install carries no update provenance, so updates cannot be checked from here.',
    );
    const disclosure = disclosed.closest('details');
    expect(disclosure).toBeTruthy();
    expect(disclosure?.open).toBe(false);
    fireEvent.click(screen.getByText('Technical details'));
    expect(disclosure?.open).toBe(true);
    expect(
      screen.getByText(
        'no git checkout and no station-nightly-source.json build stamp near /bundle/dist-server',
      ),
    ).toBeTruthy();
  });

  test('an invalid stamp renders the invalid-provenance copy, distinct from missing', () => {
    renderWith({
      installKind: 'unknown',
      updateAvailable: false,
      message: 'This server’s update provenance is invalid.',
      technicalDetail: 'a build stamp exists at /b/x but is malformed',
      provenanceIssue: 'invalid-stamp',
    });
    expect(
      screen.getByText(
        'This server’s update provenance is invalid. Station cannot determine whether a server update is available. Use the installation method that manages this server.',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        'This server install has no usable update provenance.',
      ),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
  });

  test('remoteUnreachable renders the failed-check sentence as a warning, not an error or an up-to-date claim', () => {
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
    const message = screen.getByText(
      "Could not check the server's update source. Update availability is unknown.",
    );
    expect(message.className).toContain('settings__update-msg--warning');
    // No false "matches" claim while the remote is unknown.
    expect(screen.queryByText(/matches/)).toBeNull();
    expect(screen.queryByText(/Up to date/)).toBeNull();
    // The server's unreachable detail is disclosed, not shown as the verdict.
    fireEvent.click(screen.getByText('Technical details'));
    expect(
      screen.getByText(
        'Could not reach https://github.com/kontourai/station.git.',
      ),
    ).toBeTruthy();
  });
});

describe('comparison-priority matrix (update-ux PR4)', () => {
  test('an HTTP failure beats cached facts: failed check, error tone, no apply', () => {
    queryState.data = behindCheckout();
    queryState.error = new Error('HTTP 503');
    render(
      <CoreUpdateCheck
        apiBase="http://localhost:3141"
        context={makeContext()}
      />,
    );
    const line = screen.getByText(
      "Could not check the server's update source. Update availability is unknown.",
    );
    expect(line.className).toContain('settings__update-msg--error');
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
    fireEvent.click(screen.getByText('Technical details'));
    expect(screen.getByText('HTTP 503')).toBeTruthy();
  });

  test('noUpstream renders the muted no-upstream sentence', () => {
    renderWith({
      installKind: 'source-checkout',
      applyMethod: 'git-pull',
      branch: 'main',
      currentHash: 'aaaaaaa',
      updateAvailable: false,
      noUpstream: true,
    });
    const line = screen.getByText(
      'No upstream is configured for this server checkout.',
    );
    expect(line.className).not.toContain('settings__update-msg--success');
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
  });

  test('diverged beats behind: manual resolution required, no apply offer', () => {
    renderWith(behindCheckout({ behind: 3, ahead: 2 }));
    expect(
      screen.getByText(
        'Server checkout has diverged from its upstream. Manual resolution is required.',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
  });

  test('ahead-only renders the ahead sentence with no apply offer', () => {
    renderWith(behindCheckout({ behind: 0, ahead: 4, updateAvailable: false }));
    expect(
      screen.getByText(
        'Server checkout is 4 commits ahead of its configured upstream.',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
  });

  test('a matching checkout renders the success sentence with the glyph', () => {
    renderWith(
      behindCheckout({
        behind: 0,
        remoteHash: 'aaaaaaa',
        updateAvailable: false,
      }),
    );
    expect(
      screen.getByText('Server checkout matches its configured upstream.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Server checkout matches its configured upstream.')
        .className,
    ).toContain('settings__update-msg--success');
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
  });

  test('a matching stamp renders S9, never an update claim', () => {
    renderWith({
      installKind: 'desktop-bundle',
      applyMethod: 'reinstall',
      channel: 'nightly',
      currentHash: 'aaaaaaa',
      remoteHash: 'aaaaaaa',
      updateAvailable: false,
    });
    expect(
      screen.getByText('This build matches the configured source ref.'),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
  });

  test('missing comparison facts render no claim and no success icon', () => {
    renderWith({
      installKind: 'desktop-bundle',
      applyMethod: 'reinstall',
      channel: 'nightly',
      updateAvailable: true,
    });
    expect(screen.queryByText(/matches/)).toBeNull();
    expect(screen.queryByText(/differs/)).toBeNull();
    expect(document.querySelector('.settings__update-msg--success')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
  });

  test('an unknown applyMethod never renders an apply button', () => {
    renderWith(
      behindCheckout({
        applyMethod: 'carrier-pigeon' as CoreUpdateStatus['applyMethod'],
      }),
    );
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
  });

  test('an answering identity that does not match the view is no apply offer', () => {
    renderWith(
      behindCheckout({
        serverIdentity: {
          instanceId: 'different-instance',
          bootId: '22222222-2222-4222-8222-222222222222',
          sha: 'b'.repeat(40),
        },
      }),
    );
    expect(
      screen.getByText(
        'Server checkout is 2 commits behind its configured upstream.',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
  });

  test('a legacy server with no installKind at all renders comparison facts, not a refusal or an apply offer', () => {
    // Pre-#1624 wire shape: counts only. This pins TWO boundaries at once:
    // the refusal branch must key on provenanceIssue/'unknown' and never on
    // an absent installKind (widening it to `installKind == null` reds this
    // test), and the missing response identity still earns no apply offer.
    renderWith(
      {
        branch: 'main',
        currentHash: 'aaaaaaa',
        remoteHash: 'bbbbbbb',
        behind: 2,
        ahead: 0,
        updateAvailable: true,
      },
      makeContext(),
    );
    expect(
      screen.getByText(
        'Server checkout is 2 commits behind its configured upstream.',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        'This server install has no usable update provenance. Station cannot determine whether a server update is available. Use the installation method that manages this server.',
      ),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
  });

  test('an identity refetch onto a NEW boot invalidates the apply offer on the cached comparison', () => {
    // Same selection, cached comparison in hand: the server restarts and the
    // view's correlated identity refetches onto a NEW boot while the cached
    // status still claims the OLD one. The gate compares the view identity
    // the check answered with — a boot mismatch closes the apply offer even
    // though the comparison counts still read as current.
    const before = makeContext();
    const rendered = renderWith(behindCheckout(), before);
    expect(
      screen.getByRole('button', { name: 'Update server checkout' }),
    ).toBeTruthy();

    const restarted = makeContext({
      identity: {
        ...VIEW_IDENTITY,
        bootId: '22222222-2222-4222-8222-222222222222',
      },
    });
    rendered.rerender(
      <CoreUpdateCheck apiBase="http://localhost:3141" context={restarted} />,
    );
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
    // The comparison facts remain visible — only the offer is invalidated.
    expect(
      screen.getByText(
        'Server checkout is 2 commits behind its configured upstream.',
      ),
    ).toBeTruthy();
  });

  test('an older server with no response identity keeps its comparison facts but earns no apply offer', () => {
    renderWith(behindCheckout({ serverIdentity: null }));
    expect(
      screen.getByText(
        'Server checkout is 2 commits behind its configured upstream.',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
  });

  test('a stale scope renders the cached result as explicitly historical and unactionable', () => {
    renderWith(behindCheckout(), makeContext({ isCurrent: () => false }));
    expect(
      screen.getByText(/Last checked .*\. This result may be outdated\./),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
    // The historical result does not speak with the current checkout's voice.
    expect(
      screen.queryByText(
        'Server checkout is 2 commits behind its configured upstream.',
      ),
    ).toBeNull();
  });

  test('a disconnected server renders the cached result as historical too', () => {
    renderWith(behindCheckout(), makeContext({ reachability: 'unavailable' }));
    expect(screen.getByText(/This result may be outdated\./)).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
  });
});

/**
 * 6-OPS-44. A `git ls-remote` against a cold remote took ~30 s in the audit,
 * and for that whole window the card replaced its facts with one disabled
 * "Checking…" — so the user LOST the answer they already had in order to be
 * told an answer was coming.
 */
describe('re-check keeps the last known state (6-OPS-44)', () => {
  const KNOWN: CoreUpdateStatus = behindCheckout({
    channel: 'nightly',
    behind: 0,
    remoteHash: 'aaaaaaa',
    updateAvailable: false,
  });

  test('a first check with nothing known shows the wait alone', () => {
    queryState.isFetching = true;
    queryState.data = undefined;
    render(<CoreUpdateCheck apiBase="http://localhost:3141" />);
    expect(
      screen.getByLabelText('Checking the connected server’s update source'),
    ).toBeTruthy();
    expect(screen.queryByText(/Update channel/)).toBeNull();
    expect(screen.queryByText(/Showing the result from/)).toBeNull();
    queryState.isFetching = false;
  });

  test('a RE-check annotates the known state instead of replacing it', () => {
    queryState.isFetching = false;
    const context = makeContext();
    const { rerender } = renderWith(KNOWN, context);
    expect(
      screen.getByText(/Update channel: nightly \(set at install\)/),
    ).toBeTruthy();

    // The transition under test: the same card, now refetching.
    queryState.isFetching = true;
    rerender(
      <CoreUpdateCheck apiBase="http://localhost:3141" context={context} />,
    );

    expect(
      screen.getByText(/Update channel: nightly \(set at install\)/),
    ).toBeTruthy();
    expect(screen.getByText(/Checkout: aaaaaaa/)).toBeTruthy();
    expect(screen.getByText(/Showing the result from/).textContent).toMatch(
      /Showing the result from/,
    );
    // The skeleton is for a wait with nothing to preserve; this is not one.
    expect(screen.queryByLabelText('Checking for updates')).toBeNull();
    queryState.isFetching = false;
  });
});

describe('scope binding (update-ux PR4)', () => {
  function renderWithScope(context: ConnectedServerUpdateContext) {
    queryState.data = behindCheckout();
    return render(
      <CoreUpdateCheck apiBase="http://localhost:3141" context={context} />,
    );
  }

  test('the correlation scope joins the query options', () => {
    renderWithScope(makeContext({ scopeKey: 'scope-a' }));
    expect(scopeOptionsCalls.at(-1)?.scopeKey).toBe(
      'scope-a\u000011111111-1111-4111-8111-111111111111',
    );
  });

  test('A→B on the same URL resets restart state, and B never shows A’s accepted update', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STARTED_AT);
    const contextA = makeContext({ scopeKey: 'scope-a' });
    const rendered = renderWithScope(contextA);
    act(() => {
      applyOptions?.onSuccess?.({
        success: true,
        restarting: true,
        restart: expectedRestart(),
      });
    });
    expect(
      screen.getByText('Server restart started. Verifying the expected build…'),
    ).toBeTruthy();

    // Same URL, a different selected profile: the scope changes even though
    // apiBase does not.
    const contextB = makeContext({ scopeKey: 'scope-b' });
    rendered.rerender(
      <CoreUpdateCheck apiBase="http://localhost:3141" context={contextB} />,
    );
    expect(screen.queryByText(/Server restart started/)).toBeNull();
    expect(screen.queryByText(/Server update verified/)).toBeNull();

    // A's watchdog verdict lands after the switch: it must not speak for B.
    requestCoreUpdateRestartStatus.mockResolvedValue(
      restartStatus('verified', expectedRestart()),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(queryState.refetch).not.toHaveBeenCalled();
    expect(screen.queryByText(/Server update verified/)).toBeNull();
  });

  test('A→B→A leaves no transient state from either earlier scope', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STARTED_AT);
    const contextA = makeContext({ scopeKey: 'scope-a' });
    const rendered = renderWithScope(contextA);
    // A accepts a background rebuild (updating): the rebuilding state shows
    // persistently under A.
    act(() => {
      applyOptions?.onSuccess?.({ success: true, updating: true });
    });
    expect(
      screen.getByText(
        'Updating — Station is rebuilding from source and will restart when complete.',
      ),
    ).toBeTruthy();

    const contextB = makeContext({ scopeKey: 'scope-b' });
    rendered.rerender(
      <CoreUpdateCheck apiBase="http://localhost:3141" context={contextB} />,
    );
    expect(
      screen.queryByText(/Updating — Station is rebuilding from source/),
    ).toBeNull();

    // Back to A: a fresh A scope starts with no rebuilding state either.
    rendered.rerender(
      <CoreUpdateCheck apiBase="http://localhost:3141" context={contextA} />,
    );
    expect(
      screen.queryByText(/Updating — Station is rebuilding from source/),
    ).toBeNull();
    expect(screen.queryByText(/Server restart started/)).toBeNull();
  });

  test('an accepted POST whose scope is superseded before its completion shows nothing in the new scope', async () => {
    const contextA = makeContext({ scopeKey: 'scope-a' });
    const rendered = renderWithScope(contextA);
    act(() => {
      applyOptions?.onSuccess?.({ success: true, updating: true });
    });
    expect(
      screen.getByText(
        'Updating — Station is rebuilding from source and will restart when complete.',
      ),
    ).toBeTruthy();
    const contextB = makeContext({ scopeKey: 'scope-b' });
    rendered.rerender(
      <CoreUpdateCheck apiBase="http://localhost:3141" context={contextB} />,
    );
    // The completion now belongs to B's render: without the originating-scope
    // binding it would re-present A's rebuild as B's state.
    const refetchesBeforeSupersededCompletion = vi.mocked(queryState.refetch)
      .mock.calls.length;
    act(() => {
      applyOptions?.onSuccess?.({ success: true, updating: true });
    });
    expect(
      screen.queryByText(/Updating — Station is rebuilding from source/),
    ).toBeNull();
    expect(queryState.refetch).toHaveBeenCalledTimes(
      refetchesBeforeSupersededCompletion,
    );
  });
});

describe('git-based checkout apply flow (#1624, update-ux PR4)', () => {
  function renderRestartingUpdate() {
    return renderWith(behindCheckout({ behind: 1 }));
  }

  function beginRestart(restart = expectedRestart()) {
    act(() => {
      applyOptions?.onSuccess?.({ success: true, restarting: true, restart });
    });
  }

  test('a successful POST acceptance never renders verified success without the watchdog verdict', () => {
    vi.useFakeTimers();
    vi.setSystemTime(STARTED_AT);
    renderRestartingUpdate();
    beginRestart();
    expect(
      screen.getByText('Server restart started. Verifying the expected build…'),
    ).toBeTruthy();
    expect(screen.queryByText(/Server update verified/)).toBeNull();
    expect(document.querySelector('.settings__update-msg--success')).toBeNull();
  });

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
    expect(
      screen.getByText(/Could not verify the expected server after restart/),
    );
    expect(queryState.refetch).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Check for server updates' }),
    );
    expect(
      screen.queryByText(/Could not verify the expected server after restart/),
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

    expect(
      screen.getByText(/Could not verify the expected server after restart/),
    );
    expect(queryState.refetch).not.toHaveBeenCalled();
  });

  test('refreshes only after the matching watchdog writes verified, then shows the verified build', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STARTED_AT);
    const expected = expectedRestart();
    requestCoreUpdateRestartStatus
      .mockResolvedValueOnce(restartStatus('pending', expected))
      .mockResolvedValueOnce(restartStatus('verified', expected));
    renderRestartingUpdate();
    beginRestart(expected);
    await act(async () => {});
    expect(
      screen.getByText('Server restart started. Verifying the expected build…'),
    ).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(queryState.refetch).toHaveBeenCalled();
    expect(screen.queryByText(/Verifying the expected build/)).toBeNull();
    expect(screen.getByText(/Server update verified: bbbbbbb\./)).toBeTruthy();
  });

  test('surfaces a durable watchdog failure rather than retrying it as health', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STARTED_AT);
    requestCoreUpdateRestartStatus.mockResolvedValue(restartStatus('failed'));
    renderRestartingUpdate();
    beginRestart();
    await act(async () => {});

    expect(
      screen.getByText(/Could not verify the expected server after restart/),
    );
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

    rendered.rerender(
      <CoreUpdateCheck
        apiBase="http://localhost:4141"
        context={makeContext()}
      />,
    );
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByText(/Verifying the expected build/)).toBeNull();
    expect(
      screen.queryByText(/Could not verify the expected server after restart/),
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

    expect(
      screen.getByText(/Could not verify the expected server after restart/),
    );
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

    fireEvent.click(
      screen.getByRole('button', { name: 'Check for server updates' }),
    );
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByText(/Verifying the expected build/)).toBeNull();
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

/**
 * Epic #2144 slice 6 item C. The channel used to appear as a bare
 * `Channel: nightly` inside the compact fact run, with NOTHING at all when
 * the install had no stamp — indistinguishable from not having checked. It
 * now states its provenance and answers the absent case out loud, and it is
 * read-only: switching channels means reinstalling.
 */
describe('the update channel row', () => {
  test('names the stamped channel and where it came from', () => {
    renderWith(behindCheckout({ channel: 'nightly' }));
    expect(
      screen.getByText('Update channel: nightly (set at install)'),
    ).toBeTruthy();
  });

  test('says so when this install records no channel', () => {
    // A source checkout, and any hand-copied bundle, has no installer stamp
    // — `readNightlySourceStamp` returns null rather than guessing one.
    const status = behindCheckout();
    expect(status.channel).toBeUndefined();
    renderWith(status);
    expect(
      screen.getByText('Update channel: Not recorded for this install'),
    ).toBeTruthy();
  });

  test('offers no way to change it', () => {
    renderWith(behindCheckout({ channel: 'stable' }));
    const row = screen
      .getByText('Update channel: stable (set at install)')
      .closest('div')!;
    expect(row.querySelector('select')).toBeNull();
    expect(row.querySelector('button')).toBeNull();
    expect(row.querySelector('input')).toBeNull();
  });

  test('claims nothing before a check has answered', () => {
    queryState.isFetching = true;
    queryState.data = undefined;
    render(<CoreUpdateCheck apiBase="http://localhost:3141" />);
    expect(screen.queryByText(/Update channel/)).toBeNull();
    queryState.isFetching = false;
  });

  test('the channel is not also printed by the compact fact run', () => {
    renderWith(behindCheckout({ channel: 'nightly' }));
    expect(screen.queryByText(/·\s*Channel: nightly/)).toBeNull();
    expect(screen.getAllByText(/nightly/)).toHaveLength(1);
  });
});

describe('a prebuilt release archive (#2675 D3)', () => {
  const REQUEST_ID = '0f8b7a1e-2f4c-4d7a-9b1e-3c5d7f9a1b2c';

  /** The shape the server writes for a launcher-run archive. */
  function archiveService(
    overrides: Partial<CoreUpdateStatus> = {},
  ): CoreUpdateStatus {
    return {
      installKind: 'archive-service',
      applyMethod: 'service-update',
      channel: 'preview',
      currentVersion: '0.8.0-preview.1',
      latestVersion: '0.8.0-preview.2',
      releaseCheck: 'verified',
      updateAvailable: true,
      serverIdentity: ANSWER_IDENTITY,
      provenanceIssue: null,
      technicalDetail: null,
      selfUpdateUnavailableReason: null,
      selfUpdateUnavailableCode: null,
      serviceUpdate: { state: 'idle' },
      ...overrides,
    };
  }

  test('a verified newer release offers the service update, with versions and no source-update copy', () => {
    renderWith(archiveService());
    expect(
      screen.getByRole('button', { name: 'Update server to 0.8.0-preview.2' }),
    ).toBeTruthy();
    const line = screen.getByText(
      'Station 0.8.0-preview.2 is available. This server runs 0.8.0-preview.1.',
    );
    expect(line.className).toContain('settings__update-msg--warning');
    expect(screen.getByText(/Version: 0\.8\.0-preview\.1/)).toBeTruthy();
    expect(screen.getByText(/Latest release: 0\.8\.0-preview\.2/)).toBeTruthy();
    expect(
      screen.getByText(/Update channel: preview \(set at install\)/),
    ).toBeTruthy();
    expect(screen.queryByText(/[Ss]ource update/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Update server checkout' }),
    ).toBeNull();
  });

  test('the newest release reads as up to date, in the success voice, with no apply', () => {
    renderWith(
      archiveService({
        latestVersion: '0.8.0-preview.1',
        updateAvailable: false,
      }),
    );
    const line = screen.getByText(
      'This server runs the newest preview release (0.8.0-preview.1).',
    );
    expect(line.className).toContain('settings__update-msg--success');
    expect(line.querySelector('svg')).not.toBeNull();
    expect(
      screen.queryByRole('button', { name: /Update server to/ }),
    ).toBeNull();
  });

  test('an archive no launcher runs says how to update instead of offering it', () => {
    renderWith(
      archiveService({
        installKind: 'archive',
        applyMethod: 'station-upgrade',
        serviceUpdate: undefined,
        selfUpdateUnavailableReason:
          'this server is not run by the Station service’s launcher, so it cannot update itself; update it on the host with "station upgrade"',
      }),
    );
    expect(screen.queryByRole('button', { name: /Update server/ })).toBeNull();
    expect(
      screen.getByText(
        /Server update cannot be applied from here: this server is not run by/,
      ).textContent,
    ).toContain('"station upgrade"');
  });

  test('a manifest that did not verify is an error, never an update or up-to-date claim', () => {
    renderWith(
      archiveService({
        latestVersion: undefined,
        releaseCheck: 'unverified',
        updateAvailable: false,
        message:
          'The preview release manifest did not verify against Station’s pinned signing keys.',
        technicalDetail: 'manifest signature did not verify',
      }),
    );
    const line = screen.getByText(
      /did not verify against Station’s signing keys/,
    );
    expect(line.className).toContain('settings__update-msg--error');
    expect(screen.queryByRole('button', { name: /Update server/ })).toBeNull();
    expect(screen.queryByText(/newest preview release/)).toBeNull();
  });

  test('an update already under way closes the offer and is polled', () => {
    renderWith(
      archiveService({
        serviceUpdate: {
          state: 'updating',
          requestId: REQUEST_ID,
          phase: 'trial',
          fromVersion: '0.8.0-preview.1',
          targetVersion: '0.8.0-preview.2',
          attempts: 1,
        },
      }),
    );
    expect(
      screen.queryByRole('button', { name: /Update server to/ }),
    ).toBeNull();
    expect(
      screen.getByText(
        'Trying Station 0.8.0-preview.2 (attempt 1). The server restarts during the trial.',
      ),
    ).toBeTruthy();
    expect(serviceProgressOptions?.enabled).toBe(true);
  });

  test('an accepted apply follows its request until the correlated outcome, then re-checks', () => {
    const view = renderWith(archiveService());
    expect(serviceProgressOptions?.enabled).toBe(false);
    fireEvent.click(
      screen.getByRole('button', { name: 'Update server to 0.8.0-preview.2' }),
    );
    act(() => {
      applyOptions?.onSuccess?.({
        success: true,
        serviceUpdate: { requestId: REQUEST_ID },
      });
    });
    expect(serviceProgressOptions?.enabled).toBe(true);
    // No progress yet, a stage in flight, and an earlier update's finished
    // record all keep the poll going.
    expect(serviceProgressOptions?.refetchInterval(undefined)).toBe(2_000);
    expect(
      serviceProgressOptions?.refetchInterval({
        state: 'staging',
        requestId: REQUEST_ID,
      }),
    ).toBe(2_000);
    const earlier: ServiceUpdateProgress = {
      state: 'committed',
      requestId: '11111111-2222-4333-8444-555555555555',
      fromVersion: '0.8.0-preview.0',
      targetVersion: '0.8.0-preview.1',
      finishedAt: '2026-09-01T00:00:00.000Z',
    };
    expect(serviceProgressOptions?.refetchInterval(earlier)).toBe(2_000);

    serviceProgressState.data = { state: 'staging', requestId: REQUEST_ID };
    view.rerender(
      <CoreUpdateCheck
        apiBase="http://localhost:3141"
        context={makeContext()}
      />,
    );
    expect(
      screen.getByText('Downloading and verifying the release…'),
    ).toBeTruthy();
    // The offer stays closed while this request is followed.
    expect(
      screen.queryByRole('button', { name: /Update server to/ }),
    ).toBeNull();
    expect(queryState.refetch).not.toHaveBeenCalled();

    const outcome: ServiceUpdateProgress = {
      state: 'rolled-back',
      requestId: REQUEST_ID,
      fromVersion: '0.8.0-preview.1',
      targetVersion: '0.8.0-preview.2',
      reason: 'prepared-timeout',
      finishedAt: '2026-09-27T12:00:00.000Z',
    };
    expect(serviceProgressOptions?.refetchInterval(outcome)).toBe(false);
    serviceProgressState.data = outcome;
    view.rerender(
      <CoreUpdateCheck
        apiBase="http://localhost:3141"
        context={makeContext()}
      />,
    );
    const rolledBack = screen.getByText(
      /The update to 0\.8\.0-preview\.2 was rolled back: the new version did not become ready in time\. The server runs 0\.8\.0-preview\.1/,
    );
    expect(rolledBack.className).toContain('settings__update-msg--warning');
    expect(queryState.refetch).toHaveBeenCalledTimes(1);
    // The accepted POST no longer styles anything, and the pre-update
    // comparison earns no offer until the re-check it triggered answers.
    expect(applyReset).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: /Update server to/ }),
    ).toBeNull();
    queryState.dataUpdatedAt = Date.now() + 1;
    view.rerender(
      <CoreUpdateCheck
        apiBase="http://localhost:3141"
        context={makeContext()}
      />,
    );
    const again = screen.getByRole('button', {
      name: 'Update server to 0.8.0-preview.2',
    }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
  });

  test('an update that could not be rolled back names the operator’s recovery and offers no apply', () => {
    renderWith(
      archiveService({
        serviceUpdate: {
          state: 'needs-operator',
          requestId: REQUEST_ID,
          fromVersion: '0.8.0-preview.1',
          targetVersion: '0.8.0-preview.2',
          reason: 'prepared-timeout',
          restoreAttempts: 3,
          finishedAt: '2026-09-27T12:00:00.000Z',
        },
      }),
    );
    const line = screen.getByText(/could not be rolled back/);
    expect(line.className).toContain('settings__update-msg--error');
    expect(line.textContent).toContain('after 3 attempts');
    expect(line.textContent).toContain(
      'station service stop --instance=view-instance && station service start --instance=view-instance',
    );
    expect(screen.queryByText(/cannot be read/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Update server to/ }),
    ).toBeNull();
  });

  test('a server that stops answering mid-update says it is restarting, not that the update failed', () => {
    serviceProgressState.data = {
      state: 'updating',
      requestId: REQUEST_ID,
      phase: 'stopping',
      fromVersion: '0.8.0-preview.1',
      targetVersion: '0.8.0-preview.2',
      attempts: 0,
    };
    serviceProgressState.isError = true;
    renderWith(archiveService());
    expect(
      screen.getByText(
        'Stopping Station 0.8.0-preview.1 to switch to 0.8.0-preview.2…',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/The server is not answering while it restarts/),
    ).toBeTruthy();
  });
});
