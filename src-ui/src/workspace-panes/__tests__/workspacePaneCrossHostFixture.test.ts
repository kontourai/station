/** @vitest-environment jsdom */

import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneAvailabilityInput } from '@kontourai/station-contracts/workspace-pane-availability';
import { restoreWorkspacePaneHostDocument } from '@kontourai/station-contracts/workspace-pane-host';
import { createWorkspacePaneCatalog } from '@kontourai/station-contracts/workspace-pane-layout-adapter';
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
import type {
  NativeCapabilityReader,
  WorkspacePaneAvailabilityFacts,
} from '../workspacePaneAvailabilityAdapters';
import { workspacePaneCrossHostFixtureJson } from '../workspacePaneCrossHostFixture';

interface CrossHostFixture {
  catalog: {
    projectId: string;
    descriptors: unknown[];
    instances: unknown[];
  };
  restoration: unknown;
  availability: {
    browser: WorkspacePaneAvailabilityInput;
    flow: WorkspacePaneAvailabilityInput;
  };
}

interface HostCase {
  name: string;
  profile: PlatformProfile;
  facts: WorkspacePaneAvailabilityFacts;
  browser: {
    state: string;
    reason: string;
    action: { type: string; code: string };
  };
}

function parseFixture(): CrossHostFixture {
  const fixture = JSON.parse(
    workspacePaneCrossHostFixtureJson,
  ) as CrossHostFixture;
  expect(JSON.stringify(fixture)).toBe(workspacePaneCrossHostFixtureJson);
  return fixture;
}

function profile(target: PlatformProfile['target']): PlatformProfile {
  return {
    isTauri: target !== 'web',
    target,
    isMobile: false,
    isDesktop: target !== 'web',
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
      reason: 'fixture',
    },
  });
}

async function tauriFacts(): Promise<WorkspacePaneAvailabilityFacts> {
  const adapter = new TauriNativePlatformAdapter({
    invoke: async <T>() => nativeReport('macos', 'enabled') as T,
    listen: async () => () => {},
  });
  const report = await adapter.getCapabilityReport();
  if (report.status !== 'ok') {
    throw new Error('The Tauri fixture report must be readable.');
  }
  return { native: adapter, managedLoopback: 'present' };
}

/** A non-Tauri desktop edge adapter with no domain or restoration behavior. */
const alternateDesktopHost: NativeCapabilityReader = {
  capability(id) {
    return {
      id,
      state: id === 'local-browser-preview' ? 'enabled' : 'unsupported',
      reason: 'synthetic alternate desktop capability report',
    };
  },
};

function catalogAndRestoration(fixture: CrossHostFixture) {
  const descriptors = fixture.catalog.descriptors.map((candidate) => {
    const descriptor = parseWorkspacePaneDescriptor(candidate);
    if (!descriptor) throw new Error('Fixture descriptor must be valid.');
    return descriptor;
  });
  const instances = fixture.catalog.instances.map((candidate) => {
    const instance = parseWorkspacePaneInstance(candidate);
    if (!instance) throw new Error('Fixture instance must be valid.');
    return instance;
  });
  const catalog = createWorkspacePaneCatalog({ descriptors, instances });
  const restored = restoreWorkspacePaneHostDocument(
    fixture.restoration,
    catalog.listInstances(),
  );
  if (!restored.document) throw new Error('Fixture restoration must succeed.');
  return { catalog, restored: restored.document };
}

function browserEntry(
  result: ReturnType<typeof resolveWorkspacePaneCatalogPresentation>,
) {
  const entry = result.entries.find(
    (candidate) =>
      candidate.descriptor.id ===
      'pane:builtin:workspace-preview:browser-preview',
  );
  if (!entry) throw new Error('Browser Preview must be in the catalog.');
  return entry;
}

describe('Workspace Pane cross-host serialized fixture', () => {
  test('keeps one catalog and restoration document byte-stable across Web, Tauri, and an alternate desktop host', async () => {
    const hosts: readonly HostCase[] = [
      {
        name: 'web',
        profile: profile('web'),
        facts: { native: new WebNativePlatformAdapter() },
        browser: {
          state: 'unsupported',
          reason: 'unsupported-host',
          action: { type: 'learn-more', code: 'view-host-requirements' },
        },
      },
      {
        name: 'tauri',
        profile: profile('macos'),
        facts: await tauriFacts(),
        browser: {
          state: 'available',
          reason: 'ready',
          action: { type: 'none', code: 'none' },
        },
      },
      {
        name: 'alternate-desktop',
        profile: profile('windows'),
        facts: { native: alternateDesktopHost, managedLoopback: 'missing' },
        browser: {
          state: 'not-configured',
          reason: 'configuration-missing',
          action: { type: 'setup', code: 'complete-configuration' },
        },
      },
    ];

    for (const host of hosts) {
      const fixture = parseFixture();
      const { catalog, restored } = catalogAndRestoration(fixture);

      expect(
        JSON.stringify({
          projectId: fixture.catalog.projectId,
          descriptors: catalog.list(),
          instances: catalog.listInstances(),
        }),
      ).toBe(JSON.stringify(fixture.catalog));
      expect(JSON.stringify(restored)).toBe(
        JSON.stringify(fixture.restoration),
      );
      expect(restored.instances).toHaveLength(catalog.instanceCount);
      for (const instance of restored.instances) {
        expect(instance).toBe(catalog.getInstance(instance.instanceId));
      }

      const browserDescriptor = catalog.get(
        'pane:builtin:workspace-preview:browser-preview',
      );
      const browserInstance = catalog.listInstances(browserDescriptor?.id)[0];
      const flowDescriptor = catalog.get(
        'pane:builtin:cross-host:flow-run-console',
      );
      const flowInstance = catalog.listInstances(flowDescriptor?.id)[0];
      if (
        !browserDescriptor ||
        !browserInstance ||
        !flowDescriptor ||
        !flowInstance
      ) {
        throw new Error(
          'Fixture catalog must retain both exact pane identities.',
        );
      }
      const availability = [
        {
          descriptorId: browserDescriptor.id,
          instanceId: browserInstance.instanceId,
          input: fixture.availability.browser,
          availability: {
            state: 'available' as const,
            reason: { code: 'ready' as const, source: 'resolver' as const },
          },
        },
        {
          descriptorId: flowDescriptor.id,
          instanceId: flowInstance.instanceId,
          input: fixture.availability.flow,
          availability: {
            state: 'available' as const,
            reason: { code: 'ready' as const, source: 'resolver' as const },
          },
        },
      ];
      const presentation = resolveWorkspacePaneCatalogPresentation(
        {
          projectId: fixture.catalog.projectId,
          descriptors: catalog.list(),
          instances: catalog.listInstances(),
          availability,
        },
        host.profile,
        host.facts,
      );
      const browser = browserEntry(presentation).availability;

      expect([host.name, browser.state, browser.reason.code]).toEqual([
        host.name,
        host.browser.state,
        host.browser.reason,
      ]);
      if (host.browser.action.type === 'none') {
        expect(browser.action).toBeUndefined();
      } else {
        expect(browser.action).toEqual(host.browser.action);
      }
    }
  });
});
