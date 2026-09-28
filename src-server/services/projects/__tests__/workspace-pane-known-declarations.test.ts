import * as basisPane from '@kontourai/station-basis-pane/workspace-basis-pane';
import * as contracts from '@kontourai/station-contracts';
import { createWorkspaceChatPaneInstance } from '@kontourai/station-contracts/workspace-chat-pane';
import {
  createWorkspaceCodingDiffPaneInstance,
  createWorkspaceCodingFileBrowserPaneInstance,
  createWorkspaceCodingTerminalPaneInstance,
} from '@kontourai/station-contracts/workspace-coding-panels';
import {
  createWorkspacePlanPaneInstance,
  createWorkspaceReadinessPaneInstance,
  createWorkspaceTrustPaneInstance,
} from '@kontourai/station-contracts/workspace-evidence-panels';
import { WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-file-preview';
import type { WorkspacePaneDescriptor } from '@kontourai/station-contracts/workspace-pane';
import { createWorkspaceSpatialBoardPaneInstance } from '@kontourai/station-contracts/workspace-spatial-board';
import { describe, expect, test } from 'vitest';
import {
  KNOWN_WORKSPACE_PANE_DECLARATIONS,
  mergeKnownWorkspacePaneDescriptors,
} from '../workspace-pane-known-declarations';

describe('known Workspace Pane declarations', () => {
  test('declares dynamic previews without instances and issues exact current coding panel occurrences', () => {
    const catalog = mergeKnownWorkspacePaneDescriptors([]);

    expect(catalog.instanceCount).toBe(0);
    expect(
      catalog.getDescriptor(WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR.id),
    ).toEqual(WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR);
    expect(catalog.listDescriptors()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'pane:builtin:chat',
          renderer: { kind: 'builtin-component', name: 'workspace-chat' },
          placement: expect.objectContaining({
            supportedRegions: ['primary', 'standalone', 'docked'],
          }),
        }),
        expect.objectContaining({
          id: 'pane:builtin:coding:file-browser',
          rendererId:
            'renderer:builtin:builtin-component:workspace-coding-file-browser',
          renderer: {
            kind: 'builtin-component',
            name: 'workspace-coding-file-browser',
          },
          modes: [
            {
              id: 'default',
              contextRequirement: {
                project: true,
                source: true,
                workspace: true,
              },
            },
          ],
        }),
        expect.objectContaining({
          id: 'pane:builtin:coding:diff',
          rendererId:
            'renderer:builtin:builtin-component:workspace-coding-diff',
          renderer: {
            kind: 'builtin-component',
            name: 'workspace-coding-diff',
          },
          modes: [
            {
              id: 'default',
              contextRequirement: {
                project: true,
                source: true,
                workspace: true,
              },
            },
          ],
        }),
        expect.objectContaining({
          id: 'pane:builtin:coding:terminal',
          rendererId:
            'renderer:builtin:builtin-component:workspace-coding-terminal',
          renderer: {
            kind: 'builtin-component',
            name: 'workspace-coding-terminal',
          },
          modes: [
            {
              id: 'default',
              contextRequirement: {
                project: true,
                source: true,
                workspace: true,
              },
            },
          ],
        }),
        expect.objectContaining({
          id: 'pane:builtin:workspace-preview:file-preview',
          rendererId:
            'renderer:builtin:builtin-component:workspace-file-preview',
          renderer: {
            kind: 'builtin-component',
            name: 'workspace-file-preview',
          },
          modes: [
            {
              id: 'default',
              contextRequirement: { project: true, source: true },
            },
          ],
          provenance: { origin: 'builtin' },
          lifecycle: { stage: 'preview' },
        }),
        expect.objectContaining({
          id: 'pane:builtin:workspace-preview:browser-preview',
          rendererId:
            'renderer:builtin:builtin-component:workspace-browser-preview',
          renderer: {
            kind: 'builtin-component',
            name: 'workspace-browser-preview',
          },
          modes: [
            {
              id: 'default',
              contextRequirement: { project: true, source: true },
            },
          ],
        }),
        expect.objectContaining({
          id: 'pane:builtin:workspace-preview:flow-run-console',
          rendererId: 'renderer:builtin:builtin-component:flow-run-console',
          renderer: {
            kind: 'builtin-component',
            name: 'flow-run-console',
          },
          modes: [{ id: 'default', contextRequirement: { project: true } }],
        }),
        expect.objectContaining({
          id: 'pane:builtin:evidence:plan',
          renderer: { kind: 'builtin-component', name: 'workspace-plan' },
          modes: [{ id: 'default', contextRequirement: { project: true } }],
        }),
        expect.objectContaining({
          id: 'pane:builtin:evidence:readiness',
          renderer: { kind: 'builtin-component', name: 'workspace-readiness' },
          modes: [{ id: 'default', contextRequirement: { project: true } }],
        }),
        expect.objectContaining({
          id: 'pane:builtin:evidence:trust',
          renderer: { kind: 'builtin-component', name: 'workspace-trust' },
          modes: [{ id: 'default', contextRequirement: { project: true } }],
        }),
        expect.objectContaining({
          id: 'pane:builtin:workspace-spatial-board',
          renderer: {
            kind: 'builtin-component',
            name: 'workspace-spatial-board',
          },
          modes: [{ id: 'default', contextRequirement: { project: true } }],
        }),
      ]),
    );
    expect(catalog.getDescriptor('pane:builtin:chat')?.modes).toEqual([
      { id: 'default' },
    ]);
    expect(
      KNOWN_WORKSPACE_PANE_DECLARATIONS.map(
        (declaration) => declaration.availabilityInput,
      ),
    ).toEqual([
      {
        rollout: 'available',
        distribution: 'enabled',
        context: { project: 'present' },
      },
      {
        rollout: 'available',
        distribution: 'enabled',
        context: { project: 'present' },
      },
      {
        rollout: 'available',
        distribution: 'enabled',
        context: { project: 'present' },
      },
      {
        rollout: 'available',
        distribution: 'enabled',
        context: { project: 'present' },
        requirements: { deploymentCapabilities: ['browser-pane'] },
      },
      // Epic #2323 S3: Plugin preview. Opening it runs nothing, so it carries
      // no requirement beyond a Project.
      {
        rollout: 'available',
        distribution: 'enabled',
        context: { project: 'present' },
      },
      {
        rollout: 'available',
        distribution: 'enabled',
        context: { project: 'present' },
      },
      {
        rollout: 'available',
        distribution: 'enabled',
        context: { project: 'present' },
        requirements: { gitRepository: true },
      },
      {
        rollout: 'available',
        distribution: 'enabled',
        context: { project: 'present' },
      },
      // #1969 Device: the ONE entry with neither a `context` nor a
      // `requirements`, in declaration order between the coding terminal and
      // Plan. Adding either to the declaration reds this exact-shape list as
      // well as the dedicated test below.
      {
        rollout: 'available',
        distribution: 'enabled',
      },
      {
        rollout: 'available',
        distribution: 'enabled',
        context: { project: 'present' },
      },
      {
        rollout: 'available',
        distribution: 'enabled',
        context: { project: 'present' },
      },
      {
        rollout: 'available',
        distribution: 'enabled',
        context: { project: 'present' },
      },
      {
        rollout: 'available',
        distribution: 'enabled',
        context: { project: 'present' },
      },
      { rollout: 'coming-soon' },
    ]);
    expect(createWorkspaceCodingFileBrowserPaneInstance('project-a')).toEqual(
      expect.objectContaining({
        descriptorId: 'pane:builtin:coding:file-browser',
      }),
    );
    // Chat is issued for a Project AND placed projectless by the shell dock
    // (archive#3970). This asserts the Project-bound half, which the dock's
    // arrival must not cost: dropping it would take Chat out of every layout.
    expect(createWorkspaceChatPaneInstance('project-a')).toEqual(
      expect.objectContaining({ descriptorId: 'pane:builtin:chat' }),
    );
    expect(createWorkspaceCodingDiffPaneInstance('project-a')).toEqual(
      expect.objectContaining({ descriptorId: 'pane:builtin:coding:diff' }),
    );
    expect(createWorkspaceCodingTerminalPaneInstance('project-a')).toEqual(
      expect.objectContaining({ descriptorId: 'pane:builtin:coding:terminal' }),
    );
    expect(createWorkspacePlanPaneInstance('project-a')).toEqual(
      expect.objectContaining({ descriptorId: 'pane:builtin:evidence:plan' }),
    );
    expect(createWorkspaceReadinessPaneInstance('project-a')).toEqual(
      expect.objectContaining({
        descriptorId: 'pane:builtin:evidence:readiness',
      }),
    );
    expect(createWorkspaceTrustPaneInstance('project-a')).toEqual(
      expect.objectContaining({ descriptorId: 'pane:builtin:evidence:trust' }),
    );
    expect(createWorkspaceSpatialBoardPaneInstance('project-a')).toEqual(
      expect.objectContaining({
        descriptorId: 'pane:builtin:workspace-spatial-board',
      }),
    );
  });

  test('every known declaration claiming docked is an exported built-in descriptor, byte for byte (#928, #2049)', () => {
    // `docked` means "may occupy a shell region", and the claim is pinned to
    // a reader by the UI's docked-capability-derivation test. That test can
    // only see descriptors exported as `WORKSPACE_*_DESCRIPTOR` from the
    // contracts and basis-pane barrels. A declaration authored inline here
    // (Flow Run Console is one) is invisible to it, so it must not claim
    // `docked`, and an exported one must reach the catalog unchanged.
    const exported = new Map<string, WorkspacePaneDescriptor>();
    for (const module of [contracts, basisPane] as Record<string, unknown>[])
      for (const [name, value] of Object.entries(module))
        if (/^WORKSPACE_[A-Z0-9_]+_DESCRIPTOR$/.test(name))
          exported.set(
            (value as WorkspacePaneDescriptor).id,
            value as WorkspacePaneDescriptor,
          );
    const claimingDocked = KNOWN_WORKSPACE_PANE_DECLARATIONS.filter(
      ({ descriptor }) =>
        descriptor.placement.supportedRegions.includes('docked'),
    );
    expect(claimingDocked.length).toBeGreaterThan(0);
    for (const { descriptor } of claimingDocked)
      expect(exported.get(descriptor.id), descriptor.id).toEqual(descriptor);
  });

  /**
   * #1969: what the Device declaration deliberately does NOT claim. Adding
   * `requirements: { hostCapabilities: ['local-browser-preview'] }` — the
   * shape Browser Preview carried before #90 wave 2 — reds the second
   * assertion; adding `context: { project: 'present' }`, which every
   * neighbouring entry declares, reds the third. Both would be availability
   * facts nothing about a captured PNG derives, and either would refuse the
   * pane in a dock with no project.
   */
  test('the Device declaration requires no host capability and no Project, and issues the one constant occurrence (#1969)', () => {
    const device = KNOWN_WORKSPACE_PANE_DECLARATIONS.find(
      ({ descriptor }) => descriptor.id === 'pane:builtin:device',
    );
    expect(device).toBeDefined();
    expect(device?.availabilityInput).toEqual({
      rollout: 'available',
      distribution: 'enabled',
    });
    expect(device?.availabilityInput.context).toBeUndefined();

    // The control used to be Browser Preview's `local-browser-preview`
    // claim; #90 wave 2 dropped it (the pane now streams a server Chromium
    // and renders anywhere), so the Device pin above stands on its own.

    // One occurrence whatever the project, and it binds no project.
    const first = device?.createInstance?.('project-a');
    const second = device?.createInstance?.('project-b');
    expect(first).toBe(second);
    expect(first?.boundContext?.projectId).toBeUndefined();
    expect(first?.instanceId).toBe('workspace-device');
  });

  test('deduplicates an identical descriptor and rejects an identity collision', () => {
    const declaration = KNOWN_WORKSPACE_PANE_DECLARATIONS[0]!;
    expect(
      mergeKnownWorkspacePaneDescriptors([declaration.descriptor]).size,
    ).toBe(KNOWN_WORKSPACE_PANE_DECLARATIONS.length);

    expect(() =>
      mergeKnownWorkspacePaneDescriptors([
        { ...declaration.descriptor, name: 'Conflicting File Preview' },
      ]),
    ).toThrow(/Duplicate workspace pane descriptor id/);
  });
});
