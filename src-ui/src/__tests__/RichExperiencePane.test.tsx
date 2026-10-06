/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { HarnessQuestionnaire } from '@kontourai/station-contracts/harness-questions';
import type { OrchestrationSessionEventWindow } from '@kontourai/station-contracts/orchestration';
import type { RequestOpenedEvent } from '@kontourai/station-contracts/runtime-events';
import type {
  SkillExperienceDefinitionV1,
  SkillExperienceInventoryV1,
  SkillExperienceSessionViewV1,
} from '@kontourai/station-contracts/skill-experience';
import {
  toWorkspacePaneDescriptorId,
  toWorkspacePaneInstanceId,
  toWorkspacePaneRendererId,
  toWorkspacePaneStateKey,
} from '@kontourai/station-contracts/workspace-pane';
import type { PaneSkillExperienceHost } from '@kontourai/station-contracts/workspace-pane-host-contract';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ChatUIState } from '../contexts/active-chats-state';
import { activeChatsStore } from '../contexts/active-chats-store';
import type { ChatSession } from '../types';
import type { ResolvedWorkspacePaneCatalogEntry } from '../workspace-panes/resolvedWorkspacePaneCatalog';

const probe = vi.hoisted(() => ({
  host: undefined as PaneSkillExperienceHost | undefined,
  entries: [] as ResolvedWorkspacePaneCatalogEntry[],
  current: true,
  sessionView: undefined as SkillExperienceSessionViewV1 | undefined,
}));
const transport = vi.hoisted(() => ({
  read: vi.fn(),
  inventory: vi.fn(),
  window: vi.fn(),
  answer: vi.fn(),
  invalidate: vi.fn(),
}));
const scope = {
  apiBase: 'http://station.test',
  authorityKey: 'authority-1',
  isCurrent: () => probe.current,
};
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => scope,
}));
vi.mock('../contexts/AuthorityPersistenceContext', () => ({
  useAuthorityPersistence: () => ({
    namespace: 'authority-1',
    status: 'verified',
  }),
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({
    updateChat: activeChatsStore.updateChat.bind(activeChatsStore),
  }),
  useActiveChatSelector: <T,>(
    id: string,
    selector: (state: ChatUIState | undefined) => T,
  ) => selector(activeChatsStore.getSnapshot()[id]),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useInvalidateQuery: () => transport.invalidate,
  useSkillExperienceSessionQuery: () => ({
    data: probe.sessionView,
    isPending: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
  useSkillExperienceInventoryQuery: () => ({
    data: { executionContract: '1.0', experiences: [], diagnostics: [] },
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock('@kontourai/station-sdk/client', () => ({
  fetchSkillExperienceSession: transport.read,
  fetchSkillExperienceInventory: transport.inventory,
  getOrchestrationSessionEventWindow: transport.window,
  respondToRequest: transport.answer,
}));
vi.mock('../workspace-panes/resolvedWorkspacePaneCatalog', () => ({
  useResolvedWorkspacePaneCatalog: () => ({
    entries: probe.entries,
    isPending: false,
  }),
}));
const status = { state: 'ready', failedPluginNames: [] };
vi.mock('../core/PluginRegistry', () => ({
  pluginRegistry: {
    subscribe: () => () => {},
    getLoadStatus: () => status,
    getTrustedLayout: (
      _name: string,
      _contribution: unknown,
      binding: { skillExperience: PaneSkillExperienceHost },
    ) => {
      probe.host = binding.skillExperience;
      return () => <div>Bound rich frame</div>;
    },
  },
}));

import { RichExperiencePane } from '../components/skill-experiences/RichExperiencePane';
import { SkillExperiencePanel } from '../components/skill-experiences/SkillExperiencePanel';

const definition: SkillExperienceDefinitionV1 = JSON.parse(
  readFileSync(
    new NodeURL(
      '../../../examples/visual-skill-experience/io.kontourai.station/experiences/stress-test-idea.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
definition.presentation.richView = {
  version: '1.0',
  kind: 'workspace-pane',
  descriptorId: 'declared-panel',
};
const identity = {
  pluginId: 'example',
  pluginVersion: '1.0.0',
  experienceId: definition.id,
  incarnation: 'installed-1',
  materialization: 'materialization-1',
  contentDigest: 'digest-1',
  definitionDigest: 'definition-1',
};
const invocation = {
  eventId: 'invocation-1',
  threadId: 'thread-1',
  snapshot: {
    version: '1.0' as const,
    identity,
    definition,
    inputs: { idea: 'Original idea' },
    clientTurnId: 'turn-1',
    questionnaireDelivery: 'canonical-request' as const,
  },
  availability: { status: 'available' as const },
};
const view: SkillExperienceSessionViewV1 = {
  current: invocation,
  history: [],
  hasMore: false,
};
const session: ChatSession = {
  id: 'chat-1',
  conversationId: 'conversation-1',
  currentSessionId: 'thread-1',
  agentSlug: agentId('codex'),
  agentName: 'Codex',
  title: 'Rich skill',
  source: 'manual',
  input: 'Keep my draft',
  attachments: [],
  queuedMessages: [],
  inputHistory: [],
  hasUnread: false,
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  projectSlug: 'project-1',
};
const questionnaire: HarnessQuestionnaire = {
  questions: [
    {
      id: 'audience',
      header: 'Audience',
      prompt: 'Who is this for?',
      options: [{ id: 'team', label: 'Team', description: 'A team' }],
      multiple: false,
      allowCustom: false,
      secret: false,
    },
  ],
};
const question: RequestOpenedEvent = {
  method: 'request.opened',
  eventId: 'question-event-1',
  provider: 'codex',
  threadId: 'thread-1',
  createdAt: '2026-10-03T00:00:00Z',
  requestId: 'question-1',
  requestType: 'approval',
  title: 'Question round',
  payload: { questionnaire },
};
function eventWindow(
  events: RequestOpenedEvent[],
): OrchestrationSessionEventWindow {
  return {
    protocolVersion: 1,
    session: {
      provider: 'codex',
      threadId: 'thread-1',
      status: 'running',
      createdAt: question.createdAt,
      updatedAt: question.createdAt,
      controlMode: 'station-owned',
      answerability: { answerable: true },
      isLoaded: true,
      isPersisted: true,
      eventCount: events.length,
    },
    events: events.map((event, index) => ({ sequence: index + 1, event })),
    hasMore: false,
    watermark: events.length,
  };
}
function catalogEntry(): ResolvedWorkspacePaneCatalogEntry {
  const descriptorId = toWorkspacePaneDescriptorId('declared-panel');
  return {
    descriptor: {
      version: '1.0',
      id: descriptorId,
      name: 'Declared panel',
      rendererId: toWorkspacePaneRendererId('example:panel'),
      renderer: { kind: 'plugin-component', name: 'example-panel' },
      placement: { supportedRegions: ['primary'] },
      modes: [{ id: 'default' }],
      provenance: { origin: 'plugin', pluginId: 'example' },
      lifecycle: { stage: 'stable' },
    },
    instance: {
      version: '1.0',
      descriptorId,
      instanceId: toWorkspacePaneInstanceId('occurrence-1'),
      stateKey: toWorkspacePaneStateKey('state-1'),
      boundContext: {
        projectId: 'project-1',
        contribution: {
          id: 'plugin:example:panel',
          version: '1.0.0',
          sourceIdentity: {
            id: 'example',
            kind: 'local',
            source: 'plugins/example',
          },
          provenance: { origin: 'plugin', pluginId: 'example' },
        },
      },
    },
    availability: {
      state: 'available',
      reason: { code: 'ready', source: 'renderer' },
    },
    selectedRenderer: {
      source: 'primary',
      rendererId: toWorkspacePaneRendererId('example:panel'),
      renderer: { kind: 'plugin-component', name: 'example-panel' },
      contributorProvenance: { origin: 'plugin', pluginId: 'example' },
      requiredCapabilities: ['sandboxed-plugin-frame'],
    },
    clientRendererPresence: 'present',
  };
}
function host() {
  if (!probe.host)
    throw new Error('The fixture did not mount its bound rich host.');
  return probe.host;
}

beforeEach(() => {
  vi.clearAllMocks();
  probe.current = true;
  probe.host = undefined;
  probe.entries = [catalogEntry()];
  probe.sessionView = view;
  transport.read.mockResolvedValue(view);
  transport.inventory.mockResolvedValue({
    executionContract: '1.0',
    experiences: [{ definition, identity }],
    diagnostics: [],
  } satisfies SkillExperienceInventoryV1);
  transport.window.mockResolvedValue(eventWindow([question]));
  transport.answer.mockResolvedValue({ result: true, receipt: {} });
  activeChatsStore.initChat(session.id, {
    agentSlug: session.agentSlug,
    agentName: session.agentName,
    title: session.title,
    conversationId: session.conversationId,
    currentSessionId: session.currentSessionId,
    projectSlug: session.projectSlug,
  });
  activeChatsStore.updateChat(session.id, { input: session.input });
});
afterEach(() => {
  cleanup();
  activeChatsStore.removeChat(session.id);
});

describe('rich view bound to the canonical conversation', () => {
  test('reads only the immutable view and exact nonsensitive pending questionnaires', async () => {
    const secret = {
      ...question,
      eventId: 'secret-event',
      requestId: 'secret-request',
      payload: {
        questionnaire: {
          questions: [
            {
              ...questionnaire.questions[0],
              secret: true,
              allowCustom: true,
              options: [],
            },
          ],
        },
      },
    };
    const tool = {
      ...question,
      eventId: 'tool-event',
      requestId: 'tool-request',
      payload: {
        toolName: 'shell',
        toolInput: { command: 'private tool argument' },
        sessionGrant: 'grant-never-crosses',
      },
    };
    transport.window.mockResolvedValue(eventWindow([question, secret, tool]));
    render(
      <RichExperiencePane session={session} invocation={invocation} active />,
    );
    const result = JSON.parse((await host().read()).viewJson);
    expect(result.current).toEqual(invocation);
    expect(result.pendingQuestions).toEqual([
      {
        requestId: question.requestId,
        requestEventId: question.eventId,
        questionnaire,
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /grant-never-crosses|private tool argument|secret-request/,
    );
    expect(transport.read).toHaveBeenCalledWith(
      scope.apiBase,
      'thread-1',
      undefined,
      {
        requestScope: scope,
        expectedSkillExperience: { identity, eventId: invocation.eventId },
      },
    );
  });
  test('answers the exact canonical question with source and prompt-event preconditions', async () => {
    render(
      <RichExperiencePane session={session} invocation={invocation} active />,
    );
    await host().answer({
      requestId: 'question-1',
      requestEventId: 'question-event-1',
      answers: { audience: { optionIds: ['team'] } },
    });
    expect(transport.answer).toHaveBeenCalledExactlyOnceWith(
      scope.apiBase,
      {
        threadId: 'thread-1',
        requestId: 'question-1',
        expectedRequestEventId: 'question-event-1',
        expectedSkillExperience: { identity, eventId: invocation.eventId },
        decision: 'accept',
        answers: { audience: { optionIds: ['team'] } },
      },
      { requestScope: scope },
    );
    await expect(
      host().answer({
        requestId: 'question-1',
        requestEventId: 'stale-question-event',
        answers: { audience: { optionIds: ['team'] } },
      }),
    ).rejects.toThrow(/not a current question/);
    expect(transport.answer).toHaveBeenCalledTimes(1);
  });
  test('cannot accept tool approvals or secret questions through the rich answer capability', async () => {
    transport.window.mockResolvedValue(
      eventWindow([
        { ...question, payload: { toolName: 'shell' } },
        {
          ...question,
          eventId: 'secret-event',
          requestId: 'secret-request',
          payload: {
            questionnaire: {
              questions: [
                {
                  ...questionnaire.questions[0],
                  secret: true,
                  allowCustom: true,
                  options: [],
                },
              ],
            },
          },
        },
      ]),
    );
    render(
      <RichExperiencePane session={session} invocation={invocation} active />,
    );
    await expect(
      host().answer({
        requestId: 'question-1',
        requestEventId: 'question-event-1',
        answers: {},
      }),
    ).rejects.toThrow(/not a current question/);
    await expect(
      host().answer({
        requestId: 'secret-request',
        requestEventId: 'secret-event',
        answers: {
          audience: { optionIds: [], custom: 'sensitive fixture input' },
        },
      }),
    ).rejects.toThrow(/not a current question/);
    expect(transport.answer).not.toHaveBeenCalled();
  });
  test('stages continuation in the existing chat without discarding its text or invoking a provider', async () => {
    render(
      <RichExperiencePane session={session} invocation={invocation} active />,
    );
    await act(async () =>
      host().continue({
        experienceId: definition.id,
        inputs: { idea: 'Stage two' },
      }),
    );
    expect(activeChatsStore.getSnapshot()[session.id]).toMatchObject({
      input: 'Keep my draft',
      conversationId: 'conversation-1',
      skillExperienceDraft: {
        namespace: 'authority-1',
        apiBase: scope.apiBase,
        start: {
          identity,
          inputs: { idea: 'Stage two' },
          expectedPreviousInvocationEventId: 'invocation-1',
        },
      },
    });
    expect(transport.answer).not.toHaveBeenCalled();
    await expect(
      host().continue({
        experienceId: definition.id,
        inputs: { idea: 'Overwrite' },
      }),
    ).rejects.toThrow(/existing unsent/);
  });
  test('retires capabilities when hidden, unmounted or the current invocation is replaced', async () => {
    const mounted = render(
      <RichExperiencePane session={session} invocation={invocation} active />,
    );
    const capability = host();
    mounted.rerender(
      <RichExperiencePane
        session={session}
        invocation={invocation}
        active={false}
      />,
    );
    await expect(capability.read()).rejects.toThrow(/no longer active/);
    mounted.rerender(
      <RichExperiencePane session={session} invocation={invocation} active />,
    );
    transport.read.mockResolvedValue({
      ...view,
      current: { ...invocation, eventId: 'replacement' },
    });
    await expect(capability.read()).rejects.toThrow(
      /stage or its source changed/,
    );
    mounted.unmount();
    await expect(
      capability.continue({ experienceId: definition.id, inputs: {} }),
    ).rejects.toThrow(/no longer active/);
  });
  test('refuses a renderer contributed by another package', () => {
    probe.entries[0].descriptor.provenance.pluginId = 'unrelated-package';
    render(
      <RichExperiencePane session={session} invocation={invocation} active />,
    );
    expect(screen.getByRole('alert').textContent).toMatch(/unavailable/);
    expect(probe.host).toBeUndefined();
  });
});

describe('recorded visual skill availability', () => {
  test('makes an unavailable historical snapshot explicit', () => {
    probe.sessionView = {
      ...view,
      current: {
        ...invocation,
        snapshot: null,
        availability: {
          status: 'snapshot-unavailable',
          message: 'The immutable snapshot cannot be read.',
        },
      },
    };
    render(
      <SkillExperiencePanel
        session={{ ...session, skillExperienceActive: true }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'The immutable snapshot cannot be read.',
    );
    expect(
      screen.queryByRole('button', {
        name: 'Prepare another stage in this conversation',
      }),
    ).toBeNull();
  });
  test('keeps source-withdrawal visible in compact chat presentation', () => {
    probe.sessionView = {
      ...view,
      current: {
        ...invocation,
        availability: {
          status: 'source-unavailable',
          message: 'The installed source was withdrawn.',
        },
      },
    };
    render(
      <SkillExperiencePanel
        session={{
          ...session,
          skillExperienceActive: true,
          skillExperienceMode: 'chat',
        }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'The installed source was withdrawn.',
    );
  });
});
