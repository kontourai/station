import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { environmentId } from '@kontourai/station-contracts/execution-target';
import type { WorktreeSessionMetadata } from '@kontourai/station-contracts/workspace-isolation';
import { describe, expect, test, vi } from 'vitest';
import { execGitSync } from '../../../utils/git-exec.js';
import { WorktreeProvisioningService } from '../../projects/worktree-provisioning-service.js';
import {
  canonicalHandoffEffectDigest,
  createConversationHandoffIntent,
  type ExecutionTargetExecutionDependencies,
  executeForegroundMessage,
  ForegroundMessageIndeterminateError,
  ForegroundMessageTurnIdentityUnavailableError,
} from '../execution-target-execution.js';

function createRepo() {
  const path = mkdtempSync(join(tmpdir(), 'station-execution-worktree-'));
  execGitSync(['init'], { cwd: path, stdio: 'pipe' });
  execGitSync(['config', 'user.email', 'test@example.com'], {
    cwd: path,
    stdio: 'pipe',
  });
  execGitSync(['config', 'user.name', 'Station Test'], {
    cwd: path,
    stdio: 'pipe',
  });
  writeFileSync(join(path, 'README.md'), '# test\n');
  execGitSync(['add', 'README.md'], { cwd: path, stdio: 'pipe' });
  execGitSync(['commit', '-m', 'initial'], { cwd: path, stdio: 'pipe' });
  return path;
}

function dependencies(): ExecutionTargetExecutionDependencies {
  return {
    resolveEnvironmentAccess: async () => ({
      apiBase: 'http://127.0.0.1:43141',
      environmentId: 'environment-kontour',
      environmentName: 'Kontour',
      kind: 'current',
      requestOptions: { headers: { Authorization: 'Bearer private' } },
    }),
    getAgent: async () => ({ slug: 'station', available: true }),
    getConnection: vi.fn(),
    getProject: vi.fn(),
    getProviderAdapter: vi.fn(
      () =>
        ({
          provider: 'station-agent',
          metadata: {
            modelLaunch: {
              defaultAtStart: 'engine-selected',
              omissionAtResume: 'engine-selected',
              omissionPerTurn: 'engine-selected',
              overrideAtStart: true,
              overrideAtResume: true,
              overridePerTurn: true,
            },
          },
        }) as any,
    ),
    readSessionBinding: vi.fn(async () => null),
    startSession: vi.fn(async () => undefined),
    sendTurn: vi.fn(async () => ({ turnId: 'provider-turn-1' })),
    createConversationId: () => 'conversation:test',
  };
}

describe('executeForegroundMessage', () => {
  test('handoff retry after an accepted boundary start sends once without starting another successor', async () => {
    const deps = dependencies();
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'station',
    }));
    deps.prepareConversationHandoff = vi.fn(async () => ({
      outcome: 'existing' as const,
      marker: {
        predecessorSessionId: 'conversation:test',
        sessionId: 'conversation:test:handoff-child',
        targetAgentId: 'station',
        targetEnvironmentId: 'environment-kontour',
      },
      carried: [],
      reset: [],
      transcriptSeed: 'authorized transcript seed',
      contextBoundary: {
        boundaryId: 'handoff-boundary',
        conversationId: 'conversation:test',
        predecessorSessionId: 'conversation:test',
        successorSessionId: 'conversation:test:handoff-child',
        policy: 'continue-from-history' as const,
        status: 'consumed' as const,
        actorId: 'user-a',
        createdAt: '2026-08-25T00:00:00.000Z',
        priorTranscriptInjected: true,
        omitted: [],
        preserved: [],
        retryable: false,
      },
    }));
    deps.readConversationHandoffEffect = vi.fn(async () => null);

    await expect(
      executeForegroundMessage(
        {
          target: {
            environment: { kind: 'current' },
            agent: agentId('station'),
          },
          conversationId: 'conversation:test',
          message: 'continue exactly once',
          handoffIntent: createConversationHandoffIntent('handoff-key'),
        },
        deps,
      ),
    ).resolves.toMatchObject({
      sessionId: 'conversation:test:handoff-child',
      providerTurnId: 'provider-turn-1',
      handoff: { outcome: 'existing' },
    });
    expect(deps.startSession).not.toHaveBeenCalled();
    expect(deps.sendTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        threadId: 'conversation:test:handoff-child',
        ambientContext: 'authorized transcript seed',
      }),
      undefined,
    );
  });

  test('consumes an empty boundary from its accepted cold-start receipt before the separate turn', async () => {
    const deps = dependencies();
    const order: string[] = [];
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'station',
    }));
    deps.resolveConversationSession = vi.fn(async () => ({
      sessionId: 'conversation:test:empty-child',
      startRequired: true,
      contextBoundary: {
        boundaryId: 'boundary-empty',
        conversationId: 'conversation:test',
        predecessorSessionId: 'conversation:test',
        successorSessionId: 'conversation:test:empty-child',
        policy: 'empty-next-cold-start' as const,
        status: 'reserved' as const,
        actorId: 'user-a',
        createdAt: '2026-08-25T00:00:00.000Z',
        priorTranscriptInjected: false,
        omitted: [],
        preserved: [],
        retryable: true,
      },
    }));
    deps.claimConversationContextBoundaryColdStart = vi.fn(
      (_access, _boundaryId, commandId) => order.push(`claim:${commandId}`),
    );
    deps.startSession = vi.fn(async (_access, input) => {
      const contextBoundary = input.metadata?.contextBoundary;
      if (
        !contextBoundary ||
        typeof contextBoundary !== 'object' ||
        typeof (contextBoundary as { startCommandId?: unknown })
          .startCommandId !== 'string'
      ) {
        throw new Error('missing test start command');
      }
      const commandId = (contextBoundary as { startCommandId: string })
        .startCommandId;
      order.push(`start:${commandId}`);
      return { commandId, sessionId: input.threadId };
    });
    deps.consumeConversationContextBoundary = vi.fn(
      (_access, _boundaryId, commandId) => order.push(`consume:${commandId}`),
    );
    deps.sendTurn = vi.fn(async () => {
      order.push('turn');
      throw new Error('turn rejected after start');
    });

    await expect(
      executeForegroundMessage(
        {
          target: {
            environment: { kind: 'current' },
            agent: agentId('station'),
          },
          conversationId: 'conversation:test',
          message: 'new empty context',
        },
        deps,
      ),
    ).rejects.toThrow('turn rejected after start');

    expect(order).toHaveLength(4);
    expect(order[0]?.replace('claim:', '')).toBe(
      order[1]?.replace('start:', ''),
    );
    expect(order[1]?.replace('start:', '')).toBe(
      order[2]?.replace('consume:', ''),
    );
    expect(order[3]).toBe('turn');
  });

  test('fences a claimed boundary when accepted-start settlement is indeterminate', async () => {
    const deps = dependencies();
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'station',
    }));
    deps.resolveConversationSession = vi.fn(async () => ({
      sessionId: 'conversation:test:fenced-child',
      startRequired: true,
      contextBoundary: {
        boundaryId: 'boundary-fenced',
        conversationId: 'conversation:test',
        predecessorSessionId: 'conversation:test',
        successorSessionId: 'conversation:test:fenced-child',
        policy: 'empty-next-cold-start' as const,
        status: 'reserved' as const,
        actorId: 'user-a',
        createdAt: '2026-08-25T00:00:00.000Z',
        priorTranscriptInjected: false,
        omitted: [],
        preserved: [],
        retryable: true,
      },
    }));
    deps.startSession = vi.fn(async (_access, input) => {
      const contextBoundary = input.metadata?.contextBoundary;
      if (
        !contextBoundary ||
        typeof contextBoundary !== 'object' ||
        typeof (contextBoundary as { startCommandId?: unknown })
          .startCommandId !== 'string'
      ) {
        throw new Error('missing test start command');
      }
      return {
        commandId: (contextBoundary as { startCommandId: string })
          .startCommandId,
        sessionId: input.threadId,
      };
    });
    deps.consumeConversationContextBoundary = vi.fn(() => {
      throw new Error('store write result unavailable');
    });
    const release = vi.fn();
    deps.releaseConversationContextBoundaryFailedClaim = release;

    await expect(
      executeForegroundMessage(
        {
          target: {
            environment: { kind: 'current' },
            agent: agentId('station'),
          },
          conversationId: 'conversation:test',
          message: 'do not release a possible consume',
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ForegroundMessageIndeterminateError);
    expect(release).toHaveBeenCalledWith(
      expect.anything(),
      'boundary-fenced',
      true,
    );
    expect(deps.sendTurn).not.toHaveBeenCalled();
  });

  test.each(['explicit saved', 'project-default saved'])(
    '%s target refuses staged bytes before hydrate or send',
    async () => {
      const deps = dependencies();
      deps.resolveEnvironmentAccess = vi.fn(async () => ({
        apiBase: 'http://remote.example.test',
        environmentId: 'environment-remote',
        environmentName: 'Remote',
        kind: 'peer' as const,
      }));
      const resolveAttachments = vi.fn(() => []);

      await expect(
        executeForegroundMessage(
          {
            // The route normalizes both an explicit selection and a project's
            // saved default to this same resolved saved Environment shape.
            target: {
              environment: {
                kind: 'saved',
                id: environmentId('environment-remote'),
              },
              agent: agentId('station'),
            },
            message: 'never cross hosts',
            resolveAttachments,
          },
          deps,
        ),
      ).rejects.toThrow('cannot be sent to another Station');
      expect(resolveAttachments).not.toHaveBeenCalled();
      expect(deps.sendTurn).not.toHaveBeenCalled();
    },
  );

  test('hydrates staged bytes only after continuation resolves its actual child session', async () => {
    const deps = dependencies();
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'station',
    }));
    deps.resolveConversationSession = vi.fn(async () => ({
      sessionId: 'conversation:test:child-2',
      startRequired: false,
    }));
    const resolveAttachments = vi.fn(() => []);

    await executeForegroundMessage(
      {
        target: {
          environment: { kind: 'current' },
          agent: agentId('station'),
        },
        conversationId: 'conversation:test',
        clientTurnId: 'client-turn-9',
        message: 'inspect this',
        resolveAttachments,
      },
      deps,
    );

    expect(resolveAttachments).toHaveBeenCalledWith({
      threadId: 'conversation:test:child-2',
      clientTurnId: 'client-turn-9',
    });
    expect(deps.sendTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ threadId: 'conversation:test:child-2' }),
      undefined,
    );
  });

  test('canonicalizes resolved handoff options while binding every value', () => {
    const first = canonicalHandoffEffectDigest({
      modelOptions: {
        effort: 'high',
        nested: { sandbox: 'workspace', fast: true },
      },
    });
    const reordered = canonicalHandoffEffectDigest({
      modelOptions: {
        nested: { fast: true, sandbox: 'workspace' },
        effort: 'high',
      },
    });
    const changed = canonicalHandoffEffectDigest({
      modelOptions: {
        effort: 'low',
        nested: { sandbox: 'workspace', fast: true },
      },
    });
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });
  test('retries an accepted handoff with one stable provider-turn claim', async () => {
    const deps = dependencies();
    deps.getAgent = vi.fn(async (_access, id) => ({
      slug: id,
      available: true,
    }));
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'agent-a',
    }));
    deps.prepareConversationHandoff = vi.fn(async (_access, _input) => ({
      marker: {
        predecessorSessionId: 'conversation:test',
        sessionId: 'conversation:test:session:b',
        targetAgentId: 'agent-b',
        targetEnvironmentId: 'environment-kontour',
      },
      transcriptSeed: 'prior transcript',
      outcome: 'created' as const,
      carried: ['authorizedTranscript'],
      reset: ['providerNativeCursor'],
    }));
    const effects = new Map<string, string>();
    deps.sendTurn = vi.fn(async (_access, input) => {
      const key = input.clientTurnId!;
      if (!effects.has(key)) effects.set(key, 'provider-turn-b');
      return { turnId: effects.get(key)! };
    });
    const request = {
      target: {
        environment: { kind: 'current' as const },
        agent: agentId('agent-b'),
      },
      conversationId: 'conversation:test',
      message: 'Continue with B',
      handoffIntent: createConversationHandoffIntent('handoff-1'),
    };
    const first = await executeForegroundMessage(request, deps);
    const replay = await executeForegroundMessage(request, deps);
    expect(replay.providerTurnId).toBe(first.providerTurnId);
    expect(effects).toHaveLength(1);
    expect(vi.mocked(deps.sendTurn).mock.calls[0]![1].clientTurnId).toBe(
      vi.mocked(deps.sendTurn).mock.calls[1]![1].clientTurnId,
    );
    expect(deps.prepareConversationHandoff).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageDigest: expect.any(String) }),
    );
  });
  test('treats a local provider response without terminal identity as indeterminate', async () => {
    const deps = dependencies();
    deps.sendTurn = vi.fn(async () => ({ turnId: '' }));

    await expect(
      executeForegroundMessage(
        {
          target: {
            environment: { kind: 'current' },
            agent: agentId('station'),
            workspace: { kind: 'directory', cwd: '/repo' },
          },
          message: 'Do not accept without terminal evidence',
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ForegroundMessageTurnIdentityUnavailableError);
  });

  test('dispatches through the resolved Environment and returns only public Agent identity', async () => {
    const deps = dependencies();
    const clientOrigin = {
      version: 1 as const,
      actor: { kind: 'device' as const, deviceId: 'device-terra' },
      reported: {
        version: 1 as const,
        surface: 'web' as const,
        build: '2026.8.23',
      },
    };
    const result = await executeForegroundMessage(
      {
        target: {
          environment: { kind: 'current' },
          agent: agentId('station'),
        },
        message: 'Inspect the checkout',
        ambientContext: '[Timezone: America/Denver]',
        attachments: [
          {
            kind: 'image',
            name: 'screen.png',
            mimeType: 'image/png',
            size: 3,
            dataUrl: 'data:image/png;base64,YWJj',
          },
        ],
        clientTurnId: 'client-turn-1',
        clientOrigin,
      },
      deps,
    );

    expect(deps.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'environment-kontour' }),
      expect.objectContaining({
        threadId: 'conversation:test',
        provider: 'station-agent',
        // #765 A1: a durable conversation's Session keeps its native engine
        // transcript, so continuation children can genuinely `--resume` it.
        // Only `ephemeral` turns opt out (asserted separately below).
        persistSession: true,
        metadata: expect.objectContaining({
          agentId: 'station',
          agentSlug: 'station',
          targetKind: 'agent',
          targetId: 'station',
          environmentId: 'environment-kontour',
        }),
      }),
    );
    expect(deps.sendTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        threadId: 'conversation:test',
        input: 'Inspect the checkout',
        ambientContext: '[Timezone: America/Denver]',
        attachments: [expect.objectContaining({ name: 'screen.png' })],
        clientTurnId: 'client-turn-1',
      }),
      { clientOrigin },
    );
    expect(result).toMatchObject({
      conversationId: 'conversation:test',
      sessionId: 'conversation:test',
      providerTurnId: 'provider-turn-1',
      target: { kind: 'agent', id: 'station' },
      resolution: {
        environmentId: 'environment-kontour',
        agentId: 'station',
      },
    });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('apiBase');
  });

  // #765 A1: the deliberate opt-OUT half of the persistence contract — a
  // machine-triggered ephemeral turn must still start its session with
  // `persistSession: false`, never inherit the durable-conversation default.
  test('an ephemeral turn keeps its no-transcript posture (persistSession: false)', async () => {
    const deps = dependencies();
    await executeForegroundMessage(
      {
        target: {
          environment: { kind: 'current' },
          agent: agentId('station'),
        },
        message: 'machine-triggered probe',
        ephemeral: true,
      },
      deps,
    );
    expect(deps.startSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ persistSession: false }),
    );
  });

  test('continues an existing conversation without starting a second session', async () => {
    const deps = dependencies();
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'station',
    }));

    await executeForegroundMessage(
      {
        target: {
          environment: { kind: 'current' },
          agent: agentId('station'),
        },
        message: 'Continue',
        conversationId: 'conversation:existing',
      },
      deps,
    );

    expect(deps.startSession).not.toHaveBeenCalled();
    expect(deps.sendTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ threadId: 'conversation:existing' }),
      undefined,
    );
  });

  test.each([
    {
      name: 'Agent',
      binding: { environmentId: 'environment-kontour', agentId: 'other-agent' },
      input: {},
      error: 'different Environment, Agent, or Station user',
    },
    {
      name: 'Environment',
      binding: { environmentId: 'another-environment', agentId: 'station' },
      input: {},
      error: 'different Environment, Agent, or Station user',
    },
    {
      name: 'user',
      binding: {
        environmentId: 'environment-kontour',
        agentId: 'station',
        userId: 'owner-a',
      },
      input: { userId: 'owner-b' },
      error: 'different Environment, Agent, or Station user',
    },
    {
      name: 'workspace',
      binding: {
        environmentId: 'environment-kontour',
        agentId: 'station',
        cwd: '/durable/workspace',
      },
      input: {},
      error: 'different workspace directory',
    },
  ])(
    'refuses a mismatched $name before reserving a child Session',
    async ({ binding, input, error }) => {
      const deps = dependencies();
      const resolveConversationSession = vi.fn(async () => ({
        sessionId: 'conversation:existing:session:1',
        startRequired: true,
      }));
      deps.readSessionBinding = vi.fn(async () => binding);
      deps.resolveConversationSession = resolveConversationSession;

      await expect(
        executeForegroundMessage(
          {
            target: {
              environment: { kind: 'current' },
              agent: agentId('station'),
              ...(binding.cwd
                ? {
                    workspace: {
                      kind: 'directory' as const,
                      cwd: '/other/workspace',
                    },
                  }
                : {}),
            },
            message: 'Must not mutate lineage',
            conversationId: 'conversation:existing',
            ...input,
          },
          deps,
        ),
      ).rejects.toThrow(error);
      expect(resolveConversationSession).not.toHaveBeenCalled();
      expect(deps.startSession).not.toHaveBeenCalled();
      expect(deps.sendTurn).not.toHaveBeenCalled();
    },
  );

  test('starts a reserved child from the durable directory binding, never the current route', async () => {
    const deps = dependencies();
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'station',
      cwd: '/durable/original-workspace',
    }));
    deps.resolveConversationSession = vi.fn(async () => ({
      sessionId: 'conversation:existing:session:1',
      startRequired: true,
    }));

    const result = await executeForegroundMessage(
      {
        target: {
          environment: { kind: 'current' },
          agent: agentId('station'),
          // The resumed route deliberately supplies no workspace. The child
          // must still use the persisted directory rather than defaulting an
          // engine process to its current/home directory.
        },
        message: 'Second question',
        conversationId: 'conversation:existing',
      },
      deps,
    );

    expect(deps.startSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        threadId: 'conversation:existing:session:1',
        cwd: '/durable/original-workspace',
        metadata: expect.objectContaining({
          conversationId: 'conversation:existing',
        }),
      }),
    );
    expect(deps.sendTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        threadId: 'conversation:existing:session:1',
      }),
      undefined,
    );
    expect(result).toMatchObject({
      conversationId: 'conversation:existing',
      sessionId: 'conversation:existing:session:1',
    });
  });

  test('uses a server-owned predecessor cursor for same-engine continuation', async () => {
    const deps = dependencies();
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'station',
    }));
    deps.resolveConversationSession = vi.fn(async () => ({
      sessionId: 'conversation:cursor:session:1',
      startRequired: true,
      resumeCursor: { nativeSession: 'carry-turn-one' },
    }));

    await executeForegroundMessage(
      {
        target: { environment: { kind: 'current' }, agent: agentId('station') },
        message: 'What was the token?',
        conversationId: 'conversation:cursor',
      },
      deps,
    );

    expect(deps.startSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        threadId: 'conversation:cursor:session:1',
        resumeCursor: { nativeSession: 'carry-turn-one' },
      }),
    );
    expect(vi.mocked(deps.sendTurn).mock.calls[0]?.[1]).not.toHaveProperty(
      'ambientContext',
    );
  });

  test('seeds the next child turn deterministically when no native cursor exists', async () => {
    const deps = dependencies();
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'station',
    }));
    deps.resolveConversationSession = vi.fn(async () => ({
      sessionId: 'conversation:seed:session:1',
      startRequired: true,
      transcriptSeed:
        'Prior conversation transcript (context only): the answer token is amber-42.',
    }));

    await executeForegroundMessage(
      {
        target: { environment: { kind: 'current' }, agent: agentId('station') },
        message: 'Repeat the token from the first answer.',
        conversationId: 'conversation:seed',
      },
      deps,
    );

    expect(deps.sendTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        threadId: 'conversation:seed:session:1',
        ambientContext: expect.stringContaining('amber-42'),
      }),
      undefined,
    );
  });

  test('reuses the exact conversation worktree for a child without provisioning or taking cleanup ownership', async () => {
    const repoPath = createRepo();
    const deps = dependencies();
    const worktree: WorktreeSessionMetadata = {
      mode: 'worktree',
      path: repoPath,
      branch: 'station/session/conversation-existing',
      repoPath,
      baseRef: 'HEAD',
      cleanupPolicy: 'preserve',
      preserveOnFailure: true,
      createdAt: '2026-08-24T00:00:00.000Z',
    };
    deps.getProject = vi.fn(async () => ({
      workingDirectory: repoPath,
      defaultWorkspaceIsolation: 'worktree' as const,
    }));
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'station',
      projectSlug: 'original-project',
      cwd: worktree.path,
      workspaceIsolation: { mode: 'worktree' as const },
      worktree,
    }));
    deps.resolveConversationSession = vi.fn(async () => ({
      sessionId: 'conversation:existing:session:1',
      startRequired: true,
    }));
    deps.provisionWorktree = vi.fn(async () => {
      throw new Error('must not provision a second worktree');
    });

    try {
      await executeForegroundMessage(
        {
          target: {
            environment: { kind: 'current' },
            agent: agentId('station'),
            workspace: {
              kind: 'project',
              projectSlug: 'original-project',
              workspaceIsolation: { mode: 'worktree' },
            },
          },
          message: 'Continue in the owned checkout',
          conversationId: 'conversation:existing',
        },
        deps,
      );

      expect(deps.provisionWorktree).not.toHaveBeenCalled();
      expect(deps.startSession).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          cwd: worktree.path,
          workspaceIsolation: { mode: 'worktree' },
          metadata: expect.objectContaining({
            conversationId: 'conversation:existing',
            projectSlug: 'original-project',
            worktree,
          }),
        }),
      );
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('refuses a conversation bound to an unavailable engine-default alias with the catalog reason (#3027)', async () => {
    // archive#3027 clean break: the symmetric authored-spec gate marks every
    // spec-less engine default `available: false`, and an EXISTING
    // alias-bound conversation refuses on its next turn with the same
    // user-visible reason — a deliberate refusal carrying the enable remedy,
    // never a crash further down the send path.
    const reason =
      "Agent 'codex' has no authored Agent definition, so Station cannot start new sessions or continue existing conversations with it. Enable this engine by creating an Agent for it — new chats will run as that Agent; existing conversations stay readable.";
    const deps = dependencies();
    deps.getAgent = async () => ({
      slug: 'codex',
      available: false,
      unavailableReason: reason,
    });
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'codex',
    }));

    await expect(
      executeForegroundMessage(
        {
          target: {
            environment: { kind: 'current' },
            agent: agentId('codex'),
          },
          message: 'Continue this legacy alias thread',
          conversationId: 'conversation:legacy-codex',
        },
        deps,
      ),
    ).rejects.toThrow(reason);

    // The refusal happens at target resolution: nothing starts, nothing is
    // sent, and no other refusal path is disturbed.
    expect(deps.startSession).not.toHaveBeenCalled();
    expect(deps.sendTurn).not.toHaveBeenCalled();
  });

  test('forwards the resolved project workspace isolation when starting a thread', async () => {
    const repoPath = createRepo();
    const deps = dependencies();
    deps.getProject = vi.fn(async () => ({
      workingDirectory: repoPath,
      defaultWorkspaceIsolation: 'worktree' as const,
    }));

    try {
      await executeForegroundMessage(
        {
          target: {
            environment: { kind: 'current' },
            agent: agentId('station'),
            workspace: {
              kind: 'project',
              projectSlug: 'station',
              workspaceIsolation: { mode: 'worktree' },
            },
          },
          message: 'Start isolated work',
        },
        deps,
      );

      const startInput = vi.mocked(deps.startSession).mock.calls[0]?.[1];
      expect(startInput?.cwd).not.toBe(repoPath);
      expect(startInput?.cwd && existsSync(startInput.cwd)).toBe(true);
      expect(startInput).toEqual(
        expect.objectContaining({ workspaceIsolation: { mode: 'worktree' } }),
      );
      const worktree = startInput?.metadata?.worktree as
        | WorktreeSessionMetadata
        | undefined;
      expect(worktree).toEqual(
        expect.objectContaining({
          path: startInput?.cwd,
          repoPath: realpathSync(repoPath),
        }),
      );
      await new WorktreeProvisioningService().cleanup({
        metadata: worktree!,
        terminalState: 'completed',
      });
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('keeps a shared project session in its checkout', async () => {
    const deps = dependencies();
    deps.getProject = vi.fn(async () => ({
      workingDirectory: '/srv/station',
      defaultWorkspaceIsolation: 'shared' as const,
    }));

    await executeForegroundMessage(
      {
        target: {
          environment: { kind: 'current' },
          agent: agentId('station'),
          workspace: { kind: 'project', projectSlug: 'station' },
        },
        message: 'Start shared work',
      },
      deps,
    );

    expect(deps.startSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cwd: '/srv/station' }),
    );
  });

  test('continues a tilde-configured project conversation on a second turn', async () => {
    // THE archive#3147 regression, and the shape nothing covered. Projects
    // store their working directory tilde-literal — `~/.station/projects/
    // <slug>/project.json` holds `~/dev/...` verbatim — while the session cwd
    // persisted at turn 1 is the EXPANDED form. The resolver was the one
    // consumer in the tree that did not expand, so this guard compared
    // '/home/me/dev/x' against '~/dev/x' and refused every follow-up turn
    // with "this conversation belongs to a different workspace directory".
    //
    // Every conversation in a tilde-configured project was single-turn. The
    // two existing continuation tests both use a binding with NO cwd, so they
    // return early at the unbound branch and never reach this comparison.
    const home = process.env.HOME ?? '/root';
    const deps = dependencies();
    deps.getProject = vi.fn(async () => ({
      workingDirectory: '~/dev/station',
      defaultWorkspaceIsolation: 'shared' as const,
    }));
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'station',
      // What turn 1 actually persisted: expanded and resolved.
      cwd: `${home}/dev/station`,
      workspaceIsolation: { mode: 'shared' as const },
    }));

    await executeForegroundMessage(
      {
        target: {
          environment: { kind: 'current' },
          agent: agentId('station'),
          workspace: { kind: 'project', projectSlug: 'station' },
        },
        message: 'Second turn',
        conversationId: 'conversation:existing',
      },
      deps,
    );

    // Continued, not restarted — and not refused.
    expect(deps.sendTurn).toHaveBeenCalled();
    expect(deps.startSession).not.toHaveBeenCalled();
  });

  test('refuses an already-invalid worktree project with its project and configured directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-execution-nonrepo-'));
    const deps = dependencies();
    deps.getProject = vi.fn(async () => ({
      workingDirectory: directory,
      defaultWorkspaceIsolation: 'worktree' as const,
    }));

    try {
      await expect(
        executeForegroundMessage(
          {
            target: {
              environment: { kind: 'current' },
              agent: agentId('station'),
              workspace: { kind: 'project', projectSlug: 'legacy-project' },
            },
            message: 'Start isolated work',
          },
          deps,
        ),
      ).rejects.toThrow(
        `Project 'legacy-project' cannot use worktree isolation: configured working directory '${directory}' is not inside a Git working tree`,
      );
      expect(deps.startSession).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('surfaces worktree provisioning failures instead of using the shared checkout', async () => {
    const repoPath = createRepo();
    writeFileSync(join(repoPath, 'dirty.txt'), 'dirty\n');
    const deps = dependencies();
    deps.getProject = vi.fn(async () => ({
      workingDirectory: repoPath,
      defaultWorkspaceIsolation: 'worktree' as const,
    }));

    try {
      await expect(
        executeForegroundMessage(
          {
            target: {
              environment: { kind: 'current' },
              agent: agentId('station'),
              workspace: { kind: 'project', projectSlug: 'station' },
            },
            message: 'Start isolated work',
          },
          deps,
        ),
      ).rejects.toThrow(
        'Cannot provision isolated worktree from a dirty repository',
      );
      expect(deps.startSession).not.toHaveBeenCalled();
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('cleans a provisioned worktree when session start fails, then propagates the error', async () => {
    const repoPath = createRepo();
    const deps = dependencies();
    deps.getProject = vi.fn(async () => ({
      workingDirectory: repoPath,
      defaultWorkspaceIsolation: 'worktree' as const,
    }));
    deps.startSession = vi.fn(async () => {
      throw new Error('provider start failed');
    });

    try {
      await expect(
        executeForegroundMessage(
          {
            target: {
              environment: { kind: 'current' },
              agent: agentId('station'),
              workspace: { kind: 'project', projectSlug: 'station' },
            },
            message: 'Start isolated work',
          },
          deps,
        ),
      ).rejects.toThrow('provider start failed');
      const startInput = vi.mocked(deps.startSession).mock.calls[0]?.[1];
      expect(startInput?.cwd && existsSync(startInput.cwd)).toBe(false);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('keeps a provisioned worktree when local start is indeterminate and does not send a turn', async () => {
    const repoPath = createRepo();
    const deps = dependencies();
    const worktree: WorktreeSessionMetadata = {
      mode: 'worktree',
      repoPath,
      path: '/repo-worktrees/conversation-uncertain-local',
      branch: 'station/session/conversation-uncertain-local',
      baseRef: 'HEAD',
      cleanupPolicy: 'cleanup',
      preserveOnFailure: false,
      createdAt: '2026-08-13T00:00:00.000Z',
    };
    deps.getProject = vi.fn(async () => ({
      workingDirectory: repoPath,
      defaultWorkspaceIsolation: 'worktree' as const,
    }));
    deps.provisionWorktree = vi.fn(async () => worktree);
    deps.finalizeWorktree = vi.fn(async () => 'removed' as const);
    const error = new ForegroundMessageIndeterminateError(
      {
        code: 'foreground_message_indeterminate',
        outcome: 'indeterminate',
        receipt: {
          commandId: 'command-uncertain-local',
          threadId: 'conversation:test',
          commandType: 'startSession',
          status: 'accepted',
          createdAt: '2026-08-13T00:00:00.000Z',
        },
        receiptStatus: 'unavailable',
        session: {
          threadId: 'conversation:test',
          provider: 'station-agent',
          status: 'ready',
          createdAt: '2026-08-13T00:00:00.000Z',
          updatedAt: '2026-08-13T00:00:00.000Z',
        },
      },
      'Session may already be running; do not retry automatically.',
    );
    deps.startSession = vi.fn(async () => {
      throw error;
    });

    try {
      await expect(
        executeForegroundMessage(
          {
            target: {
              environment: { kind: 'current' },
              agent: agentId('station'),
              workspace: {
                kind: 'project',
                projectSlug: 'station',
                workspaceIsolation: { mode: 'worktree' },
              },
            },
            message: 'Start safely',
          },
          deps,
        ),
      ).rejects.toBe(error);
      expect(deps.finalizeWorktree).not.toHaveBeenCalled();
      expect(deps.sendTurn).not.toHaveBeenCalled();
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('keeps a provisioned worktree for serialized remote indeterminacy and does not send a turn', async () => {
    const repoPath = createRepo();
    const deps = dependencies();
    const worktree: WorktreeSessionMetadata = {
      mode: 'worktree',
      repoPath,
      path: '/repo-worktrees/conversation-uncertain-remote',
      branch: 'station/session/conversation-uncertain-remote',
      baseRef: 'HEAD',
      cleanupPolicy: 'cleanup',
      preserveOnFailure: false,
      createdAt: '2026-08-13T00:00:00.000Z',
    };
    deps.getProject = vi.fn(async () => ({
      workingDirectory: repoPath,
      defaultWorkspaceIsolation: 'worktree' as const,
    }));
    deps.provisionWorktree = vi.fn(async () => worktree);
    deps.finalizeWorktree = vi.fn(async () => 'removed' as const);
    const remoteError = Object.assign(
      new Error('Remote Station reports an uncertain foreground start.'),
      {
        code: 'foreground_message_indeterminate',
        outcome: 'indeterminate' as const,
      },
    );
    deps.startSession = vi.fn(async () => {
      throw remoteError;
    });

    try {
      await expect(
        executeForegroundMessage(
          {
            target: {
              environment: { kind: 'current' },
              agent: agentId('station'),
              workspace: {
                kind: 'project',
                projectSlug: 'station',
                workspaceIsolation: { mode: 'worktree' },
              },
            },
            message: 'Start safely',
          },
          deps,
        ),
      ).rejects.toBe(remoteError);
      expect(deps.finalizeWorktree).not.toHaveBeenCalled();
      expect(deps.sendTurn).not.toHaveBeenCalled();
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('loudly records a leaked worktree when start-failure compensation also fails', async () => {
    const repoPath = createRepo();
    const deps = dependencies();
    const worktree: WorktreeSessionMetadata = {
      mode: 'worktree',
      repoPath,
      path: '/repo-worktrees/conversation-test',
      branch: 'station/session/conversation-test',
      baseRef: 'HEAD',
      cleanupPolicy: 'cleanup',
      preserveOnFailure: false,
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    deps.getProject = vi.fn(async () => ({
      workingDirectory: repoPath,
      defaultWorkspaceIsolation: 'worktree' as const,
    }));
    deps.provisionWorktree = vi.fn(async () => worktree);
    deps.startSession = vi.fn(async () => {
      throw new Error('provider start failed');
    });
    deps.finalizeWorktree = vi.fn(async () => {
      throw new Error('cleanup unavailable');
    });
    deps.warn = vi.fn();

    try {
      await expect(
        executeForegroundMessage(
          {
            target: {
              environment: { kind: 'current' },
              agent: agentId('station'),
              workspace: { kind: 'project', projectSlug: 'station' },
            },
            message: 'Start isolated work',
          },
          deps,
        ),
      ).rejects.toThrow(/provider start failed.*LEAKED WORKTREE/);
      expect(deps.warn).toHaveBeenCalledWith(
        expect.stringContaining(worktree.path),
        expect.objectContaining({
          worktreePath: worktree.path,
          worktreeBranch: worktree.branch,
          worktreeRepoPath: worktree.repoPath,
        }),
      );
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('rejects a mismatched worktree continuation and keeps its persisted isolation after a project toggle', async () => {
    const repoPath = createRepo();
    const service = new WorktreeProvisioningService();
    const worktree = await service.provision({
      repoPath,
      threadId: 'continuation',
      providerKind: 'station-agent',
      isolation: { mode: 'worktree' },
    });
    const deps = dependencies();
    deps.getProject = vi.fn(async () => ({
      workingDirectory: repoPath,
      defaultWorkspaceIsolation: 'worktree' as const,
    }));
    try {
      deps.readSessionBinding = vi.fn(async () => ({
        environmentId: 'environment-kontour',
        agentId: 'station',
        cwd: repoPath,
        workspaceIsolation: { mode: 'worktree' as const },
        worktree: worktree!,
      }));
      await expect(
        executeForegroundMessage(
          {
            target: {
              environment: { kind: 'current' },
              agent: agentId('station'),
              workspace: {
                kind: 'project',
                projectSlug: 'station',
                workspaceIsolation: { mode: 'worktree' },
              },
            },
            message: 'Continue',
            conversationId: 'conversation:continuation',
          },
          deps,
        ),
      ).rejects.toMatchObject({
        code: 'continuation_workspace_worktree_moved',
        message:
          "This conversation's worktree has moved and cannot be resumed.",
      });
      deps.readSessionBinding = vi.fn(async () => ({
        environmentId: 'environment-kontour',
        agentId: 'station',
        cwd: worktree!.path,
        workspaceIsolation: { mode: 'worktree' as const },
        worktree: worktree!,
      }));
      await expect(
        executeForegroundMessage(
          {
            target: {
              environment: { kind: 'current' },
              agent: agentId('station'),
              workspace: { kind: 'project', projectSlug: 'station' },
            },
            message: 'Continue',
            conversationId: 'conversation:continuation',
          },
          deps,
        ),
      ).resolves.toBeDefined();
      deps.getProject = vi.fn(async () => ({
        workingDirectory: repoPath,
        defaultWorkspaceIsolation: 'shared' as const,
      }));
      await expect(
        executeForegroundMessage(
          {
            target: {
              environment: { kind: 'current' },
              agent: agentId('station'),
              workspace: {
                kind: 'project',
                projectSlug: 'station',
                workspaceIsolation: { mode: 'worktree' },
              },
            },
            message: 'Continue',
            conversationId: 'conversation:continuation',
          },
          deps,
        ),
      ).resolves.toBeDefined();
    } finally {
      await service.cleanup({
        metadata: worktree!,
        terminalState: 'completed',
      });
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('does not resume a shared-origin session after the project changes to worktree isolation', async () => {
    const deps = dependencies();
    deps.getProject = vi.fn(async () => ({
      workingDirectory: '/srv/station',
      defaultWorkspaceIsolation: 'worktree' as const,
    }));
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'station',
      cwd: '/srv/station',
      workspaceIsolation: { mode: 'shared' as const },
    }));
    await expect(
      executeForegroundMessage(
        {
          target: {
            environment: { kind: 'current' },
            agent: agentId('station'),
            workspace: { kind: 'project', projectSlug: 'station' },
          },
          message: 'Continue',
          conversationId: 'conversation:shared',
        },
        deps,
      ),
    ).rejects.toThrow('different workspace isolation');
    expect(deps.sendTurn).not.toHaveBeenCalled();
  });

  test('fails closed for a project continuation with unknown legacy isolation', async () => {
    const deps = dependencies();
    deps.getProject = vi.fn(async () => ({
      workingDirectory: '/srv/station',
      defaultWorkspaceIsolation: 'shared' as const,
    }));
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'station',
      cwd: '/srv/station',
    }));
    await expect(
      executeForegroundMessage(
        {
          target: {
            environment: { kind: 'current' },
            agent: agentId('station'),
            workspace: { kind: 'project', projectSlug: 'station' },
          },
          message: 'Continue',
          conversationId: 'conversation:legacy',
        },
        deps,
      ),
    ).rejects.toThrow('no verified workspace isolation');
  });

  test('applies a model override to the next turn of a bound conversation', async () => {
    const deps = dependencies();
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'station',
    }));

    await executeForegroundMessage(
      {
        target: {
          environment: { kind: 'current' },
          agent: agentId('station'),
          model: { override: 'gpt-5.6-terra' },
        },
        message: 'Continue with this model',
        conversationId: 'conversation:model-switch',
      },
      deps,
    );

    expect(deps.startSession).not.toHaveBeenCalled();
    expect(deps.sendTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        threadId: 'conversation:model-switch',
        modelId: 'gpt-5.6-terra',
      }),
      undefined,
    );
  });

  test('rejects continuation when the persisted Agent binding differs', async () => {
    const deps = dependencies();
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'codex',
      userId: 'operator-a',
    }));

    await expect(
      executeForegroundMessage(
        {
          target: {
            environment: { kind: 'current' },
            agent: agentId('station'),
          },
          message: 'Continue',
          conversationId: 'conversation:other-agent',
          userId: 'operator-a',
        },
        deps,
      ),
    ).rejects.toThrow(
      'belongs to a different Environment, Agent, or Station user',
    );
    expect(deps.startSession).not.toHaveBeenCalled();
    expect(deps.sendTurn).not.toHaveBeenCalled();
  });

  test('rejects a reused conversation whose persisted cwd differs from the resolved workspace', async () => {
    const deps = dependencies();
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'station',
      cwd: '/srv/secret',
    }));

    await expect(
      executeForegroundMessage(
        {
          target: {
            environment: { kind: 'current' },
            agent: agentId('station'),
            workspace: { kind: 'directory', cwd: '/srv/station' },
          },
          message: 'Continue in the verified workspace',
          conversationId: 'conversation:wrong-cwd',
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: 'continuation_workspace_direct_mismatch',
      message: 'This conversation belongs to a different workspace directory.',
    });
    expect(deps.startSession).not.toHaveBeenCalled();
    expect(deps.sendTurn).not.toHaveBeenCalled();
  });

  test.each([
    [
      'is resumed without its project context',
      {
        cwd: '/srv/station-worktree',
        workspaceIsolation: { mode: 'worktree' as const },
        worktree: {
          path: '/srv/station-worktree',
          repoPath: '/srv/station',
        } as WorktreeSessionMetadata,
      },
      undefined,
      'continuation_workspace_project_context_missing',
      'This conversation must be resumed from its original project.',
    ],
    [
      'has a deleted worktree',
      {
        cwd: '/definitely-gone/station-worktree',
        workspaceIsolation: { mode: 'worktree' as const },
        worktree: {
          path: '/definitely-gone/station-worktree',
          repoPath: process.cwd(),
        } as WorktreeSessionMetadata,
      },
      { kind: 'project' as const, projectSlug: 'station' },
      'continuation_workspace_worktree_gone',
      "This conversation's worktree is gone and cannot be resumed.",
    ],
    [
      'belongs to a different project',
      {
        cwd: process.cwd(),
        workspaceIsolation: { mode: 'worktree' as const },
        worktree: {
          path: process.cwd(),
          repoPath: process.cwd(),
        } as WorktreeSessionMetadata,
      },
      { kind: 'project' as const, projectSlug: 'other' },
      'continuation_workspace_different_project',
      'This conversation belongs to a different project.',
    ],
  ])(
    'fails closed when a worktree continuation %s',
    async (_reason, partialBinding, workspace, code, message) => {
      const deps = dependencies();
      deps.readSessionBinding = vi.fn(async () => ({
        environmentId: 'environment-kontour',
        agentId: 'station',
        ...partialBinding,
      }));
      deps.getProject = vi.fn(async (_access, slug) => ({
        workingDirectory: slug === 'other' ? '/tmp' : process.cwd(),
        defaultWorkspaceIsolation: 'worktree' as const,
      }));

      await expect(
        executeForegroundMessage(
          {
            target: {
              environment: { kind: 'current' },
              agent: agentId('station'),
              ...(workspace ? { workspace } : {}),
            },
            message: 'Continue',
            conversationId: `conversation:${code}`,
          },
          deps,
        ),
      ).rejects.toMatchObject({ code, message });
      expect(deps.startSession).not.toHaveBeenCalled();
      expect(deps.sendTurn).not.toHaveBeenCalled();
    },
  );

  test('fails closed when a worktree path has moved', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'station-worktree-moved-'));
    const deps = dependencies();
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'station',
      cwd: process.cwd(),
      workspaceIsolation: { mode: 'worktree' as const },
      worktree: {
        path: worktreePath,
        repoPath: process.cwd(),
      } as WorktreeSessionMetadata,
    }));
    deps.getProject = vi.fn(async () => ({
      workingDirectory: process.cwd(),
      defaultWorkspaceIsolation: 'worktree' as const,
    }));

    try {
      await expect(
        executeForegroundMessage(
          {
            target: {
              environment: { kind: 'current' },
              agent: agentId('station'),
              workspace: { kind: 'project', projectSlug: 'station' },
            },
            message: 'Continue',
            conversationId: 'conversation:moved-worktree',
          },
          deps,
        ),
      ).rejects.toMatchObject({
        code: 'continuation_workspace_worktree_moved',
        message:
          "This conversation's worktree has moved and cannot be resumed.",
      });
      expect(deps.startSession).not.toHaveBeenCalled();
      expect(deps.sendTurn).not.toHaveBeenCalled();
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  test('fails closed when a worktree binding uses a non-canonical path', async () => {
    const deps = dependencies();
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'station',
      cwd: `${process.cwd()}/.`,
      workspaceIsolation: { mode: 'worktree' as const },
      worktree: {
        path: process.cwd(),
        repoPath: process.cwd(),
      } as WorktreeSessionMetadata,
    }));
    deps.getProject = vi.fn(async () => ({
      workingDirectory: process.cwd(),
      defaultWorkspaceIsolation: 'worktree' as const,
    }));

    await expect(
      executeForegroundMessage(
        {
          target: {
            environment: { kind: 'current' },
            agent: agentId('station'),
            workspace: { kind: 'project', projectSlug: 'station' },
          },
          message: 'Continue',
          conversationId: 'conversation:corrupt-worktree-binding',
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: 'continuation_workspace_corrupt_worktree_binding',
      message: 'This conversation has a corrupt worktree binding.',
    });
    expect(deps.startSession).not.toHaveBeenCalled();
    expect(deps.sendTurn).not.toHaveBeenCalled();
  });

  // UX audit T3: a conversation that was NEVER bound to a workspace is not the
  // same refusal as one bound somewhere else. It used to surface as an untyped
  // `Error` (project workspace) or as `continuation_workspace_direct_mismatch`
  // (directory workspace) — both of which read as "belongs elsewhere", which
  // is what got the queued follow-up that triggered it destroyed.
  test('names an unbound conversation continued into a workspace as unbound, not misplaced', async () => {
    const deps = dependencies();
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'station',
    }));

    await expect(
      executeForegroundMessage(
        {
          target: {
            environment: { kind: 'current' },
            agent: agentId('station'),
            workspace: { kind: 'directory', cwd: '/srv/station' },
          },
          message: 'a follow-up that must survive this refusal',
          conversationId: 'conversation:never-bound',
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: 'continuation_workspace_unbound',
    });
    expect(deps.startSession).not.toHaveBeenCalled();
    expect(deps.sendTurn).not.toHaveBeenCalled();
  });

  test('preserves a direct conversation workspace when a follow-up omits context', async () => {
    const deps = dependencies();
    deps.readSessionBinding = vi.fn(async () => ({
      environmentId: 'environment-kontour',
      agentId: 'station',
      cwd: '/Users/brian',
    }));

    await expect(
      executeForegroundMessage(
        {
          target: {
            environment: { kind: 'current' },
            agent: agentId('station'),
          },
          message: 'Second turn after rehydration',
          conversationId: 'conversation:global-first-turn',
        },
        deps,
      ),
    ).resolves.toBeDefined();
    expect(deps.startSession).not.toHaveBeenCalled();
    expect(deps.sendTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        threadId: 'conversation:global-first-turn',
        input: 'Second turn after rehydration',
      }),
      undefined,
    );
  });
});
