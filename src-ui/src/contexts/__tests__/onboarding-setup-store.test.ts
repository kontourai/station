/**
 * @vitest-environment jsdom
 */

import type { SystemStatus } from '@kontourai/station-sdk';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let currentStatus: SystemStatus | null = null;

vi.mock('../../hooks/useSystemStatus', () => ({
  useSystemStatus: () => ({
    data: currentStatus,
    isLoading: false,
    isError: false,
  }),
}));

import { deviceSettingsStore } from '../../lib/device-settings-store';
import {
  firstRunChapterPresence,
  onboardingSetupStore,
  shouldRenderSetupLauncher,
  useOnboardingSetupState,
} from '../onboarding-setup-store';

function createStatus(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    prerequisites: [],
    acp: {
      connected: false,
      connections: [],
    },
    providers: {
      configuredChatReady: false,
      configured: [],
      detected: {
        ollama: false,
        bedrock: false,
      },
    },
    clis: {},
    recommendation: {
      code: 'unconfigured',
      type: 'connections',
      actionLabel: 'Open Connections',
      title: 'No usable AI path is configured yet',
      detail:
        'Start Ollama locally or add a provider/runtime connection to make Station ready for first-run chat.',
    },
    ready: false,
    ...overrides,
  };
}

describe('useOnboardingSetupState', () => {
  beforeEach(() => {
    currentStatus = null;
    act(() => onboardingSetupStore.reset());
  });

  afterEach(() => {
    act(() => onboardingSetupStore.reset());
  });

  test('is hidden while status has not resolved yet', () => {
    const { result } = renderHook(() => useOnboardingSetupState());

    expect(result.current.visible).toBe(false);
    expect(result.current.isBlockingFullScreen).toBe(false);
    expect(result.current.content).toBeNull();
  });

  test('is visible and blocking full-screen when a setup recommendation is present', () => {
    currentStatus = createStatus();
    const { result, rerender } = renderHook(() => useOnboardingSetupState());
    rerender();

    expect(result.current.visible).toBe(true);
    expect(result.current.isBlockingFullScreen).toBe(true);
    expect(result.current.content?.title).toBe('Choose what powers Station');
  });

  test('dismiss() hides the banner without changing the underlying readiness', () => {
    currentStatus = createStatus();
    const { result, rerender } = renderHook(() => useOnboardingSetupState());
    rerender();
    expect(result.current.visible).toBe(true);

    act(() => {
      result.current.dismiss();
      rerender();
    });

    expect(result.current.visible).toBe(false);
    expect(result.current.isBlockingFullScreen).toBe(false);
    // Dismissal now persists through the device-settings store (archive#
    // settings-revamp) rather than its own raw localStorage key.
    expect(deviceSettingsStore.get('onboardingSetupDismissed')).toBe(true);
  });

  test('keeps a dismissed first-run launcher dismissed when recommendations change', () => {
    currentStatus = createStatus();
    const { result, rerender } = renderHook(() => useOnboardingSetupState());
    rerender();

    act(() => {
      result.current.dismiss();
    });
    rerender();
    expect(result.current.visible).toBe(false);

    currentStatus = createStatus({
      providers: {
        configuredChatReady: false,
        configured: [],
        detected: { ollama: true, bedrock: false },
      },
      recommendation: {
        code: 'detected-provider',
        type: 'providers',
        actionLabel: 'Add Ollama connection',
        title: 'Ollama is available',
        detail:
          'Create a model connection for the detected local Ollama server to make first-run chat explicit.',
        detectedProviderType: 'ollama',
        detectedProviderLabel: 'Ollama',
      },
    });
    rerender();

    expect(result.current.visible).toBe(false);
    expect(result.current.content?.title).toBe('Ollama is available');
  });

  test('stays dismissed when chat readiness changes and later regresses', () => {
    currentStatus = createStatus();
    const { result, rerender } = renderHook(() => useOnboardingSetupState());
    rerender();

    act(() => {
      result.current.dismiss();
    });
    rerender();
    expect(result.current.visible).toBe(false);

    currentStatus = createStatus({
      providers: {
        configuredChatReady: true,
        configured: [],
        detected: { ollama: false, bedrock: false },
      },
      recommendation: {
        code: 'configured-chat-ready',
        type: 'providers',
        actionLabel: 'Review model connections',
        title: 'A chat-capable model connection is already configured',
        detail: 'Station can already route chat.',
      },
      ready: true,
    });
    rerender();
    expect(result.current.visible).toBe(false);

    currentStatus = createStatus();
    rerender();
    expect(result.current.visible).toBe(false);
  });

  // archive#settings-revamp: `dismissedState` used
  // to be copied out of the device store once at construction and never
  // read again, so an import (or a cross-tab change) that flipped
  // `onboardingSetupDismissed` never reached this store's subscribers.
  test('importEnvelope flipping onboardingSetupDismissed is reflected in the snapshot and notifies listeners', () => {
    currentStatus = createStatus();
    const { result, rerender } = renderHook(() => useOnboardingSetupState());
    rerender();
    expect(result.current.visible).toBe(true);

    act(() => {
      deviceSettingsStore.importEnvelope({
        version: 1,
        values: { onboardingSetupDismissed: true },
      });
    });
    rerender();

    expect(result.current.visible).toBe(false);
    expect(result.current.isBlockingFullScreen).toBe(false);
  });

  test("onboardingSetupStore's own subscribers fire on a device-store-only change, not just its own dismiss()", () => {
    const listener = vi.fn();
    const unsubscribe = onboardingSetupStore.subscribe(listener);

    act(() => {
      deviceSettingsStore.importEnvelope({
        version: 1,
        values: { onboardingSetupDismissed: true },
      });
    });

    expect(listener).toHaveBeenCalled();
    expect(onboardingSetupStore.getSnapshot()).toBe(true);
    unsubscribe();
  });
});

/**
 * The launcher's visibility is ONE decision with two consumers — the launcher
 * itself (`OnboardingGate`) and every route overlay that would otherwise
 * render nothing underneath it (`AppViewContent`'s `ProjectNewViewGate`).
 * `/projects/new` rendered a blank page on a first-run home precisely because
 * those two disagreed, so this pins the predicate's own truth table rather
 * than only its use through a component.
 */
describe('shouldRenderSetupLauncher', () => {
  const content = { title: 'Set up chat' } as never;

  function decide(
    overrides: Partial<Parameters<typeof shouldRenderSetupLauncher>[0]> = {},
  ) {
    return shouldRenderSetupLauncher({
      credentialRequired: false,
      setupVisible: true,
      setupContent: content,
      pathname: '/',
      ...overrides,
    });
  }

  test('renders only when setup is visible, has content, is not credential-blocked, and is off /connections', () => {
    expect(decide()).toBe(true);
  });

  test('credentialRequired suppresses it — the credential banner owns the screen', () => {
    expect(decide({ credentialRequired: true })).toBe(false);
  });

  test('an invisible setup banner suppresses it', () => {
    expect(decide({ setupVisible: false })).toBe(false);
  });

  test('no content suppresses it — there would be nothing to render', () => {
    expect(decide({ setupContent: null })).toBe(false);
  });

  test('/connections suppresses it, including nested routes', () => {
    expect(decide({ pathname: '/connections' })).toBe(false);
    expect(decide({ pathname: '/connections/providers' })).toBe(false);
  });

  // Audit CI-R12: the setup banner rendered on the very page its action
  // targets, offering "Open Connections" to a reader already there. Every
  // section of the redesigned hub — and every legacy path that redirects into
  // one — must suppress it, not just the one route this suite used to name.
  test.each([
    '/connections/models',
    '/connections/engines',
    '/connections/tools',
    '/connections/knowledge',
    '/connections/computers',
    '/connections/providers',
    '/connections/acp',
    '/connections/models/new',
    '/connections/engines/new/cursor',
  ])('%s suppresses the setup banner', (pathname) => {
    expect(decide({ pathname })).toBe(false);
  });

  test('a path merely CONTAINING "connections" does not suppress it', () => {
    expect(decide({ pathname: '/projects/connections-demo' })).toBe(true);
  });

  test('every remaining combination of the four inputs', () => {
    // 2x2x2x2 exhaustive: the predicate is a conjunction, so exactly one of
    // the sixteen rows may be true. A future clause that flips any other row
    // reddens here rather than being discovered on a blank route.
    const rows: boolean[] = [];
    for (const credentialRequired of [false, true])
      for (const setupVisible of [false, true])
        for (const setupContent of [null, content])
          for (const pathname of ['/', '/connections'])
            rows.push(
              shouldRenderSetupLauncher({
                credentialRequired,
                setupVisible,
                setupContent,
                pathname,
              }),
            );
    expect(rows.filter(Boolean)).toHaveLength(1);
  });
});

describe('at most one first-run overlay (review H2)', () => {
  beforeEach(() => {
    currentStatus = null;
    act(() => {
      onboardingSetupStore.reset();
      firstRunChapterPresence.set(false);
    });
  });

  test('an open first-run chapter stands the launcher down, and closing it restores', () => {
    // ONE piece of state, read by both overlays. The integrated proof — that
    // this actually keeps `OnboardingGate` from mounting `SetupLauncher` under
    // the chapter's scrim — is
    // `src-ui/src/__tests__/first-run-overlay-exclusivity.test.tsx`.
    currentStatus = createStatus();
    const { result, rerender } = renderHook(() => useOnboardingSetupState());
    expect(result.current.visible).toBe(true);
    expect(result.current.launcherWouldShow).toBe(true);

    act(() => firstRunChapterPresence.set(true));
    rerender();
    expect(result.current.visible).toBe(false);
    expect(result.current.isBlockingFullScreen).toBe(false);
    // The PROBE has not changed its mind, and this is the field that says so —
    // the chapter's own auto-open gate reads it, so the suppression cannot
    // become circular.
    expect(result.current.launcherWouldShow).toBe(true);

    act(() => firstRunChapterPresence.set(false));
    rerender();
    expect(result.current.visible).toBe(true);
  });
});
