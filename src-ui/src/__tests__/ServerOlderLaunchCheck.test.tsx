/** @vitest-environment jsdom */
import type { CoreUpdateStatus } from '@kontourai/station-sdk';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type UpdateNotice,
  useOpenUpdatesRequest,
  useUpdateNotices,
} from '../components/updates/updatesEvents';

const sdk = vi.hoisted(() => ({
  useCoreUpdateStatusQuery: vi.fn(),
  useApplyCoreUpdateMutation: vi.fn(),
  useServiceUpdateProgressQuery: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', () => sdk);
const IDENTITY = { instanceId: 'inst', bootId: 'boot', sha: 'abc' };
const connected = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
vi.mock('../hooks/useConnectedServerUpdateContext', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../hooks/useConnectedServerUpdateContext')
  >()),
  useConnectedServerUpdateContext: () => connected.current,
}));
const { ServerOlderLaunchCheck, servedByServer } = await import(
  '../components/ServerOlderLaunchCheck'
);
let status: CoreUpdateStatus | undefined;
let checkError: Error | null;
let notices: readonly UpdateNotice[];
let openRequest: ReturnType<typeof useOpenUpdatesRequest>;
function UpdatesObserver() {
  notices = useUpdateNotices();
  openRequest = useOpenUpdatesRequest();
  return null;
}
function serviceArchive(
  overrides: Partial<CoreUpdateStatus> = {},
): CoreUpdateStatus {
  return {
    installKind: 'archive-service',
    applyMethod: 'service-update',
    channel: 'nightly',
    currentVersion: '0.1.11-nightly.246303',
    latestVersion: '0.1.11-nightly.246500',
    releaseCheck: 'verified',
    updateAvailable: true,
    selfUpdateUnavailableReason: null,
    selfUpdateUnavailableCode: null,
    serverIdentity: IDENTITY,
    serviceUpdate: { state: 'idle' },
    ...overrides,
  } as CoreUpdateStatus;
}
const NEWER_CLIENT = '0.1.11-nightly.2465';
function tree(clientVersion: string | null = NEWER_CLIENT) {
  return (
    <>
      <ServerOlderLaunchCheck clientVersion={clientVersion} />
      <UpdatesObserver />
    </>
  );
}
beforeEach(() => {
  status = serviceArchive();
  checkError = null;
  notices = [];
  connected.current = {
    scopeKey: 'scope',
    apiBase: 'http://station.test:38141',
    connectionName: 'station',
    reachability: 'connected',
    kind: 'remote-server',
    identity: IDENTITY,
    identitySettled: true,
    identityReady: true,
    nativeObservationPending: false,
    claimedOwnerUnresolved: false,
    isCurrent: () => true,
  };
  sdk.useCoreUpdateStatusQuery.mockReset();
  sdk.useCoreUpdateStatusQuery.mockImplementation(
    (_apiBase: string, options: { enabled: boolean }) => ({
      data: options.enabled ? status : undefined,
      error: checkError,
    }),
  );
  sdk.useApplyCoreUpdateMutation.mockReset();
  sdk.useServiceUpdateProgressQuery.mockReset();
});

describe('ServerOlderLaunchCheck notices', () => {
  test('publishes the version difference and opens server review without applying or following an update', () => {
    const { container } = render(tree());
    expect(container.firstChild).toBeNull();
    expect(notices).toEqual([
      expect.objectContaining({
        target: 'server',
        message:
          'This Station server runs Nightly Sep 29, build 3, which is older than this app (Nightly Oct 1).',
        actionLabel: 'Review server update',
      }),
    ]);
    const sequence = openRequest.sequence;
    act(() => notices[0].onAction?.());
    expect(openRequest).toMatchObject({
      target: 'server',
      sequence: sequence + 1,
    });
    expect(sdk.useApplyCoreUpdateMutation).not.toHaveBeenCalled();
    expect(sdk.useServiceUpdateProgressQuery).not.toHaveBeenCalled();
  });

  test.each([
    ['unreachable', { reachability: 'unavailable' }],
    ['superseded', { isCurrent: () => false }],
  ])(
    'withdraws cached comparison facts once the selected server is %s',
    (_label, change) => {
      sdk.useCoreUpdateStatusQuery.mockImplementation(() => ({
        data: status,
        error: null,
      }));
      const view = render(tree());
      expect(notices).toHaveLength(1);
      connected.current = { ...connected.current, ...change };
      view.rerender(tree());
      expect(notices).toEqual([]);
    },
  );

  test('a failed refresh withdraws a comparison retained in the cache', () => {
    const view = render(tree());
    expect(notices).toHaveLength(1);
    checkError = new Error('offline');
    view.rerender(tree());
    expect(notices).toEqual([]);
  });

  test('scopes the check to the selected identity and withdraws the old server on selection change', () => {
    const view = render(tree());
    expect(notices).toHaveLength(1);
    const isCurrent = () => true;
    connected.current = {
      ...connected.current,
      scopeKey: 'other-scope',
      apiBase: 'http://other.test:38142',
      identity: { instanceId: 'other', bootId: 'other-boot', sha: 'def' },
      isCurrent,
    };
    status = undefined;
    view.rerender(tree());
    expect(notices).toEqual([]);
    expect(sdk.useCoreUpdateStatusQuery).toHaveBeenLastCalledWith(
      'http://other.test:38142',
      expect.objectContaining({ enabled: true }),
      { scopeKey: 'other-scope\u0000other-boot', assertCurrent: isCurrent },
    );
    status = serviceArchive({
      serverIdentity: { instanceId: 'other', bootId: 'other-boot', sha: 'def' },
    });
    view.rerender(tree());
    expect(notices).toHaveLength(1);
  });

  test.each([
    [
      'identity mismatch',
      { serverIdentity: { ...IDENTITY, instanceId: 'other' } },
      /could not confirm which server answered/,
    ],
    [
      'unverified release',
      { releaseCheck: 'unverified' as const },
      /station upgrade/,
    ],
    [
      'manual installation',
      {
        installKind: 'archive' as const,
        applyMethod: 'station-upgrade' as const,
      },
      /station upgrade/,
    ],
    [
      'operator restriction',
      { selfUpdateUnavailableReason: 'managed by an operator' },
      /managed by an operator/,
    ],
  ])(
    'retains the %s caveat in the notice while routing to review',
    (_label, facts, detail) => {
      status = serviceArchive(facts);
      render(tree());
      expect(notices[0]?.detail).toMatch(detail);
      expect(notices[0]?.actionLabel).toBe('Review server update');
      expect(sdk.useApplyCoreUpdateMutation).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['identity pending', { identityReady: false }],
    ['native observation pending', { nativeObservationPending: true }],
    ['claimed owner unresolved', { claimedOwnerUnresolved: true }],
    ['embedded sidecar', { kind: 'embedded-sidecar' }],
  ])('does not query while %s', (_label, change) => {
    connected.current = { ...connected.current, ...change };
    render(tree());
    expect(sdk.useCoreUpdateStatusQuery).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ enabled: false }),
      expect.anything(),
    );
    expect(notices).toEqual([]);
  });

  test('stays silent for a dev build without mounting a check', () => {
    render(tree(null));
    expect(notices).toEqual([]);
    expect(sdk.useCoreUpdateStatusQuery).not.toHaveBeenCalled();
  });

  test('stays silent when the app and server versions are equal', () => {
    render(tree('0.1.11-nightly.2463.3'));
    expect(notices).toEqual([]);
  });

  test("does not query or offer cached differences for the server's own web UI", () => {
    connected.current = {
      ...connected.current,
      apiBase: window.location.origin,
    };
    sdk.useCoreUpdateStatusQuery.mockImplementation(() => ({
      data: status,
      error: null,
    }));
    render(tree());
    expect(notices).toEqual([]);
    expect(sdk.useCoreUpdateStatusQuery).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ enabled: false }),
      expect.anything(),
    );
  });
});

describe('servedByServer', () => {
  test.each([
    ['', 'http://a.test', true],
    ['http://a.test', 'http://a.test', true],
    ['http://a.test:38141', 'http://a.test', false],
    ['http://127.0.0.1:38141', 'tauri://localhost', false],
    ['http://a.test', undefined, false],
  ])('%j from %j is %s', (apiBase, origin, expected) => {
    expect(servedByServer(apiBase, origin)).toBe(expected);
  });
});
