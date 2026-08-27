import { describe, expect, test } from 'vitest';
import {
  resolveWorkspacePaneAvailability,
  toWorkspacePaneAvailabilityTelemetry,
  type WorkspacePaneAvailabilityInput,
} from '../workspace-pane-availability';

function readyInput(): WorkspacePaneAvailabilityInput {
  return {
    rollout: 'available',
    distribution: 'enabled',
    host: { state: 'supported' },
    deployment: { state: 'supported' },
    renderer: 'present',
    context: {
      project: 'present',
      task: 'present',
      workspace: 'present',
      gitRepository: 'present',
    },
    configuration: 'present',
    permission: 'granted',
    health: 'healthy',
  };
}

describe('Workspace Pane availability resolver', () => {
  test('returns available only when every authoritative input proves it', () => {
    expect(resolveWorkspacePaneAvailability(readyInput())).toEqual({
      state: 'available',
      reason: { code: 'ready', source: 'resolver' },
    });
  });

  test('does not require optional dimensions a Pane did not declare', () => {
    expect(
      resolveWorkspacePaneAvailability({
        rollout: 'available',
        distribution: 'enabled',
        renderer: 'present',
      }),
    ).toEqual({
      state: 'available',
      reason: { code: 'ready', source: 'resolver' },
    });
  });

  test.each([
    [
      'configuration',
      { configuration: true },
      'not-configured',
      'configuration-unknown',
    ],
    [
      'permission',
      { permission: true },
      'permission-required',
      'permission-unknown',
    ],
    ['health', { health: true }, 'temporarily-unavailable', 'health-unknown'],
  ] as const)(
    'fails closed when required %s evidence is unknown',
    (_name, requirements, state, code) => {
      expect(
        resolveWorkspacePaneAvailability({
          rollout: 'available',
          distribution: 'enabled',
          renderer: 'present',
          requirements,
        }),
      ).toMatchObject({ state, reason: { code } });
    },
  );

  test.each([
    ['coming soon', { rollout: 'coming-soon' }, 'coming-soon', 'coming-soon'],
    [
      'missing configuration',
      { configuration: 'missing' },
      'not-configured',
      'configuration-missing',
    ],
    [
      'unsupported host',
      { host: { state: 'unsupported' } },
      'unsupported',
      'unsupported-host',
    ],
    [
      'missing permission',
      { permission: 'required' },
      'permission-required',
      'permission-required',
    ],
    [
      'missing renderer',
      { renderer: 'missing' },
      'temporarily-unavailable',
      'renderer-missing',
    ],
    [
      'transient health failure',
      { health: 'unavailable' },
      'temporarily-unavailable',
      'health-unavailable',
    ],
  ])(
    '%s has a specific state, reason, and action',
    (_, change, state, code) => {
      const result = resolveWorkspacePaneAvailability({
        ...readyInput(),
        ...change,
      } as WorkspacePaneAvailabilityInput);
      expect(result.state).toBe(state);
      expect(result.reason.code).toBe(code);
      expect(result.action).toBeDefined();
    },
  );

  test.each([
    ['Project', { project: 'missing' }, 'missing-project'],
    ['Git repository', { gitRepository: 'missing' }, 'missing-git-repository'],
  ])('distinguishes a missing %s context', (_, context, code) => {
    const changedContext = {
      ...readyInput().context,
      ...context,
    } as WorkspacePaneAvailabilityInput['context'];
    const result = resolveWorkspacePaneAvailability(
      { ...readyInput(), context: changedContext },
      {
        project: code === 'missing-project' ? true : undefined,
      },
    );
    const withGitRequirement =
      code === 'missing-git-repository'
        ? resolveWorkspacePaneAvailability({
            ...readyInput(),
            context: changedContext,
            requirements: { gitRepository: true },
          })
        : result;
    expect(withGitRequirement).toMatchObject({
      state: 'not-configured',
      reason: { code, source: 'context' },
    });
  });

  test('uses the documented precedence instead of exposing lower-level details', () => {
    const result = resolveWorkspacePaneAvailability({
      ...readyInput(),
      rollout: 'coming-soon',
      host: { state: 'unsupported' },
      renderer: 'missing',
      health: 'unavailable',
    });
    expect(result).toMatchObject({
      state: 'coming-soon',
      reason: { code: 'coming-soon', source: 'product-rollout' },
    });
  });

  test('fails closed for omitted and unknown capabilities', () => {
    expect(
      resolveWorkspacePaneAvailability({
        ...readyInput(),
        rollout: 'unknown',
      }),
    ).toMatchObject({
      state: 'unsupported',
      reason: { code: 'rollout-unknown', source: 'product-rollout' },
      action: { type: 'learn-more', code: 'view-rollout' },
    });
    expect(
      resolveWorkspacePaneAvailability({
        ...readyInput(),
        distribution: 'unknown',
      }),
    ).toMatchObject({
      state: 'not-configured',
      reason: {
        code: 'distribution-policy-unknown',
        source: 'distribution-policy',
      },
      action: { type: 'learn-more', code: 'view-distribution-policy' },
    });
    expect(
      resolveWorkspacePaneAvailability(
        {
          ...readyInput(),
          context: { ...readyInput().context, project: 'unknown' },
        },
        { project: true },
      ),
    ).toMatchObject({
      state: 'not-configured',
      reason: { code: 'context-unknown', source: 'context' },
      action: { type: 'learn-more', code: 'view-context-requirements' },
    });
    expect(
      resolveWorkspacePaneAvailability({
        ...readyInput(),
        configuration: 'unknown',
      }),
    ).toMatchObject({
      state: 'not-configured',
      reason: { code: 'configuration-unknown', source: 'configuration' },
      action: {
        type: 'learn-more',
        code: 'view-configuration-requirements',
      },
    });
    expect(
      resolveWorkspacePaneAvailability({
        ...readyInput(),
        host: undefined,
        requirements: { hostCapabilities: ['native-preview'] },
      }),
    ).toMatchObject({
      state: 'unsupported',
      reason: { code: 'host-capability-unknown', source: 'native-host' },
    });
    expect(
      resolveWorkspacePaneAvailability({
        ...readyInput(),
        deployment: {
          state: 'supported',
          capabilities: {},
        },
        requirements: { deploymentCapabilities: ['server-preview'] },
      }),
    ).toMatchObject({
      state: 'unsupported',
      reason: {
        code: 'deployment-capability-unknown',
        source: 'deployment',
      },
    });
  });

  test('projects telemetry to descriptor, state, and reason code only', () => {
    expect(
      toWorkspacePaneAvailabilityTelemetry(
        'pane:fixture',
        resolveWorkspacePaneAvailability({
          ...readyInput(),
          health: 'unavailable',
        }),
      ),
    ).toEqual({
      descriptorId: 'pane:fixture',
      state: 'temporarily-unavailable',
      reasonCode: 'health-unavailable',
    });
  });
});
