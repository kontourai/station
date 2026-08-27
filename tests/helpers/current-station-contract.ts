import {
  STATION_COMPAT_MIN_CLIENT_PROTOCOL,
  STATION_COMPAT_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-browser-preview';
import {
  createWorkspaceChatPaneInstance,
  WORKSPACE_CHAT_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-chat-pane';
import {
  createWorkspaceCodingDiffPaneInstance,
  createWorkspaceCodingFileBrowserPaneInstance,
  createWorkspaceCodingTerminalPaneInstance,
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-coding-panels';
import {
  createWorkspacePlanPaneInstance,
  createWorkspaceReadinessPaneInstance,
  createWorkspaceTrustPaneInstance,
  WORKSPACE_PLAN_PANE_DESCRIPTOR,
  WORKSPACE_READINESS_PANE_DESCRIPTOR,
  WORKSPACE_TRUST_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-evidence-panels';
import { WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-file-preview';
import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import {
  resolveWorkspacePaneAvailability,
  type WorkspacePaneAvailabilityInput,
} from '@kontourai/station-contracts/workspace-pane-availability';
import { paneAdaptationFromLayoutTab } from '@kontourai/station-contracts/workspace-pane-layout-adapter';
import type { Page } from '@playwright/test';

const E2E_MOCK_CONNECTION_ID = 'e2e-mock-host';
const E2E_MOCK_CREDENTIAL = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export const E2E_STATION_COMPATIBILITY = Object.freeze({
  serverVersion: '0.0.0-e2e',
  protocolVersion: STATION_COMPAT_PROTOCOL_VERSION,
  minClientProtocol: STATION_COMPAT_MIN_CLIENT_PROTOCOL,
  capabilities: {
    remoteAuth: 1,
    devicePairing: 1,
    environmentProof: 1,
  },
});

export const E2E_STATION_CAPABILITIES = Object.freeze({
  sessionEventWindow: true,
});

/**
 * Seeds the current Connect profile shape for route-mocked browser tests.
 * These tests run directly through Playwright, outside the runner-owned
 * storage state, but still exercise the production access gate.
 */
export async function installE2EMockedStationConnection(
  page: Page,
): Promise<void> {
  await page.addInitScript(
    ({ connectionId, credential }) => {
      localStorage.setItem(
        'station-connect-connections',
        JSON.stringify([
          {
            profileVersion: 4,
            id: connectionId,
            name: 'Station E2E Mock',
            url: (globalThis as unknown as { location: { origin: string } })
              .location.origin,
            credentialRef: {
              credentialVersion: 1,
              kind: 'connection',
              id: connectionId,
            },
            credentialState: 'saved',
          },
        ]),
      );
      localStorage.setItem('station-connect-connections-active', connectionId);
      localStorage.setItem(
        'station-connect-connections-credentials',
        JSON.stringify({ [`connection:${connectionId}`]: credential }),
      );
    },
    {
      connectionId: E2E_MOCK_CONNECTION_ID,
      credential: E2E_MOCK_CREDENTIAL,
    },
  );
  await page.route('**/api/system/identity', (route) =>
    route.fulfill({
      json: {
        environmentId: 'env-e2e-mock',
        instanceId: 'instance-e2e-mock',
        bootId: 'boot-e2e-mock',
        sha: '1111111111111111111111111111111111111111',
      },
    }),
  );
}

type PaneCatalogEntry = {
  descriptor: WorkspacePaneDescriptor;
  instance?: WorkspacePaneInstance;
  input: WorkspacePaneAvailabilityInput;
};

function paneCatalogEntry(
  descriptor: WorkspacePaneDescriptor,
  instance?: WorkspacePaneInstance | null,
  input: WorkspacePaneAvailabilityInput = {},
): PaneCatalogEntry {
  return {
    descriptor,
    ...(instance ? { instance } : {}),
    input: {
      rollout: 'available',
      distribution: 'enabled',
      renderer: 'unknown',
      context: { project: 'present' },
      ...input,
    },
  };
}

/**
 * The exact built-in catalog shape used by E2E Projects. Keeping construction
 * on public contract factories makes fixture drift fail during test startup.
 */
export function createE2EWorkspacePaneCatalog(
  projectId: string,
  layoutSlug = 'code',
) {
  const coding = paneAdaptationFromLayoutTab(
    {
      id: 'coding',
      label: 'Coding',
      component: { kind: 'builtin-component', name: 'coding' },
    },
    {
      layoutSlug,
      instanceScope: `project:${projectId}:source:builtin:coding`,
      modeContextRequirement: { project: true, source: true },
      boundContext: { projectId, sourceId: 'builtin:coding' },
    },
  );
  if (!coding) throw new Error('Could not construct the E2E Coding pane');

  const entries: PaneCatalogEntry[] = [
    paneCatalogEntry(coding.descriptor, coding.instance),
    paneCatalogEntry(
      WORKSPACE_CHAT_PANE_DESCRIPTOR,
      createWorkspaceChatPaneInstance(projectId),
    ),
    paneCatalogEntry(WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR),
    paneCatalogEntry(WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR, undefined, {
      requirements: {
        hostCapabilities: ['local-browser-preview'],
        configuration: true,
      },
    }),
    paneCatalogEntry(
      WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
      createWorkspaceCodingFileBrowserPaneInstance(projectId),
      { context: { project: 'present', workspace: 'present' } },
    ),
    paneCatalogEntry(
      WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
      createWorkspaceCodingDiffPaneInstance(projectId),
      {
        context: {
          project: 'present',
          workspace: 'present',
          gitRepository: 'present',
        },
        requirements: { gitRepository: true },
      },
    ),
    paneCatalogEntry(
      WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
      createWorkspaceCodingTerminalPaneInstance(projectId),
      { context: { project: 'present', workspace: 'present' } },
    ),
    paneCatalogEntry(
      WORKSPACE_PLAN_PANE_DESCRIPTOR,
      createWorkspacePlanPaneInstance(projectId),
    ),
    paneCatalogEntry(
      WORKSPACE_READINESS_PANE_DESCRIPTOR,
      createWorkspaceReadinessPaneInstance(projectId),
    ),
    paneCatalogEntry(
      WORKSPACE_TRUST_PANE_DESCRIPTOR,
      createWorkspaceTrustPaneInstance(projectId),
    ),
  ];

  return {
    version: '1.0' as const,
    projectId,
    contributions: [],
    descriptors: entries.map(({ descriptor }) => descriptor),
    instances: entries.flatMap(({ instance }) => (instance ? [instance] : [])),
    availability: entries.map(({ descriptor, instance, input }) => ({
      descriptorId: descriptor.id,
      ...(instance ? { instanceId: instance.instanceId } : {}),
      input,
      availability: resolveWorkspacePaneAvailability(
        input,
        descriptor.modes[0].contextRequirement,
      ),
    })),
  };
}

export async function installE2EWorkspacePaneCatalog(
  page: Page,
  options: { projectSlug: string; projectId: string; layoutSlug?: string },
): Promise<void> {
  const snapshot = createE2EWorkspacePaneCatalog(
    options.projectId,
    options.layoutSlug,
  );
  await page.route(`**/api/projects/${options.projectSlug}/panes`, (route) =>
    route.fulfill({ json: { success: true, data: snapshot } }),
  );
}
