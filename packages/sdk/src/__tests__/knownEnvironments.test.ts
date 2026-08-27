/**
 * Station#1096 AC3 — SSH environment profiles appear as KnownEnvironments
 * (read adapter).
 */
import { describe, expect, it } from 'vitest';
import {
  sshEnvironmentsToKnownEnvironments,
  sshEnvironmentToKnownEnvironment,
} from '../query-domains/knownEnvironments';
import type { SshEnvironmentView } from '../query-domains/sshEnvironments';

function makeView(
  overrides: Partial<SshEnvironmentView> = {},
): SshEnvironmentView {
  return {
    profile: {
      schemaVersion: 1,
      id: 'ssh-env-1',
      name: 'Build box',
      hostAlias: 'build-box',
      remoteProjectPath: '/home/dev/project',
      remotePort: 22,
      launchMode: 'attach',
      environmentId: null,
      hostIdentity: null,
      verifiedProjectPath: null,
      remoteHome: null,
      workerProtocolVersion: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastConnectedAt: null,
    },
    state: { phase: 'idle' },
    ...overrides,
  };
}

describe('sshEnvironmentToKnownEnvironment', () => {
  it('adapts an idle profile with no environmentId and zero live endpoints', () => {
    const environment = sshEnvironmentToKnownEnvironment(makeView());
    expect(environment.label).toBe('Build box');
    expect(environment.source).toBe('ssh');
    expect(environment.environmentId).toBeUndefined();
    expect(environment.endpoints).toHaveLength(0);
  });

  it('carries the profile-verified environmentId once one exists', () => {
    const environment = sshEnvironmentToKnownEnvironment(
      makeView({
        profile: {
          ...makeView().profile,
          environmentId: 'environment-build-box',
        },
      }),
    );
    expect(environment.environmentId).toBe('environment-build-box');
  });

  it('contributes exactly one ssh-forward endpoint while connected', () => {
    const environment = sshEnvironmentToKnownEnvironment(
      makeView({
        state: {
          phase: 'connected',
          localUrl: 'http://127.0.0.1:41123',
          instanceId: 'instance-1',
          sha: 'deadbeef',
          bootId: 'boot-1',
          connectedAt: '2026-01-01T00:05:00.000Z',
        },
      }),
    );
    expect(environment.endpoints).toHaveLength(1);
    expect(environment.endpoints[0].kind).toBe('ssh-forward');
    expect(environment.endpoints[0].httpBaseUrl).toBe('http://127.0.0.1:41123');
    expect(environment.endpoints[0].preferred).toBe(true);
  });

  it('contributes zero endpoints while disconnected, error, or starting', () => {
    for (const state of [
      { phase: 'disconnected', reason: 'stopped' },
      { phase: 'error', reason: 'timeout', action: 'Retry the connection.' },
      { phase: 'starting', attempt: 1 },
    ] as SshEnvironmentView['state'][]) {
      const environment = sshEnvironmentToKnownEnvironment(makeView({ state }));
      expect(environment.endpoints).toHaveLength(0);
    }
  });

  it('gives every adapted environment a stable, source-prefixed id', () => {
    const environment = sshEnvironmentToKnownEnvironment(makeView());
    expect(environment.id).toBe('ssh-environment:ssh-env-1');
  });
});

describe('sshEnvironmentsToKnownEnvironments', () => {
  it('adapts a full list, preserving order', () => {
    const views = [
      makeView({ profile: { ...makeView().profile, id: 'a', name: 'A' } }),
      makeView({ profile: { ...makeView().profile, id: 'b', name: 'B' } }),
    ];
    const environments = sshEnvironmentsToKnownEnvironments(views);
    expect(environments.map((e) => e.label)).toEqual(['A', 'B']);
  });
});
