import {
  resolveWorkspacePaneAvailability,
  type WorkspacePaneAvailabilityInput,
} from '@kontourai/station-contracts/workspace-pane-availability';
import { describe, expect, test } from 'vitest';
import {
  adaptWorkspacePaneAvailabilityInput,
  type NativeCapabilityReader,
} from '../workspacePaneAvailabilityAdapters';

const browserInput: WorkspacePaneAvailabilityInput = {
  rollout: 'available',
  distribution: 'enabled',
  renderer: 'present',
  context: { project: 'present' },
  requirements: {
    hostCapabilities: ['local-browser-preview'],
    configuration: true,
  },
};

function native(
  state: 'enabled' | 'disabled' | 'unsupported' | 'permission-required',
): NativeCapabilityReader {
  return {
    capability: (id) => ({ id, state, reason: 'test-only' }),
  };
}

describe('server-derived deployment facts (#90 Browser pane)', () => {
  const serverInput = (
    fact: 'supported' | 'unsupported' | 'unknown',
  ): WorkspacePaneAvailabilityInput => ({
    rollout: 'available',
    distribution: 'enabled',
    renderer: 'present',
    context: { project: 'present' },
    requirements: { deploymentCapabilities: ['browser-pane'] },
    deployment: { state: 'supported', capabilities: { 'browser-pane': fact } },
  });

  test.each([
    ['a personal host', 'supported', 'available'],
    ['a hosted deployment', 'unsupported', 'unsupported'],
    ['an unknown deployment', 'unknown', 'unsupported'],
  ] as const)(
    "keeps the server's own fact for %s: the client cannot observe it",
    (_label, fact, state) => {
      // Whatever this client knows about ITS deployment features (here:
      // nothing), it must not overwrite a fact the server derived.
      for (const deployment of [undefined, {}]) {
        expect(
          resolveWorkspacePaneAvailability(
            adaptWorkspacePaneAvailabilityInput(serverInput(fact), {
              ...(deployment ? { deployment } : {}),
            }),
            { project: true },
          ).state,
        ).toBe(state);
      }
    },
  );
});

describe('Workspace Pane availability adapters', () => {
  test.each([
    ['web/PWA', native('unsupported'), 'unsupported', 'unsupported-host'],
    ['desktop', native('enabled'), 'available', 'ready'],
    ['mobile', native('disabled'), 'unsupported', 'unsupported-host'],
  ] as const)(
    'reports truthful local-browser-preview availability on %s',
    (_host, nativeAdapter, state, reasonCode) => {
      const availability = resolveWorkspacePaneAvailability(
        adaptWorkspacePaneAvailabilityInput(browserInput, {
          native: nativeAdapter,
          managedLoopback: 'present',
        }),
        { project: true },
      );

      expect(availability).toMatchObject({
        state,
        reason: { code: reasonCode },
      });
    },
  );

  test('fails closed when a native capability report is not available', () => {
    expect(
      resolveWorkspacePaneAvailability(
        adaptWorkspacePaneAvailabilityInput(browserInput, {}),
        { project: true },
      ),
    ).toMatchObject({
      state: 'unsupported',
      reason: { code: 'host-capability-unknown' },
    });
  });

  test('requires an authoritative managed-loopback connection instead of trusting a local-looking URL', () => {
    expect(
      resolveWorkspacePaneAvailability(
        adaptWorkspacePaneAvailabilityInput(browserInput, {
          native: native('enabled'),
          managedLoopback: 'missing',
        }),
        { project: true },
      ),
    ).toMatchObject({
      state: 'not-configured',
      reason: { code: 'configuration-missing' },
    });
  });

  test('maps native permission-required to the portable permission state', () => {
    expect(
      resolveWorkspacePaneAvailability(
        adaptWorkspacePaneAvailabilityInput(browserInput, {
          native: native('permission-required'),
          managedLoopback: 'present',
        }),
        { project: true },
      ),
    ).toMatchObject({
      state: 'permission-required',
      reason: { code: 'permission-required' },
    });
  });

  test('leaves File and Flow-style portable panes free of native claims', () => {
    const portable: WorkspacePaneAvailabilityInput = {
      rollout: 'available',
      distribution: 'enabled',
      renderer: 'present',
      context: { project: 'present' },
    };

    expect(adaptWorkspacePaneAvailabilityInput(portable, {})).toEqual(portable);
  });

  test('adapts only declared deployment requirements through the SDK contract', () => {
    const result = adaptWorkspacePaneAvailabilityInput(
      {
        ...browserInput,
        requirements: { deploymentCapabilities: ['scheduler'] },
      },
      {
        deployment: {
          deployment: { features: { scheduler: { state: 'unsupported' } } },
        },
      },
    );

    expect(result.deployment).toEqual({
      state: 'supported',
      capabilities: { scheduler: 'unsupported' },
    });
  });
});
