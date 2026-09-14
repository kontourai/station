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
        requirements: {
          hostCapabilities: ['local-browser-preview'],
          configuration: true,
        },
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

  test('the known declarations claiming docked are exactly Chat, the three coding panes and File Preview (#928, #2047, #2049)', () => {
    // `docked` means "may occupy a shell region". Since #2049 a descriptor
    // may earn that two ways, and both have a reader:
    //
    // - as a REGISTERED SURFACE — Chat and the three coding panes, in
    //   `REGION_SURFACE_REGISTRY`;
    // - as an INSTANCE-KEYED family — File Preview, which has no blank
    //   canonical occurrence and so is no registry key at all; it reaches a
    //   region through `INSTANCE_SURFACE_PREFIXES` (`file-preview:<nonce>`),
    //   and `docked-capability-derivation.test.ts` pins each prefix's
    //   descriptor id to a descriptor that exists and declares `docked`.
    //
    // A new entry here claiming `docked` must have one of those two readers,
    // or the claim is a label nothing derives. Note File Preview IS declared
    // to this catalog, so the region's "+" would list a card that can never
    // open — `dockCatalogEntries` filters instance-keyed descriptors out for
    // exactly that reason. Declaration order, so a reordering is visible too.
    const claimingDocked = KNOWN_WORKSPACE_PANE_DECLARATIONS.filter(
      ({ descriptor }) =>
        descriptor.placement.supportedRegions.includes('docked'),
    ).map(({ descriptor }) => descriptor.id);
    expect(claimingDocked).toEqual([
      'pane:builtin:chat',
      'pane:builtin:workspace-preview:file-preview',
      'pane:builtin:coding:file-browser',
      'pane:builtin:coding:diff',
      'pane:builtin:coding:terminal',
    ]);
    // The pin has power only if the set it filters is the real one.
    expect(KNOWN_WORKSPACE_PANE_DECLARATIONS.length).toBeGreaterThan(5);
    expect(
      KNOWN_WORKSPACE_PANE_DECLARATIONS.map(({ descriptor }) => descriptor.id),
    ).toContain('pane:builtin:workspace-preview:flow-run-console');
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
