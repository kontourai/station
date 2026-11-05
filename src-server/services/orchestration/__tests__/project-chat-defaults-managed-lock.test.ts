/**
 * #4517: a managed lock on `defaultApprovalMode` outranks a Project's
 * approval default, at the real session start.
 *
 * Every layer is the production one: `OrchestrationService` with the real
 * `ApprovalPosture`; the Project layer from `createProjectChatDefaultsService`
 * over a real `FileStorageAdapter` (whose `getProject` applies the lock); and
 * the Station default from a real `ConfigLoader`, whose `loadAppConfig`
 * applies the managed overlay. The engine records the posture each start
 * asked it for.
 */
import { join } from 'node:path';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import { summarizeManagedPolicy } from '@kontourai/station-contracts/managed-policy';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import type {
  ApprovalMode,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import {
  decodeManagedPolicy,
  type LoadedManagedPolicy,
  managedPolicyDigest,
} from '@kontourai/station-shared/managed-policy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { putProject } from '../../../domain/__tests__/file-storage-test-helpers.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { installManagedAppSettings } from '../../../domain/managed-settings.js';
import type { ProviderAdapterMetadata } from '../../../providers/adapter-shape.js';
import { createProjectChatDefaultsService } from '../../projects/project-chat-defaults.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const USER = 'managed-lock-owner';
const OPERATOR_ORIGIN: ClientOrigin = {
  version: 1,
  actor: { kind: 'operator' },
  reported: { version: 1, surface: 'web', build: null },
};

class RecordingAdapter extends GateTestAdapter {
  override readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Claude Code',
    description: 'Managed approval lock start adapter',
    capabilities: ['agent-runtime'],
    modelLaunch: {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'engine-selected',
      omissionPerTurn: 'engine-selected',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    },
  };
  readonly starts: ProviderSessionStartInput[] = [];
  override async startSession(input: ProviderSessionStartInput) {
    this.starts.push(input);
    return super.startSession(input);
  }
  lastStartPosture(): unknown {
    return this.starts.at(-1)?.modelOptions?.approvalMode;
  }
}

function lockApprovalAt(mode: ApprovalMode): LoadedManagedPolicy {
  const document = decodeManagedPolicy('/test/policy.json', {
    kind: 'value',
    value: {
      schemaVersion: 1,
      organization: 'Acme',
      settings: { defaultApprovalMode: { value: mode, locked: true } },
    },
  });
  return {
    source: { kind: 'test-override', location: '/test/policy.json' },
    document,
    digest: managedPolicyDigest(document),
    summary: summarizeManagedPolicy(document),
  };
}

const makeTempDir = trackTempDirs();
afterEach(() => installManagedAppSettings(null));

async function harness(project: Partial<ProjectConfig>) {
  const home = makeTempDir('station-managed-approval-lock-');
  const storage = new FileStorageAdapter(home);
  await putProject(storage, {
    id: 'project-locked',
    slug: 'alpha',
    name: 'Alpha',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...project,
  });
  const loader = new ConfigLoader({ projectHomeDir: home });
  // This Station's own choice is Auto too, so only the lock can make Ask.
  await loader.loadAppConfig();
  await loader.updateAppConfig({ defaultApprovalMode: 'auto' });
  const chatDefaults = createProjectChatDefaultsService(home, storage);
  const adapter = new RecordingAdapter();
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: new EventStore(join(home, 'orchestration.sqlite')),
    resolveSessionAgent: async (start) => ({
      ...start,
      agent: { slug: 'claude' },
    }),
    resolveStationDefaultApprovalMode: async () =>
      (await loader.loadAppConfig()).defaultApprovalMode,
    projectChatDefaults: chatDefaults,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  let counter = 0;
  const start = async (approvalMode?: ApprovalMode) => {
    counter += 1;
    const threadId = `session-${counter}`;
    const conversationId = `conversation:${counter}`;
    const outcome = await service.startSessionInternal(
      {
        type: 'start-session',
        input: {
          threadId,
          provider: 'claude',
          ...(approvalMode ? { modelOptions: { approvalMode } } : {}),
          metadata: {
            agentSlug: 'claude',
            projectSlug: 'alpha',
            conversationId,
            environmentId: 'station',
          },
        },
      },
      { userId: USER, clientOrigin: OPERATOR_ORIGIN },
      {
        resourceAdmissionIntent: 'interactive_user',
        personChatStart: true,
        conversationIdentity: { conversationId, environmentId: 'station' },
      },
    );
    expect(outcome.status).toBe('accepted');
    return adapter.lastStartPosture();
  };
  const project1 = () => storage.getProject('alpha');
  return { start, chatDefaults, project: project1 };
}

describe('a managed defaultApprovalMode lock at session start', () => {
  test('a Project fixed at Auto starts in the locked Ask', async () => {
    const h = await harness({ defaultApprovalMode: 'auto' });
    // Without the policy the Project's own default decides.
    expect(await h.start()).toBe('auto');

    installManagedAppSettings(lockApprovalAt('ask'));
    expect(await h.start()).toBe('ask');
  });

  test('a last-used Project does not reapply its last start past the lock', async () => {
    const h = await harness({ defaultApprovalModeSelection: 'last-used' });
    // A person's chat started in Auto is recorded as this Project's last use.
    await h.start('auto');
    await vi.waitFor(() => {
      expect(h.chatDefaults.lastUsed(h.project(), USER).approval).toMatchObject(
        { approvalMode: 'auto' },
      );
    });
    expect(await h.start()).toBe('auto');

    installManagedAppSettings(lockApprovalAt('ask'));
    expect(await h.start()).toBe('ask');
    // The chat-defaults view a composer reads agrees: no Project layer.
    const view = h.chatDefaults.view(h.project(), USER, {
      mayGrantFullAccess: false,
    });
    expect(view.approvalMode.selection).toBe('fixed');
    expect(view.approvalMode.resolved.approvalMode).toBeUndefined();
  });
});
