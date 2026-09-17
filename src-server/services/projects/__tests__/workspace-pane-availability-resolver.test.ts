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

/**
 * #2067. The projection reaches a pane through its DESCRIPTOR PROVENANCE, and
 * nothing a declaration says about itself can move it.
 */
describe('per-principal plugin visibility', () => {
  const pluginDescriptor = {
    ...descriptor,
    id: 'pane:plugin-fixture',
    provenance: { origin: 'plugin', pluginId: 'notes' },
  } as unknown as WorkspacePaneDescriptor;
  const pluginInstance = {
    ...instance,
    descriptorId: pluginDescriptor.id,
    instanceId: 'instance:plugin-fixture',
  } as WorkspacePaneInstance;

  const resolveFor = (
    canSeePlugin: ((pluginId: string) => boolean) | undefined,
    availabilityInput?: Record<string, unknown>,
  ) =>
    resolveWorkspacePaneCatalogAvailability(
      [
        {
          descriptor: pluginDescriptor,
          instance: pluginInstance,
          contribution: { id: 'notes', enabled: true },
          ...(availabilityInput
            ? { availabilityInput: availabilityInput as never }
            : {}),
        },
      ],
      canSeePlugin ? { canSeePlugin } : {},
    )[0]!;

  test('a plugin the caller cannot see resolves to a reason, not to an absence', () => {
    const resolved = resolveFor(() => false);
    expect(resolved.input.pluginVisibility).toBe('hidden');
    expect(resolved.availability).toEqual({
      state: 'permission-required',
      reason: { code: 'pane-not-available-to-viewer', source: 'visibility' },
      action: { type: 'learn-more', code: 'view-permission-requirements' },
    });
  });

  test('the refusal conceals every lower fact about the plugin', () => {
    // Without the projection this candidate reports `renderer-unknown`: the
    // resolver's renderer branch. A person who cannot see the plugin must not
    // be able to tell those two apart, which is why the visibility branch is
    // ahead of rollout rather than beside the permission branch.
    expect(resolveFor(undefined).availability.reason.code).toBe(
      'renderer-unknown',
    );
    expect(resolveFor(() => false).availability.reason.code).toBe(
      'pane-not-available-to-viewer',
    );
  });

  test('a declaration cannot declare itself visible', () => {
    // `availabilityInput` is the last mergeable input and normally wins.
    // Visibility is applied after the merge precisely so a manifest-supplied
    // declaration cannot assert the one fact only the grant record produces.
    const resolved = resolveFor(() => false, { pluginVisibility: 'visible' });
    expect(resolved.input.pluginVisibility).toBe('hidden');
    expect(resolved.availability.reason.code).toBe(
      'pane-not-available-to-viewer',
    );
  });

  /**
   * A CONTRACT test with NO live producer behind it.
   * `readCurrentWorkspacePaneCatalog` drops a hidden plugin's panes before
   * availability runs, and the referenced-pane path that used to reach this
   * resolver with `pluginVisibility: 'hidden'` was REMOVED — see the
   * `'visibility'` reason-code docblock in
   * `packages/contracts/src/workspace-pane-availability.ts` for the two
   * implementations and why neither shipped. Nothing in production sets
   * `'hidden'` today; #2067's second acceptance criterion is unmet.
   *
   * These rows are kept because the ORDERING is the security property and it
   * took three rounds to get right; the Board slice will need it. Read them
   * as a contract, not as evidence that anything exercises it.
   *
   * The precedence IS the security property, so it needs cases where a lower
   * branch would otherwise WIN. Without these, the visibility block could be
   * moved below rollout/installation/distribution and every test still passes,
   * because the base fixture is `available`/`ready`/`enabled` and no lower
   * branch fires — which is exactly what an independent reviewer proved by
   * reordering the block and watching 27/27 stay green.
   */
  test.each([
    [
      'a rollout the caller would otherwise be told about',
      { rollout: 'coming-soon' },
    ],
    [
      'an installation state the caller would otherwise be told about',
      { installation: 'pending' },
    ],
    [
      'a distribution policy the caller would otherwise be told about',
      { distribution: 'disabled' },
    ],
    // `permission: 'required'` is deliberately NOT a row here. Its branch sits
    // below the renderer branch, so for this fixture (whose renderer is
    // unknown) it never fires, and the precondition assertion below correctly
    // refused it. A row that cannot reach the branch it names proves nothing
    // about precedence — it only makes the table look longer.
  ])('the refusal outranks %s', (_label, lowerFact) => {
    // First prove the lower fact really does win on its own. An injection
    // that lands on an unreachable branch proves nothing, and a fixture that
    // never triggers the branch is the same failure in fixture form.
    const withoutProjection = resolveFor(undefined, lowerFact);
    expect(withoutProjection.availability.reason.code).not.toBe(
      'pane-not-available-to-viewer',
    );
    expect(withoutProjection.availability.reason.code).not.toBe(
      'renderer-unknown',
    );
    // Now the same candidate, hidden: the lower fact must be unreachable.
    const hidden = resolveFor(() => false, lowerFact);
    expect(hidden.availability.reason.code).toBe(
      'pane-not-available-to-viewer',
    );
    expect(hidden.availability.reason.source).toBe('visibility');
  });

  test('a visible plugin carries the fact and resolves on its merits', () => {
    const resolved = resolveFor((pluginId) => pluginId === 'notes');
    expect(resolved.input.pluginVisibility).toBe('visible');
    expect(resolved.availability.reason.code).toBe('renderer-unknown');
  });

  test('a built-in pane never consults the projection', () => {
    const canSeePlugin = vi.fn(() => false);
    const resolved = resolveWorkspacePaneCatalogAvailability(
      [
        {
          descriptor,
          instance,
          contribution: { id: 'builtin', enabled: true },
        },
      ],
      { canSeePlugin },
    )[0]!;
    expect(canSeePlugin).not.toHaveBeenCalled();
    expect(resolved.input.pluginVisibility).toBeUndefined();
  });
});
