/**
 * A Project's new-chat approval layer and its last-used record, through the
 * real session start: `OrchestrationService.startSessionInternal` with the
 * context and internal options the foreground chat seam passes
 * (`station-control-delegation.ts`: the request's client origin, the user,
 * `resourceAdmissionIntent: 'interactive_user'` and, for a person's own `/chat`,
 * `personChatStart`), the real `ApprovalPosture`,
 * the real `ProjectChatDefaultsService` over a temporary home, and an engine
 * that records what each start asked it for.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import type {
  ApprovalMode,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import type { ProviderAdapterMetadata } from '../../../providers/adapter-shape.js';
import {
  type FullAccessGrant,
  fullAccessGrantFor,
} from '../../../security/coding-authority.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { ProjectChatDefaultsService } from '../../projects/project-chat-defaults.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const USER = 'chat-defaults-owner';
const OTHER_USER = 'someone-else';

const OPERATOR_ORIGIN: ClientOrigin = {
  version: 1,
  actor: { kind: 'operator' },
  reported: { version: 1, surface: 'web', build: null },
};
const AGENT_ORIGIN: ClientOrigin = {
  ...OPERATOR_ORIGIN,
  actor: { kind: 'internal' },
};

class RecordingAdapter extends GateTestAdapter {
  override readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Claude Code',
    description: 'Project chat defaults start adapter',
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
  /** Throw from the next start, as an engine that cannot launch would. */
  failNext = false;

  override async startSession(input: ProviderSessionStartInput) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('engine refused to start');
    }
    this.starts.push(input);
    return super.startSession(input);
  }

  lastStartPosture(): unknown {
    return this.starts.at(-1)?.modelOptions?.approvalMode;
  }
}

function operatorGrant(): FullAccessGrant {
  const request = new Request('http://station.test/api/orchestration/chat');
  setRuntimeAuthenticatedRequestPrincipal(request, {
    credential: 'operator-credential-fixture',
    authority: 'operator-credential',
    source: 'bearer',
  });
  const grant = fullAccessGrantFor(request, undefined);
  if (!grant) throw new Error('fixture: the operator must hold a grant');
  return grant;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function createHarness(input: {
  project: Partial<ProjectConfig>;
  stationDefault?: ApprovalMode;
}) {
  const root = mkdtempSync(join(tmpdir(), 'station-project-chat-defaults-'));
  roots.push(root);
  const project: ProjectConfig = {
    id: 'project-id-1',
    name: 'Alpha',
    slug: 'alpha',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...input.project,
  };
  const projects = new Map([[project.slug, project]]);
  const chatDefaults = new ProjectChatDefaultsService({
    homeDir: root,
    getProject: (slug) => projects.get(slug),
  });
  const store = new EventStore(join(root, 'orchestration.sqlite'));
  const adapter = new RecordingAdapter();
  const warn = vi.fn();
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: store,
    resolveSessionAgent: async (start) => ({
      ...start,
      agent: { slug: 'claude' },
    }),
    resolveStationDefaultApprovalMode: async () => input.stationDefault,
    projectChatDefaults: chatDefaults,
    logger: { debug: vi.fn(), warn },
  });
  let counter = 0;
  /** A person's new chat in the Project, as the foreground seam starts it. */
  const start = async (options?: {
    modelId?: string;
    approvalMode?: ApprovalMode;
    userId?: string;
    clientOrigin?: ClientOrigin;
    intent?: 'interactive_user' | 'delegated_background';
    /** The `/chat` route's person-chat flag; on unless a test turns it off. */
    personChatStart?: boolean;
    /** A Default pick recorded on the thread before it starts. */
    defaultPick?: boolean;
    /** The person's personal default hint, as the executor records it. */
    personalHint?: ApprovalMode;
    fullAccessGrant?: FullAccessGrant;
    delegation?: boolean;
    projectSlug?: string;
  }) => {
    counter += 1;
    const threadId = `session-${counter}`;
    const conversationId = `conversation:${counter}`;
    if (options?.personalHint)
      await service.recordPersonalApprovalDefault({
        threadId,
        provider: 'claude',
        approvalMode: options.personalHint,
        agentSlug: 'claude',
        projectSlug: options?.projectSlug ?? project.slug,
        userId: options?.userId ?? USER,
        personChat: options?.personChatStart !== false,
        mayGrantFullAccess: options?.fullAccessGrant !== undefined,
      });
    if (options?.defaultPick)
      service.recordApprovalModeDecision({
        threadId,
        provider: 'claude',
        approvalMode: 'connection-default',
        basedOnSequence: null,
      });
    const outcome = await service.startSessionInternal(
      {
        type: 'start-session',
        input: {
          threadId,
          provider: 'claude',
          ...(options?.modelId ? { modelId: options.modelId } : {}),
          ...(options?.approvalMode
            ? { modelOptions: { approvalMode: options.approvalMode } }
            : {}),
          metadata: {
            agentSlug: 'claude',
            projectSlug: options?.projectSlug ?? project.slug,
            conversationId,
            environmentId: 'station',
            ...(options?.delegation
              ? { delegation: { parentSessionId: 'parent', depth: 1 } }
              : {}),
          },
        },
      },
      {
        userId: options?.userId ?? USER,
        clientOrigin: options?.clientOrigin ?? OPERATOR_ORIGIN,
        ...(options?.fullAccessGrant
          ? { fullAccessGrant: options.fullAccessGrant }
          : {}),
      },
      {
        resourceAdmissionIntent: options?.intent ?? 'interactive_user',
        ...(options?.personChatStart === false
          ? {}
          : { personChatStart: true as const }),
        conversationIdentity: { conversationId, environmentId: 'station' },
      },
    );
    return outcome;
  };
  /** The record write is best effort and detached from the start. */
  const recorded = async (userId = USER) => {
    await vi.waitFor(() => {
      expect(chatDefaults.lastUsed(project, userId).models.length).toBe(1);
    });
    return chatDefaults.lastUsed(project, userId);
  };
  return {
    root,
    project,
    projects,
    chatDefaults,
    adapter,
    start,
    recorded,
    warn,
  };
}

describe('Project new-chat defaults at session start', () => {
  test('last-used: the next chat starts in the mode and is offered the model the last one started with', async () => {
    const h = createHarness({
      project: {
        defaultApprovalModeSelection: 'last-used',
        defaultModelSelection: 'last-used',
      },
      stationDefault: 'ask',
    });
    // Station default only: nothing recorded yet.
    expect((await h.start({ modelId: 'model-a' })).status).toBe('accepted');
    expect(h.adapter.lastStartPosture()).toBe('ask');
    // A chat the person started in Auto (the composer's carried pick).
    await h.start({ modelId: 'model-b', approvalMode: 'auto' });
    await vi.waitFor(() => {
      expect(h.chatDefaults.lastUsed(h.project, USER).approval).toMatchObject({
        approvalMode: 'auto',
      });
    });
    expect(h.chatDefaults.lastUsed(h.project, USER).models).toEqual([
      expect.objectContaining({ agentSlug: 'claude', modelId: 'model-b' }),
    ]);
    // The next chat carries nothing and starts in what the last one used.
    await h.start({ modelId: 'model-c' });
    expect(h.adapter.lastStartPosture()).toBe('auto');
    await vi.waitFor(() => {
      const view = h.chatDefaults.view(h.project, USER, {
        mayGrantFullAccess: false,
      });
      expect(view.approvalMode.resolved).toEqual({
        approvalMode: 'auto',
        source: 'last-used',
      });
      expect(view.model).toEqual({
        selection: 'last-used',
        lastUsed: [expect.objectContaining({ modelId: 'model-c' })],
      });
    });
  });

  test('fixed: the Project mode applies and the recorded history is ignored', async () => {
    const h = createHarness({
      project: { defaultApprovalMode: 'ask' },
      stationDefault: 'auto',
    });
    await h.start({ approvalMode: 'auto', modelId: 'model-a' });
    await h.recorded();
    expect(
      h.chatDefaults.lastUsed(h.project, USER).approval?.approvalMode,
    ).toBe('auto');
    await h.start();
    expect(h.adapter.lastStartPosture()).toBe('ask');
  });

  test('last-used with no history falls back to the fixed mode, then the Station default', async () => {
    const withFixed = createHarness({
      project: {
        defaultApprovalModeSelection: 'last-used',
        defaultApprovalMode: 'auto',
      },
      stationDefault: 'ask',
    });
    await withFixed.start();
    expect(withFixed.adapter.lastStartPosture()).toBe('auto');
    expect(
      withFixed.chatDefaults.view(withFixed.project, USER, {
        mayGrantFullAccess: false,
      }).approvalMode.resolved,
    ).toEqual({
      approvalMode: 'auto',
      source: 'fixed',
      fallback: 'no-history',
    });

    const withoutFixed = createHarness({
      project: { defaultApprovalModeSelection: 'last-used' },
      stationDefault: 'ask',
    });
    await withoutFixed.start();
    expect(withoutFixed.adapter.lastStartPosture()).toBe('ask');
  });

  test('a recorded full access is reused only by a start that may grant it', async () => {
    const h = createHarness({
      project: {
        defaultApprovalModeSelection: 'last-used',
        defaultApprovalMode: 'ask',
      },
    });
    const grant = operatorGrant();
    await h.start({
      approvalMode: 'never',
      fullAccessGrant: grant,
      modelId: 'model-a',
    });
    expect(h.adapter.lastStartPosture()).toBe('never');
    await vi.waitFor(() => {
      expect(
        h.chatDefaults.lastUsed(h.project, USER).approval?.approvalMode,
      ).toBe('never');
    });
    // Without a grant the next chat takes the fixed mode, never full access.
    await h.start();
    expect(h.adapter.lastStartPosture()).toBe('ask');
    // With the grant, the last-used full access applies again.
    await h.start({ fullAccessGrant: grant });
    expect(h.adapter.lastStartPosture()).toBe('never');
  });

  test('an Agent default still wins over the Project layer', async () => {
    const h = createHarness({ project: { defaultApprovalMode: 'auto' } });
    // `capturedAgent` is the foreground admission's Agent; here the Agent
    // default comes from the loader the service reads.
    const service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(h.adapter),
      eventBus: new EventBus(),
      eventStore: new EventStore(join(h.root, 'agent.sqlite')),
      resolveSessionAgent: async (start) => ({
        ...start,
        agent: { slug: 'claude' },
      }),
      loadAgentExecutionConfig: async () => ({ approvalMode: 'ask' }),
      projectChatDefaults: h.chatDefaults,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    await service.startSessionInternal(
      {
        type: 'start-session',
        input: {
          threadId: 'agent-default',
          provider: 'claude',
          metadata: {
            agentSlug: 'claude',
            projectSlug: 'alpha',
            conversationId: 'conversation:agent',
            environmentId: 'station',
          },
        },
      },
      { userId: USER, clientOrigin: OPERATOR_ORIGIN },
      {
        resourceAdmissionIntent: 'interactive_user',
        personChatStart: true,
        conversationIdentity: {
          conversationId: 'conversation:agent',
          environmentId: 'station',
        },
      },
    );
    expect(h.adapter.lastStartPosture()).toBe('ask');
  });

  test('only a person’s own interactive chat records or inherits a last-used value', async () => {
    const h = createHarness({
      project: { defaultApprovalModeSelection: 'last-used' },
      stationDefault: 'ask',
    });
    // An agent's start and a delegation record nothing...
    await h.start({
      approvalMode: 'auto',
      clientOrigin: AGENT_ORIGIN,
      modelId: 'x',
    });
    await h.start({ approvalMode: 'auto', delegation: true, modelId: 'y' });
    await h.start({
      approvalMode: 'auto',
      intent: 'delegated_background',
      personChatStart: false,
      modelId: 'z',
    });
    // ...which the person's own chat (recorded next) proves was not slow.
    await h.start({ approvalMode: 'ask', modelId: 'mine' });
    const mine = await h.recorded();
    expect(mine.models.map((model) => model.modelId)).toEqual(['mine']);
    expect(mine.approval?.approvalMode).toBe('ask');
    // Another user's chat is theirs alone.
    await h.start({
      approvalMode: 'auto',
      modelId: 'theirs',
      userId: OTHER_USER,
    });
    await h.recorded(OTHER_USER);
    expect(
      h.chatDefaults.lastUsed(h.project, USER).approval?.approvalMode,
    ).toBe('ask');
    // And an agent's start never inherits the person's last-used value.
    await h.start({ approvalMode: 'auto', modelId: 'm' });
    await vi.waitFor(() => {
      expect(
        h.chatDefaults.lastUsed(h.project, USER).approval?.approvalMode,
      ).toBe('auto');
    });
    await h.start({ clientOrigin: AGENT_ORIGIN });
    expect(h.adapter.lastStartPosture()).toBe('ask');
  });

  test('a Default pick resolves to the Agent and Station defaults, never the Project layer, both ways', async () => {
    // Project looser than Station: the pick must not run looser than shown.
    const looser = createHarness({
      project: { defaultApprovalMode: 'auto' },
      stationDefault: 'ask',
    });
    await looser.start({ defaultPick: true });
    expect(looser.adapter.lastStartPosture()).toBe('ask');
    // Project stricter than Station.
    const stricter = createHarness({
      project: { defaultApprovalMode: 'ask' },
      stationDefault: 'auto',
    });
    await stricter.start({ defaultPick: true });
    expect(stricter.adapter.lastStartPosture()).toBe('auto');
    // And without a pick the Project layer applies.
    await stricter.start();
    expect(stricter.adapter.lastStartPosture()).toBe('ask');
  });

  test('a start without the route’s person-chat flag neither records nor inherits', async () => {
    const h = createHarness({
      project: { defaultApprovalModeSelection: 'last-used' },
      stationDefault: 'ask',
    });
    await h.start({ approvalMode: 'auto', modelId: 'mine' });
    await h.recorded();
    await h.start({ personChatStart: false });
    expect(h.adapter.lastStartPosture()).toBe('ask');
    await h.start({
      personChatStart: false,
      approvalMode: 'never',
      modelId: 'n',
    });
    await h.start();
    expect(h.adapter.lastStartPosture()).toBe('auto');
  });

  test('a corrupt record is moved aside and the next start records again', async () => {
    const h = createHarness({
      project: { defaultApprovalModeSelection: 'last-used' },
      stationDefault: 'ask',
    });
    const file = join(h.root, 'project-chat-last-used.json');
    writeFileSync(file, '{not json');
    await h.start({ approvalMode: 'auto', modelId: 'after' });
    expect((await h.recorded()).models[0]?.modelId).toBe('after');
    expect(
      readdirSync(h.root).some((name) =>
        name.startsWith('project-chat-last-used.json.corrupt-'),
      ),
    ).toBe(true);
    await h.start();
    expect(h.adapter.lastStartPosture()).toBe('auto');
    expect(h.warn).not.toHaveBeenCalledWith(
      'Project chat last-used record failed',
      expect.anything(),
    );
  });

  test('the personal default hint applies only when the Project sets nothing', async () => {
    const none = createHarness({ project: {}, stationDefault: 'ask' });
    await none.start({ personalHint: 'auto' });
    expect(none.adapter.lastStartPosture()).toBe('auto');
    // The Project layer beats the hint.
    const fixed = createHarness({
      project: { defaultApprovalMode: 'ask' },
      stationDefault: 'auto',
    });
    await fixed.start({ personalHint: 'never' });
    expect(fixed.adapter.lastStartPosture()).toBe('ask');
    // A last-used Project with history beats it too; without history the
    // hint applies.
    const last = createHarness({
      project: { defaultApprovalModeSelection: 'last-used' },
      stationDefault: 'ask',
    });
    await last.start({ personalHint: 'auto' });
    expect(last.adapter.lastStartPosture()).toBe('auto');
    await vi.waitFor(() =>
      expect(
        last.chatDefaults.lastUsed(last.project, USER).approval?.approvalMode,
      ).toBe('auto'),
    );
    await last.start({ approvalMode: 'ask', modelId: 'm' });
    await vi.waitFor(() =>
      expect(
        last.chatDefaults.lastUsed(last.project, USER).approval?.approvalMode,
      ).toBe('ask'),
    );
    await last.start({ personalHint: 'auto' });
    expect(last.adapter.lastStartPosture()).toBe('ask');
  });

  test('a failed start records nothing', async () => {
    const h = createHarness({
      project: { defaultModelSelection: 'last-used' },
    });
    h.adapter.failNext = true;
    expect((await h.start({ modelId: 'broken-model' })).status).not.toBe(
      'accepted',
    );
    await h.start({ modelId: 'working-model' });
    expect((await h.recorded()).models.map((model) => model.modelId)).toEqual([
      'working-model',
    ]);
  });

  test('a Project re-created under the same slug inherits nothing', async () => {
    const h = createHarness({
      project: { defaultApprovalModeSelection: 'last-used' },
      stationDefault: 'ask',
    });
    await h.start({ approvalMode: 'auto', modelId: 'old' });
    await h.recorded();
    h.projects.set('alpha', { ...h.project, id: 'project-id-2' });
    await h.start();
    expect(h.adapter.lastStartPosture()).toBe('ask');
  });

  test('an unreadable record reads as no history, so the fixed mode applies', async () => {
    const h = createHarness({
      project: {
        defaultApprovalModeSelection: 'last-used',
        defaultApprovalMode: 'ask',
      },
    });
    writeFileSync(join(h.root, 'project-chat-last-used.json'), '{not json');
    await h.start();
    expect(h.adapter.lastStartPosture()).toBe('ask');
  });
});
