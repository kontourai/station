import { resolveWorkspacePaneAvailability } from '@kontourai/station-contracts/workspace-pane-availability';
import { describe, expect, test } from 'vitest';
import {
  createE2EWorkspacePaneCatalog,
  E2E_STATION_COMPATIBILITY,
} from '../../tests/helpers/current-station-contract';

describe('current Station E2E contract fixtures', () => {
  test('advertises the exact supported protocol declaration', () => {
    expect(E2E_STATION_COMPATIBILITY).toEqual({
      serverVersion: '0.0.0-e2e',
      protocolVersion: 1,
      minClientProtocol: 1,
      capabilities: {
        remoteAuth: 1,
        devicePairing: 1,
        environmentProof: 1,
      },
    });
  });

  test('constructs every pane required by the Coding workspace from public contracts', () => {
    const catalog = createE2EWorkspacePaneCatalog('project-1', 'code');
    const instanceIds = catalog.instances.map((entry) => entry.instanceId);
    const descriptorIds = catalog.descriptors.map((entry) => entry.id);

    expect(catalog.projectId).toBe('project-1');
    expect(new Set(descriptorIds).size).toBe(descriptorIds.length);
    expect(descriptorIds).toContain(
      'pane:builtin:workspace-preview:file-preview',
    );
    expect(instanceIds).toEqual(
      expect.arrayContaining([
        'workspace-chat',
        'workspace-coding-file-browser',
        'workspace-coding-diff',
        'workspace-coding-terminal',
        'workspace-plan',
        'workspace-readiness',
        'workspace-trust',
      ]),
    );
    expect(
      catalog.availability.find(
        (entry) =>
          entry.descriptorId === 'pane:builtin:coding:diff' &&
          entry.instanceId === 'workspace-coding-diff',
      )?.input,
    ).toMatchObject({
      context: { workspace: 'present', gitRepository: 'present' },
      requirements: { gitRepository: true },
    });

    const codingDescriptor = catalog.descriptors.find(
      (entry) =>
        entry.renderer.kind === 'builtin-component' &&
        entry.renderer.name === 'coding',
    );
    expect(codingDescriptor).toMatchObject({
      renderer: { kind: 'builtin-component', name: 'coding' },
      provenance: { origin: 'builtin' },
    });
    expect(
      catalog.instances.find(
        (entry) => entry.descriptorId === codingDescriptor?.id,
      ),
    ).toMatchObject({
      descriptorId: codingDescriptor?.id,
      boundContext: {
        projectId: 'project-1',
        sourceId: 'builtin:coding',
      },
    });
    for (const requiredId of [
      'pane:builtin:workspace-preview:file-preview',
      'pane:builtin:coding:file-browser',
      'pane:builtin:coding:diff',
      'pane:builtin:coding:terminal',
      'pane:builtin:evidence:plan',
      'pane:builtin:evidence:readiness',
      'pane:builtin:evidence:trust',
    ]) {
      const descriptor = catalog.descriptors.find(
        (entry) => entry.id === requiredId,
      );
      const availability = catalog.availability.find(
        (entry) => entry.descriptorId === requiredId,
      );
      expect(
        descriptor && availability
          ? resolveWorkspacePaneAvailability(
              { ...availability.input, renderer: 'present' },
              descriptor.modes[0].contextRequirement,
            ).state
          : undefined,
        requiredId,
      ).toBe('available');
    }
  });
});
