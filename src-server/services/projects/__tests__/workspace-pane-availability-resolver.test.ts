import {
  createDirectAnswerBasisPaneInstance,
  createTaskAnswerBasisPaneInstance,
  createWholeTaskBasisPaneInstance,
  WORKSPACE_BASIS_PANE_DESCRIPTOR,
} from '@kontourai/station-basis-pane/workspace-basis-pane';
import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import { describe, expect, test, vi } from 'vitest';
import {
  resolveWorkspacePaneCatalogAvailability,
  workspacePaneAvailabilityMetricAttributes,
} from '../workspace-pane-availability-resolver';

const descriptor = {
  version: '1.0',
  id: 'pane:fixture',
  name: 'Fixture',
  rendererId: 'renderer:fixture',
  renderer: { kind: 'builtin-component', name: 'fixture' },
  placement: { supportedRegions: ['primary'] },
  modes: [{ id: 'default', contextRequirement: { project: true } }],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'stable' },
} as unknown as WorkspacePaneDescriptor;

const instance = {
  version: '1.0',
  descriptorId: descriptor.id,
  instanceId: 'instance:fixture',
  stateKey: 'state:fixture',
  boundContext: { projectId: 'project-a', sourceId: 'builtin:fixture' },
} as WorkspacePaneInstance;

describe('Workspace Pane catalog availability resolver', () => {
  test('keeps a known pane discoverable while failing closed without renderer proof', () => {
    expect(
      resolveWorkspacePaneCatalogAvailability([
        {
          descriptor,
          instance,
          contribution: { id: 'builtin:fixture', enabled: true },
        },
      ]),
    ).toEqual([
      {
        descriptorId: descriptor.id,
        instanceId: instance.instanceId,
        input: {
          rollout: 'available',
          distribution: 'enabled',
          renderer: 'unknown',
          context: { project: 'present' },
        },
        availability: {
          state: 'unsupported',
          reason: { code: 'renderer-unknown', source: 'renderer' },
          action: {
            type: 'learn-more',
            code: 'view-renderer-requirements',
          },
        },
      },
    ]);
  });

  test('adapts authoritative inputs and records only the safe telemetry projection', () => {
    const recordTelemetry = vi.fn();
    const entries = resolveWorkspacePaneCatalogAvailability(
      [
        {
          descriptor,
          instance,
          contribution: { id: 'builtin:fixture', enabled: true },
        },
      ],
      {
        resolveInput: () => ({
          rollout: 'available',
          distribution: 'enabled',
          host: { state: 'supported' },
          deployment: { state: 'supported' },
          renderer: 'present',
          context: { project: 'present' },
          configuration: 'present',
          permission: 'granted',
          health: 'healthy',
        }),
        recordTelemetry,
      },
    );
    expect(entries[0]?.availability.state).toBe('available');
    expect(entries[0]?.input).toEqual({
      rollout: 'available',
      distribution: 'enabled',
      host: { state: 'supported' },
      deployment: { state: 'supported' },
      renderer: 'present',
      context: { project: 'present' },
      configuration: 'present',
      permission: 'granted',
      health: 'healthy',
    });
    expect(recordTelemetry).toHaveBeenCalledWith({
      descriptorId: descriptor.id,
      state: 'available',
      reasonCode: 'ready',
    });
  });

  test('keeps an unplaced declaration discoverable without inventing an instance id', () => {
    expect(
      resolveWorkspacePaneCatalogAvailability([
        {
          descriptor,
          availabilityInput: { rollout: 'coming-soon' },
        },
      ]),
    ).toEqual([
      {
        descriptorId: descriptor.id,
        input: {
          rollout: 'coming-soon',
          distribution: 'disabled',
          renderer: 'unknown',
          context: { project: 'missing' },
        },
        availability: {
          state: 'coming-soon',
          reason: { code: 'coming-soon', source: 'product-rollout' },
          action: { type: 'learn-more', code: 'view-rollout' },
        },
      },
    ]);
  });

  test('merges declaration rollout with catalog facts instead of replacing them', () => {
    const [entry] = resolveWorkspacePaneCatalogAvailability(
      [{ descriptor, instance, availabilityInput: { rollout: 'coming-soon' } }],
      {
        resolveInput: () => ({
          distribution: 'enabled',
          context: { project: 'present' },
          renderer: 'present',
        }),
      },
    );

    expect(entry?.input).toEqual({
      rollout: 'coming-soon',
      distribution: 'enabled',
      renderer: 'present',
      context: { project: 'present' },
    });
    expect(entry?.availability.reason.code).toBe('coming-soon');
  });

  test('bounds contributed telemetry descriptor labels before metrics', () => {
    expect(
      workspacePaneAvailabilityMetricAttributes({
        descriptorId: 'pane:plugin:untrusted-path-or-id',
        state: 'unsupported',
        reasonCode: 'unsupported-host',
      }),
    ).toEqual({
      descriptor: 'contributed',
      state: 'unsupported',
      reason_code: 'unsupported-host',
    });
  });

  test('resolves the Basis mode satisfied by each exact occurrence', () => {
    const options = {
      resolveInput: () => ({
        rollout: 'available' as const,
        distribution: 'enabled' as const,
        renderer: 'present' as const,
      }),
    };
    const instances = [
      createDirectAnswerBasisPaneInstance('project-a', 'session-a', 'turn-a'),
      createTaskAnswerBasisPaneInstance('project-a', 'task-a', 'answer-a'),
      createWholeTaskBasisPaneInstance('project-a', 'task-a'),
    ];
    for (const basisInstance of instances) {
      expect(basisInstance).not.toBeNull();
      const [entry] = resolveWorkspacePaneCatalogAvailability(
        [
          {
            descriptor: WORKSPACE_BASIS_PANE_DESCRIPTOR,
            instance: basisInstance!,
            contribution: { id: 'builtin:basis', enabled: true },
          },
        ],
        options,
      );
      expect(entry?.availability.state).toBe('available');
    }

    const valid = createWholeTaskBasisPaneInstance('project-a', 'task-a')!;
    const [invalid] = resolveWorkspacePaneCatalogAvailability(
      [
        {
          descriptor: WORKSPACE_BASIS_PANE_DESCRIPTOR,
          instance: {
            ...valid,
            boundContext: {
              projectId: 'project-a',
              sourceId: 'builtin:workspace-basis:whole-task',
            },
          },
          contribution: { id: 'builtin:basis', enabled: true },
        },
      ],
      options,
    );
    expect(invalid?.availability).toMatchObject({
      state: 'not-configured',
      reason: { code: 'context-unknown', source: 'context' },
    });
  });
});
