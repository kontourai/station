/**
 * @vitest-environment jsdom
 */

import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useChatDockViewModel } from '../components/chat-dock/useChatDockViewModel';

const queryState = vi.hoisted(() => ({
  agentConnections: [] as any[],
  modelConnections: [] as any[],
  project: undefined as
    | { name?: string; workingDirectory?: string }
    | undefined,
  gitStatusArgs: [] as (string | null | undefined)[],
  modelCatalogFetchedAfterMount: false,
  modelCatalogError: undefined as Error | undefined,
  modelCatalogLoading: false,
  modelImageSupport: 'unknown' as 'yes' | 'no' | 'unknown',
}));

vi.mock('@kontourai/station-sdk', () => ({
  useModelPickerCatalogQuery: () => ({
    data: {
      agentConnections: queryState.agentConnections,
      modelConnections: queryState.modelConnections,
    },
    isFetchedAfterMount: queryState.modelCatalogFetchedAfterMount,
    error: queryState.modelCatalogError,
    isLoading: queryState.modelCatalogLoading,
  }),
  useProjectLayoutsQuery: () => ({ data: [] }),
}));
vi.mock('../contexts/ModelCapabilitiesContext', () => ({
  useModelImageSupport: () => queryState.modelImageSupport,
}));
vi.mock('../contexts/ProjectsContext', () => ({
  useProject: () => ({ project: queryState.project }),
}));
vi.mock('../hooks/useGitStatus', () => ({
  useGitStatus: (workingDirectory: string | null | undefined) => {
    queryState.gitStatusArgs.push(workingDirectory);
    return { data: undefined };
  },
}));

const agents = [{ slug: 'agent-1', model: 'model-a' }] as unknown as Parameters<
  typeof useChatDockViewModel
>[0]['agents'];

const sessions = [
  {
    id: 's1',
    agentSlug: 'agent-1',
    projectSlug: null,
    hasUnread: false,
    model: undefined,
  },
] as unknown as Parameters<typeof useChatDockViewModel>[0]['sessions'];

const availableModels = [{ id: 'model-a', name: 'Model A' }];

type Props = Parameters<typeof useChatDockViewModel>[0];

function renderVM(activeSessionId: string | null) {
  return renderHook((props: Props) => useChatDockViewModel(props), {
    initialProps: { activeSessionId, availableModels, agents, sessions },
  });
}

afterEach(() => {
  queryState.agentConnections = [];
  queryState.modelConnections = [];
  queryState.modelCatalogLoading = false;
  queryState.modelCatalogFetchedAfterMount = false;
  queryState.modelCatalogError = undefined;
});

describe('useChatDockViewModel (memoized bindingStatus/effectiveModels)', () => {
  test('marks hydrated catalog data until a live fetch succeeds after mount', () => {
    queryState.modelCatalogFetchedAfterMount = false;
    const { result, rerender } = renderVM('s1');
    expect(result.current.modelsStale).toBe(true);

    queryState.modelCatalogFetchedAfterMount = true;
    rerender({ activeSessionId: 's1', availableModels, agents, sessions });
    expect(result.current.modelsStale).toBe(false);
    queryState.modelCatalogFetchedAfterMount = false;
  });

  test('selects model-picker loading for Station and external runtime catalogs, but global for the exact fallback', () => {
    queryState.modelCatalogLoading = true;
    queryState.modelCatalogFetchedAfterMount = true;
    const station = {
      ...sessions[0],
      executionMode: 'station',
      providerId: 'model-connection',
    } as any;
    queryState.modelConnections = [
      {
        id: 'model-connection',
        kind: 'model',
        enabled: true,
        status: 'ready',
        config: {},
        runtimeCatalog: { models: [] },
      },
    ];
    const stationResult = renderHook(() =>
      useChatDockViewModel({
        activeSessionId: 's1',
        availableModels,
        globalModelsLoading: false,
        globalModelsLiveConfirmed: true,
        agents,
        sessions: [station],
      }),
    );
    expect(stationResult.result.current).toMatchObject({
      modelsLoading: true,
      modelsStale: false,
    });

    const runtime = {
      id: 'runtime',
      engineId: 'claude',
      config: {},
      capabilities: [],
      runtimeCatalog: { models: [] },
    };
    queryState.modelConnections = [];
    queryState.agentConnections = [runtime];
    const externalResult = renderHook(() =>
      useChatDockViewModel({
        activeSessionId: 's1',
        availableModels,
        globalModelsLoading: false,
        globalModelsLiveConfirmed: true,
        agents: [
          {
            ...agents[0],
            execution: { agentConnectionId: engineConnectionId('runtime') },
          },
        ],
        sessions: [
          {
            ...sessions[0],
            executionMode: 'external',
            agentConnectionId: 'runtime',
          } as any,
        ],
      }),
    );
    // The model-picker query is still the loading authority for an external
    // runtime catalog, even while the unrelated global list is settled.
    expect(externalResult.result.current.modelsLoading).toBe(true);

    queryState.agentConnections = [
      {
        ...runtime,
        engineId: 'station',
        config: { engineId: 'station' },
        runtimeCatalog: { models: [] },
      },
    ];
    const globalResult = renderHook(() =>
      useChatDockViewModel({
        activeSessionId: 's1',
        availableModels,
        globalModelsLoading: false,
        globalModelsLiveConfirmed: true,
        agents: [
          {
            ...agents[0],
            execution: { agentConnectionId: engineConnectionId('runtime') },
          },
        ],
        sessions: [
          {
            ...sessions[0],
            executionMode: 'external',
            agentConnectionId: 'runtime',
          } as any,
        ],
      }),
    );
    expect(globalResult.result.current).toMatchObject({
      modelsLoading: false,
      modelsStale: false,
    });
    queryState.modelCatalogLoading = false;
    queryState.modelCatalogFetchedAfterMount = false;
    queryState.modelConnections = [];
  });

  test('bindingStatus and effectiveModels keep referential identity across an unrelated re-render', () => {
    // `availableModels`/`agents`/`sessions` module-level arrays are passed by
    // the same reference on rerender — this is the case a parent re-render
    // that doesn't touch any of this hook's real inputs (e.g. a resize
    // drag's per-frame render) reproduces.
    const { result, rerender } = renderVM('s1');
    const firstBinding = result.current.bindingStatus;
    const firstModels = result.current.effectiveModels;

    rerender({ activeSessionId: 's1', availableModels, agents, sessions });

    expect(result.current.bindingStatus).toBe(firstBinding);
    expect(result.current.effectiveModels).toBe(firstModels);
  });

  test('bindingStatus and effectiveModels recompute when the active session actually changes', () => {
    const { result, rerender } = renderVM('s1');
    const firstBinding = result.current.bindingStatus;
    const firstModels = result.current.effectiveModels;

    rerender({ activeSessionId: null, availableModels, agents, sessions });

    expect(result.current.bindingStatus).not.toBe(firstBinding);
    expect(result.current.effectiveModels).not.toBe(firstModels);
  });

  test('does not promote image-only runtime support to document support', () => {
    queryState.agentConnections = [
      {
        id: 'codex',
        name: 'Codex',
        capabilities: ['agent-runtime', 'image-input'],
        config: { executionClass: 'external' },
      },
    ];
    const imageOnlySessions = [
      {
        ...sessions[0],
        agentConnectionId: 'codex',
      },
    ] as typeof sessions;
    const { result } = renderHook(
      (props: Props) => useChatDockViewModel(props),
      {
        initialProps: {
          activeSessionId: 's1',
          availableModels,
          agents,
          sessions: imageOnlySessions,
        },
      },
    );

    expect(result.current.modelSupportsAttachments).toBe(true);
    expect(result.current.fileAttachmentsSupported).toBe(false);
    queryState.agentConnections = [];
  });

  // archive#3344. The composer's image gate used to be
  // `selectedModelSupportsImages || runtimeConnection.capabilities.includes(
  // 'image-input') || agent.supportsAttachments`, and an ordinary Station
  // chat satisfies none of those: no AWS credentials means an empty Bedrock
  // model catalog, an unbound Station agent has no engine connection at all,
  // and nothing on the server ever wrote `supportsAttachments`. The engine
  // that relays images to /chat (archive#1885) was the one engine whose
  // pastes were refused.
  test('a Station-engine chat with no engine connection can attach images', () => {
    queryState.agentConnections = [];
    queryState.modelImageSupport = 'unknown';
    const { result } = renderVM('s1');

    expect(result.current.modelSupportsAttachments).toBe(true);
    expect(result.current.imageAttachmentRefusal).toBeUndefined();
  });

  // A live Station chat carries an `agentConnectionId` that names no loaded
  // engine connection — the shape the browser fixture reproduced. The
  // connection-record resolver answers `unknown` there, which is right for a
  // connected engine whose record is missing and wrong for Station, whose
  // engine the session names itself.
  test('a Station-engine chat whose agentConnectionId matches no loaded connection can still attach images', () => {
    queryState.agentConnections = [];
    queryState.modelImageSupport = 'unknown';
    const danglingSessions = [
      {
        ...sessions[0],
        executionMode: 'station',
        agentConnectionId: 'not-a-loaded-connection',
      },
    ] as typeof sessions;
    const { result } = renderHook(
      (props: Props) => useChatDockViewModel(props),
      {
        initialProps: {
          activeSessionId: 's1',
          availableModels,
          agents,
          sessions: danglingSessions,
        },
      },
    );

    expect(result.current.modelSupportsAttachments).toBe(true);
    expect(result.current.imageAttachmentRefusal).toBeUndefined();
  });

  test('an engine that declares no image path refuses the paste with its own reason', () => {
    queryState.agentConnections = [
      {
        id: 'muse',
        name: 'Muse Code',
        capabilities: ['agent-runtime'],
        config: { engineId: 'muse', executionClass: 'external' },
        type: 'muse',
      },
    ];
    const museSessions = [
      { ...sessions[0], agentConnectionId: 'muse' },
    ] as typeof sessions;
    const { result } = renderHook(
      (props: Props) => useChatDockViewModel(props),
      {
        initialProps: {
          activeSessionId: 's1',
          availableModels,
          agents,
          sessions: museSessions,
        },
      },
    );

    expect(result.current.modelSupportsAttachments).toBe(false);
    expect(result.current.imageAttachmentRefusal).toBe(
      'Muse Code runs a text-only prompt and cannot see images.',
    );
    queryState.agentConnections = [];
  });

  test('a model the catalog positively reports as image-blind outranks a capable engine', () => {
    queryState.agentConnections = [];
    queryState.modelImageSupport = 'no';
    const modelSessions = [
      { ...sessions[0], model: 'text-only-model' },
    ] as typeof sessions;
    const { result } = renderHook(
      (props: Props) => useChatDockViewModel(props),
      {
        initialProps: {
          activeSessionId: 's1',
          availableModels,
          agents,
          sessions: modelSessions,
        },
      },
    );

    expect(result.current.modelSupportsAttachments).toBe(false);
    expect(result.current.imageAttachmentRefusal).toContain('text-only-model');
    queryState.modelImageSupport = 'unknown';
  });

  test('exposes exact ready provider/model choices and explains an unavailable active provider', () => {
    queryState.modelConnections = [
      {
        id: 'codex-work',
        kind: 'model',
        type: 'codex',
        name: 'Codex · Work',
        enabled: false,
        status: 'disabled',
        capabilities: ['llm'],
        config: { modelOptions: [{ id: 'shared', name: 'Shared model' }] },
      },
      {
        id: 'bedrock-prod',
        kind: 'model',
        type: 'bedrock',
        name: 'Bedrock · Prod',
        enabled: true,
        status: 'ready',
        capabilities: ['llm'],
        config: { modelOptions: [{ id: 'shared', name: 'Shared model' }] },
      },
    ];
    const stationSessions = [
      {
        ...sessions[0],
        executionMode: 'station',
        providerId: 'codex-work',
        provider: 'codex',
        model: 'shared',
      },
    ] as typeof sessions;

    const { result } = renderHook(
      (props: Props) => useChatDockViewModel(props),
      {
        initialProps: {
          activeSessionId: 's1',
          availableModels,
          agents,
          sessions: stationSessions,
        },
      },
    );

    expect(result.current.modelProviders).toEqual([
      expect.objectContaining({
        id: 'codex-work',
        available: false,
        detail: 'Disabled',
      }),
      expect.objectContaining({ id: 'bedrock-prod', available: true }),
    ]);
    expect(result.current.effectiveModels).toEqual([
      expect.objectContaining({
        id: 'shared',
        providerId: 'codex-work',
        available: false,
        unavailableReason: 'Disabled',
      }),
      expect.objectContaining({
        id: 'shared',
        providerId: 'bedrock-prod',
        providerType: 'bedrock',
      }),
    ]);
    queryState.modelConnections = [];
  });
});

/**
 * archive#1146. The dock's directory label used to be
 * `sessionProject?.workingDirectory ?? null` — the project's directory, read
 * AFTER the session had already started. For a chat on an engine connection
 * carrying its own Working Directory inside a project with none, that printed
 * "~ (defaults to home)" while the engine ran in the connection's directory.
 */
describe('useChatDockViewModel — station#1146 session directory', () => {
  const chatSession = {
    id: 'acp-elsewhere:1',
    conversationId: 'acp-elsewhere:1',
    agentSlug: 'agent-1',
    projectSlug: 'default',
    hasUnread: false,
  } as unknown as Props['sessions'][number];

  function render(
    overrides: Partial<Props> & {
      project?: { name?: string; workingDirectory?: string };
    } = {},
  ) {
    const { project, ...props } = overrides;
    queryState.project = project;
    queryState.gitStatusArgs = [];
    return renderHook((p: Props) => useChatDockViewModel(p), {
      initialProps: {
        activeSessionId: chatSession.id,
        availableModels,
        agents,
        sessions: [chatSession],
        ...props,
      } as Props,
    });
  }

  afterEach(() => {
    queryState.project = undefined;
    queryState.gitStatusArgs = [];
  });

  test("reports the session's own cwd, not the directoryless project's '~', for a chat running elsewhere", () => {
    const { result } = render({
      orchestrationSessions: [
        { threadId: chatSession.id, cwd: '/tmp/s1146-elsewhere' },
      ] as any,
    });

    expect(result.current.sessionDisplayCwd).toBe('/tmp/s1146-elsewhere');
  });

  test("prefers the session's cwd over a project directory that disagrees with it", () => {
    const { result } = render({
      project: { workingDirectory: '~/dev/project-root' },
      orchestrationSessions: [
        { threadId: chatSession.id, cwd: '/Users/someone/dev/worktrees/wt-9' },
      ] as any,
    });

    expect(result.current.sessionDisplayCwd).toBe(
      '/Users/someone/dev/worktrees/wt-9',
    );
  });

  test('correlates on the conversation id, and ignores a session that does not correlate', () => {
    const { result } = render({
      orchestrationSessions: [
        { threadId: 'some-other-thread', cwd: '/tmp/not-this-one' },
      ] as any,
    });

    expect(result.current.sessionDisplayCwd).toBe(null);
  });

  test('falls back to the store key when the chat has no conversation id yet', () => {
    const withoutConversationId = {
      ...chatSession,
      conversationId: undefined,
    } as typeof chatSession;

    const { result } = render({
      sessions: [withoutConversationId],
      orchestrationSessions: [
        { threadId: withoutConversationId.id, cwd: '/tmp/s1146-elsewhere' },
      ] as any,
    });

    expect(result.current.sessionDisplayCwd).toBe('/tmp/s1146-elsewhere');
  });

  test("falls back to the project's directory when no session has started yet", () => {
    const { result } = render({
      project: { workingDirectory: '~/dev/project-root' },
      orchestrationSessions: [] as any,
    });

    expect(result.current.sessionDisplayCwd).toBe('~/dev/project-root');
  });

  test('falls back to null (the "~ (defaults to home)" branch) with neither a session cwd nor a project directory', () => {
    const { result } = render({ orchestrationSessions: [] as any });

    expect(result.current.sessionDisplayCwd).toBe(null);
  });

  test('treats a present-but-empty session cwd as absent rather than blanking the label', () => {
    const { result } = render({
      project: { workingDirectory: '~/dev/project-root' },
      orchestrationSessions: [{ threadId: chatSession.id, cwd: '   ' }] as any,
    });

    expect(result.current.sessionDisplayCwd).toBe('~/dev/project-root');
  });

  /**
   * archive#3213: the same correlation now also carries the session's
   * lifecycle to `ChatDockBody`'s failure banner. Without this the dock has no
   * record to fold and renders nothing on a cold arrival at a failed session —
   * the reported defect.
   */
  test('exposes the correlated server session record, not just its cwd', () => {
    const failed = {
      threadId: chatSession.id,
      cwd: '/tmp/s1146-elsewhere',
      lifecycleState: 'failed',
      blockedReason: 'ECONNREFUSED api.example.com:443',
    };

    const { result } = render({ orchestrationSessions: [failed] as any });

    expect(result.current.activeOrchestrationSession).toBe(failed);
  });

  test('prefers the current lineage Session over the durable Conversation id', () => {
    const current = {
      threadId: 'session-current',
      cwd: '/tmp/current-session',
      lifecycleState: 'running',
    };
    const { result } = render({
      sessions: [
        {
          ...chatSession,
          conversationId: 'conversation-root',
          currentSessionId: 'session-current',
        },
      ],
      orchestrationSessions: [
        { threadId: 'conversation-root', cwd: '/tmp/stale-root' },
        current,
      ] as any,
    });

    expect(result.current.activeOrchestrationSession).toBe(current);
    expect(result.current.sessionDisplayCwd).toBe('/tmp/current-session');
  });

  test('a session that does not correlate is reported as no record, never the wrong one', () => {
    const { result } = render({
      orchestrationSessions: [
        { threadId: 'some-other-thread', lifecycleState: 'failed' },
      ] as any,
    });

    expect(result.current.activeOrchestrationSession).toBeNull();
  });

  // `orchestrationSessions` is `[]` while the query is pending
  // and while it has failed, so "not in this array" answered a different
  // question from "the serving Station has no such session". The dock read
  // the first as the second and claimed "Session record missing" on every
  // reload of a healthy session.
  test.each([
    ['pending', 'pending'],
    ['error', 'error'],
    ['success', 'absent'],
  ])(
    'reads a not-found session under query status %s as %s',
    (status, expected) => {
      const { result } = render({
        orchestrationSessions: [] as any,
        orchestrationSessionsStatus: status as never,
      });

      expect(result.current.activeOrchestrationSession).toBeNull();
      expect(result.current.activeOrchestrationSessionRead).toBe(expected);
    },
  );

  test('a found session reads present regardless of the query status field', () => {
    const { result } = render({
      orchestrationSessions: [{ threadId: chatSession.id }] as any,
      orchestrationSessionsStatus: 'pending' as never,
    });

    expect(result.current.activeOrchestrationSessionRead).toBe('present');
  });

  test("git stays bound to the PROJECT's directory even when the session runs elsewhere", () => {
    render({
      project: { workingDirectory: '~/dev/project-root' },
      orchestrationSessions: [
        { threadId: chatSession.id, cwd: '/tmp/s1146-elsewhere' },
      ] as any,
    });

    expect(queryState.gitStatusArgs).not.toHaveLength(0);
    expect(new Set(queryState.gitStatusArgs)).toEqual(
      new Set(['~/dev/project-root']),
    );
  });
});
