/** @vitest-environment jsdom */

import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import {
  toWorkspacePaneDescriptorId,
  toWorkspacePaneInstanceId,
  toWorkspacePaneRendererId,
  toWorkspacePaneStateKey,
  WORKSPACE_PANE_CONTRACT_VERSION,
} from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneAvailabilityInput } from '@kontourai/station-contracts/workspace-pane-availability';
import { describe, expect, test } from 'vitest';
import { completeNativeCapabilityReport } from '../../platform/native/__tests__/completeNativeCapabilityReportFixture';
import { TauriNativePlatformAdapter } from '../../platform/native/tauri';
import type {
  NativeCapabilityState,
  NativeCompileTarget,
} from '../../platform/native/types';
import { WebNativePlatformAdapter } from '../../platform/native/web';
import type { PlatformProfile } from '../../platform/PlatformProfileContext';
import { resolveWorkspacePaneCatalogPresentation } from '../resolvedWorkspacePaneCatalog';
import type { WorkspacePaneAvailabilityFacts } from '../workspacePaneAvailabilityAdapters';

type MatrixCase = {
  name: string;
  profile: PlatformProfile;
  facts: WorkspacePaneAvailabilityFacts;
  browser: { state: string; reason: string };
};

const browserDescriptor: WorkspacePaneDescriptor = {
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: toWorkspacePaneDescriptorId(
    'pane:builtin:workspace-preview:browser-preview',
  ),
  name: 'Browser Preview',
  description: 'Open a validated local browser preview for a workspace.',
  rendererId: toWorkspacePaneRendererId(
    'renderer:builtin:builtin-component:workspace-browser-preview',
  ),
  renderer: { kind: 'builtin-component', name: 'workspace-browser-preview' },
  placement: {
    supportedRegions: ['primary', 'secondary', 'standalone'],
    preferredRegion: 'secondary',
  },
  // Mirrors the real descriptor's exact default mode, so the canonical
  // renderer admission remains a declaration comparison by value.
  modes: [
    { id: 'default', contextRequirement: { project: true, source: true } },
  ],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
};

const fileDescriptor: WorkspacePaneDescriptor = {
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: toWorkspacePaneDescriptorId(
    'pane:builtin:workspace-preview:file-preview',
  ),
  name: 'File Preview',
  rendererId: toWorkspacePaneRendererId(
    'renderer:builtin:builtin-component:workspace-file-preview',
  ),
  renderer: { kind: 'builtin-component', name: 'workspace-file-preview' },
  placement: {
    supportedRegions: ['primary', 'secondary', 'standalone'],
    preferredRegion: 'secondary',
  },
  modes: [
    { id: 'default', contextRequirement: { project: true, source: true } },
  ],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
};

const flowDescriptor: WorkspacePaneDescriptor = {
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: toWorkspacePaneDescriptorId(
    'pane:builtin:workspace-preview:flow-run-console',
  ),
  name: 'Flow Run Console',
  rendererId: toWorkspacePaneRendererId(
    'renderer:builtin:builtin-component:flow-run-console',
  ),
  renderer: { kind: 'builtin-component', name: 'flow-run-console' },
  placement: {
    supportedRegions: ['primary', 'secondary', 'standalone'],
    preferredRegion: 'secondary',
  },
  modes: [{ id: 'default', contextRequirement: { project: true } }],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
};

const instances = [
  {
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: browserDescriptor.id,
    instanceId: toWorkspacePaneInstanceId('browser-preview:project:alpha'),
    stateKey: toWorkspacePaneStateKey('browser-preview:project:alpha'),
    boundContext: { projectId: 'alpha' },
  },
  {
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: fileDescriptor.id,
    instanceId: toWorkspacePaneInstanceId('file-preview:project:alpha'),
    stateKey: toWorkspacePaneStateKey('file-preview:project:alpha'),
    boundContext: {
      projectId: 'alpha',
      sourceId: 'builtin:workspace-file-preview',
    },
  },
  {
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: flowDescriptor.id,
    instanceId: toWorkspacePaneInstanceId('flow-console:project:alpha'),
    stateKey: toWorkspacePaneStateKey('flow-console:project:alpha'),
    boundContext: { projectId: 'alpha' },
  },
] as const satisfies readonly WorkspacePaneInstance[];

const available: WorkspacePaneAvailabilityInput = {
  rollout: 'available',
  distribution: 'enabled',
  context: { project: 'present' },
};

/**
 * Mirrors the product-owned known-declaration payload at the UI boundary.
 * It deliberately does not import src-server: the catalog HTTP response is
 * the contract between those packages. Browser Preview is made rollout-ready
 * here to exercise its host gate; the precedence case below keeps the shipped
 * coming-soon declaration authoritative.
 */
function catalogSnapshot(
  browserInput: WorkspacePaneAvailabilityInput,
): NonNullable<Parameters<typeof resolveWorkspacePaneCatalogPresentation>[0]> {
  return {
    projectId: 'project-alpha',
    descriptors: [browserDescriptor, fileDescriptor, flowDescriptor],
    instances,
    availability: [
      {
        descriptorId: browserDescriptor.id,
        instanceId: instances[0].instanceId,
        input: browserInput,
        availability: {
          state: 'coming-soon',
          reason: { code: 'coming-soon', source: 'product-rollout' },
        },
      },
      {
        descriptorId: fileDescriptor.id,
        instanceId: instances[1].instanceId,
        input: available,
        availability: {
          state: 'available',
          reason: { code: 'ready', source: 'resolver' },
        },
      },
      {
        descriptorId: flowDescriptor.id,
        instanceId: instances[2].instanceId,
        input: available,
        availability: {
          state: 'available',
          reason: { code: 'ready', source: 'resolver' },
        },
      },
    ],
  };
}

function profile(target: PlatformProfile['target']): PlatformProfile {
  const isDesktop = ['macos', 'windows', 'linux'].includes(target);
  const isMobile = ['android', 'ios'].includes(target);
  return {
    isTauri: target !== 'web',
    target,
    isMobile,
    isDesktop,
    supervisesBundledServer: false,
    isDevBuild: false,
  };
}

function nativeReport(
  platform: NativeCompileTarget,
  localBrowserPreview: NativeCapabilityState,
) {
  return completeNativeCapabilityReport(platform, {
    'local-browser-preview': {
      state: localBrowserPreview,
      reason: 'test fixture',
    },
  });
}

async function tauriFacts(
  target: NativeCompileTarget,
  localBrowserPreview: NativeCapabilityState,
): Promise<WorkspacePaneAvailabilityFacts> {
  const adapter = new TauriNativePlatformAdapter({
    invoke: async <T>() => nativeReport(target, localBrowserPreview) as T,
    listen: async () => () => {},
  });
  const report = await adapter.getCapabilityReport();
  if (report.status !== 'ok') {
    throw new Error('The native matrix fixture must provide a valid report.');
  }
  return { native: adapter };
}

async function unreadableTauriFacts(): Promise<WorkspacePaneAvailabilityFacts> {
  const adapter = new TauriNativePlatformAdapter({
    invoke: async <T>() => ({ malformed: true }) as T,
    listen: async () => () => {},
  });
  const report = await adapter.getCapabilityReport();
  if (report.status !== 'error') {
    throw new Error('The unreadable native matrix fixture must fail closed.');
  }
  return { native: adapter };
}

const browserInput: WorkspacePaneAvailabilityInput = {
  ...available,
  requirements: {
    hostCapabilities: ['local-browser-preview'],
    configuration: true,
  },
};

function resultFor(
  matrixCase: MatrixCase,
  input: WorkspacePaneAvailabilityInput = browserInput,
) {
  return resolveWorkspacePaneCatalogPresentation(
    catalogSnapshot(input),
    matrixCase.profile,
    matrixCase.facts,
  );
}

function entryFor(
  result: ReturnType<typeof resolveWorkspacePaneCatalogPresentation>,
  descriptor: WorkspacePaneDescriptor,
) {
  const entry = result.entries.find(
    (candidate) => candidate.descriptor.id === descriptor.id,
  );
  if (!entry) throw new Error(`Missing ${descriptor.name} matrix entry`);
  return entry;
}

describe('resolveWorkspacePaneCatalogPresentation platform matrix', () => {
  test('keeps a single realistic catalog truthful across web, native targets, missing reports, and consent', async () => {
    const matrix: readonly MatrixCase[] = [
      {
        name: 'web/PWA',
        profile: profile('web'),
        facts: { native: new WebNativePlatformAdapter() },
        browser: { state: 'unsupported', reason: 'unsupported-host' },
      },
      ...(await Promise.all(
        (['macos', 'windows', 'linux'] as const).map(async (target) => ({
          name: `desktop ${target}`,
          profile: profile(target),
          facts: {
            ...(await tauriFacts(target, 'enabled')),
            managedLoopback: 'present' as const,
          },
          browser: { state: 'available', reason: 'ready' },
        })),
      )),
      ...(await Promise.all(
        (['android', 'ios'] as const).map(async (target) => ({
          name: `mobile ${target}`,
          profile: profile(target),
          facts: await tauriFacts(target, 'unsupported'),
          browser: { state: 'unsupported', reason: 'unsupported-host' },
        })),
      )),
      {
        name: 'unreadable native report',
        profile: profile('unknown'),
        facts: await unreadableTauriFacts(),
        browser: { state: 'unsupported', reason: 'host-capability-unknown' },
      },
      {
        name: 'permission-required native report',
        profile: profile('macos'),
        facts: {
          ...(await tauriFacts('macos', 'permission-required')),
          managedLoopback: 'present' as const,
        },
        browser: {
          state: 'permission-required',
          reason: 'permission-required',
        },
      },
    ];

    for (const matrixCase of matrix) {
      const result = resultFor(matrixCase);
      const browser = entryFor(result, browserDescriptor);
      expect([
        matrixCase.name,
        browser.availability.state,
        browser.availability.reason.code,
      ]).toEqual([
        matrixCase.name,
        matrixCase.browser.state,
        matrixCase.browser.reason,
      ]);

      // File and Flow declare no native requirement. A host report must not
      // accidentally change their availability; their existing renderer facts
      // still remain authoritative.
      expect(entryFor(result, fileDescriptor).availability).toMatchObject({
        state: 'temporarily-unavailable',
        reason: { code: 'renderer-missing' },
      });
      expect(entryFor(result, flowDescriptor).availability).toMatchObject({
        state: 'available',
        reason: { code: 'ready' },
      });
    }
  });

  test('preserves coming-soon precedence over an otherwise-enabled desktop report', async () => {
    const matrixCase: MatrixCase = {
      name: 'desktop macos',
      profile: profile('macos'),
      facts: await tauriFacts('macos', 'enabled'),
      browser: { state: 'coming-soon', reason: 'coming-soon' },
    };

    const result = resultFor(matrixCase, {
      ...browserInput,
      rollout: 'coming-soon',
    });

    expect(entryFor(result, browserDescriptor).availability).toEqual({
      state: 'coming-soon',
      reason: { code: 'coming-soon', source: 'product-rollout' },
      action: { type: 'learn-more', code: 'view-rollout' },
    });
  });
});
