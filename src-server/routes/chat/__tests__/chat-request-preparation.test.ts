import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindHostWorkflowSession,
  flowAgentsArtifactRoot,
} from '@kontourai/flow-agents';
import { buildUserProfileContextBlock } from '@kontourai/station-contracts/user-profile';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createLLMProvider } from '../../../providers/connection-factories.js';
import { AgentPolicyService } from '../../../services/agents/agent-policy-service.js';
import { ProviderService } from '../../../services/connections/provider-service.js';
import { stationWorkflowActorKey } from '../../../services/evidence/orchestration-workflow-sidecar.js';
import {
  extractChatUserText,
  prepareChatRequest,
} from '../chat-request-preparation.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  policyChecks: { add: vi.fn() },
  providerOps: { add: vi.fn() },
}));
vi.mock('../../../providers/connection-factories.js', () => ({
  createLLMProvider: vi.fn(),
}));

describe('chat-request-preparation', () => {
  test('prepareChatRequest resolves project provider overrides and knowledge context', async () => {
    const result = await prepareChatRequest({
      ctx: {
        providerService: {
          resolveProvider: vi.fn(async () => ({
            model: 'claude-3',
            providerId: 'conn-2',
          })),
          listProviderConnections: vi.fn(() => [
            { id: 'conn-1', type: 'bedrock' },
            { id: 'conn-2', type: 'openai-compat' },
          ]),
        },
        knowledgeService: {
          getInjectContext: vi.fn(async () => 'inject-context'),
          getRAGContextDetailed: vi.fn(async () => ({
            context: 'rag-context',
            chunkCount: 1,
            sources: ['guide.md'],
          })),
        },
        feedbackService: {
          getBehaviorGuidelinesDetailed: vi.fn(() => ({
            text: 'feedback-guidelines',
            reinforce: 2,
            avoid: 1,
          })),
        },
        storageAdapter: {} as any,
        activeAgents: new Map(),
        logger: {
          warn: vi.fn(),
          debug: vi.fn(),
        },
      } as any,
      slug: 'default',
      input: 'How do I deploy this?',
      options: { providerManagedFallback: true },
      projectSlug: 'proj-1',
    });

    expect(result.options.model).toBe('claude-3');
    expect(result.resolvedProviderConn).toMatchObject({
      id: 'conn-2',
      type: 'openai-compat',
    });
    expect(result.injectContext).toBe('inject-context');
    expect(result.ragContext).toBe('rag-context\n\nfeedback-guidelines');
    // station#2649: the dispatch-time receipt records exactly the blocks
    // this preparation composed — refs from the SAME retrieval that built
    // the injected string, counts from the SAME summary that built the
    // guidelines text.
    expect(result.contextInjection).toEqual({
      projectRules: { approxTokens: expect.any(Number) },
      knowledge: {
        chunkCount: 1,
        sources: ['guide.md'],
        omittedSources: 0,
        approxTokens: expect.any(Number),
      },
      guidelines: {
        reinforce: 2,
        avoid: 1,
        approxTokens: expect.any(Number),
      },
    });
  });

  test('prepareChatRequest records NO context blocks when nothing was injected (station#2649)', async () => {
    const result = await prepareChatRequest({
      ctx: {
        providerService: {
          resolveProvider: vi.fn(),
          listProviderConnections: vi.fn(() => []),
        },
        knowledgeService: {
          getInjectContext: vi.fn(async () => null),
          getRAGContextDetailed: vi.fn(async () => null),
        },
        feedbackService: {
          getBehaviorGuidelinesDetailed: vi.fn(() => null),
        },
        storageAdapter: { getProject: vi.fn(() => undefined) } as any,
        activeAgents: new Map(),
        logger: { warn: vi.fn(), debug: vi.fn() },
      } as any,
      slug: 'default',
      input: 'hello',
      options: {},
      projectSlug: 'proj-1',
    });

    // The strip case: nothing injected → an EMPTY record (a truthful
    // "Station injected nothing"), never fabricated blocks.
    expect(result.contextInjection).toEqual({});
    expect(result.injectContext).toBeNull();
    expect(result.ragContext).toBeNull();
  });

  test('prepareChatRequest skips provider resolution without an explicit fallback flag', async () => {
    const logger = {
      warn: vi.fn(),
      debug: vi.fn(),
    };

    const result = await prepareChatRequest({
      ctx: {
        providerService: {
          resolveProvider: vi.fn(async () => {
            throw new Error('boom');
          }),
          listProviderConnections: vi.fn(() => []),
        },
        knowledgeService: {
          getInjectContext: vi.fn(async () => null),
          getRAGContextDetailed: vi.fn(async () => null),
        },
        feedbackService: {
          getBehaviorGuidelinesDetailed: vi.fn(() => null),
        },
        storageAdapter: {} as any,
        activeAgents: new Map(),
        logger,
      } as any,
      slug: 'default',
      input: 'hello',
      options: {},
      projectSlug: 'proj-1',
    });

    expect(result.options.model).toBeUndefined();
    expect(result.resolvedProviderConn).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('prepareChatRequest resolves a global provider when no model override is present', async () => {
    const result = await prepareChatRequest({
      ctx: {
        providerService: {
          resolveProvider: vi.fn(async () => ({
            model: 'llama3.2',
            providerId: 'ollama-local',
          })),
          listProviderConnections: vi.fn(() => [
            { id: 'ollama-local', type: 'ollama' },
          ]),
        },
        knowledgeService: {
          getInjectContext: vi.fn(async () => null),
          getRAGContextDetailed: vi.fn(async () => null),
        },
        feedbackService: {
          getBehaviorGuidelinesDetailed: vi.fn(() => null),
        },
        storageAdapter: {} as any,
        activeAgents: new Map(),
        logger: {
          warn: vi.fn(),
          debug: vi.fn(),
        },
      } as any,
      slug: 'default',
      input: 'hello',
      options: { providerManagedFallback: true },
    });

    expect(result.options.model).toBe('llama3.2');
    expect(result.resolvedProviderConn).toMatchObject({
      id: 'ollama-local',
      type: 'ollama',
    });
  });

  test('prepareChatRequest routes an active agent provider override into the tool-preserving model path', async () => {
    const resolveProvider = vi.fn(async () => ({
      model: 'llama3.2',
      providerId: 'ollama-local',
    }));
    const result = await prepareChatRequest({
      ctx: {
        providerService: {
          resolveProvider,
          listProviderConnections: vi.fn(() => [
            { id: 'ollama-local', type: 'ollama' },
          ]),
        },
        knowledgeService: {
          getInjectContext: vi.fn(async () => null),
          getRAGContextDetailed: vi.fn(async () => null),
        },
        feedbackService: {
          getBehaviorGuidelinesDetailed: vi.fn(() => null),
        },
        storageAdapter: {} as any,
        activeAgents: new Map([['default', { tools: ['station-control'] }]]),
        logger: {
          warn: vi.fn(),
          debug: vi.fn(),
        },
      } as any,
      slug: 'default',
      input: 'hello',
      options: {
        providerManagedFallback: true,
        providerId: 'ollama-local',
        providerModel: 'llama3.2',
      },
    });

    expect(resolveProvider).toHaveBeenCalledWith({
      conversationProviderId: 'ollama-local',
      conversationModel: 'llama3.2',
      projectSlug: undefined,
      allowModelOnlyFallback: true,
    });
    expect(result.options.model).toBe('llama3.2');
    expect(result.options.providerId).toBe('ollama-local');
  });

  test('prepareChatRequest does not resolve provider fallback without an explicit flag', async () => {
    const result = await prepareChatRequest({
      ctx: {
        providerService: {
          resolveProvider: vi.fn(async () => ({
            model: 'llama3.2',
            providerId: 'ollama-local',
          })),
          listProviderConnections: vi.fn(() => [
            { id: 'ollama-local', type: 'ollama' },
          ]),
        },
        knowledgeService: {
          getInjectContext: vi.fn(async () => null),
          getRAGContextDetailed: vi.fn(async () => null),
        },
        feedbackService: {
          getBehaviorGuidelinesDetailed: vi.fn(() => null),
        },
        storageAdapter: {} as any,
        activeAgents: new Map(),
        logger: {
          warn: vi.fn(),
          debug: vi.fn(),
        },
      } as any,
      slug: 'default',
      input: 'hello',
      options: {},
    });

    expect(result.options.model).toBeUndefined();
    expect(result.resolvedProviderConn).toBeNull();
  });

  test('prepareChatRequest surfaces provider resolution failures when provider-managed fallback is explicit', async () => {
    await expect(
      prepareChatRequest({
        ctx: {
          providerService: {
            resolveProvider: vi.fn(async () => {
              throw new Error('No models available for provider');
            }),
            listProviderConnections: vi.fn(() => []),
          },
          knowledgeService: {
            getInjectContext: vi.fn(async () => null),
            getRAGContextDetailed: vi.fn(async () => null),
          },
          feedbackService: {
            getBehaviorGuidelinesDetailed: vi.fn(() => null),
          },
          storageAdapter: {} as any,
          activeAgents: new Map(),
          logger: {
            warn: vi.fn(),
            debug: vi.fn(),
          },
        } as any,
        slug: 'default',
        input: 'hello',
        options: { providerManagedFallback: true },
      }),
    ).rejects.toThrow(/No models available/);
  });

  // station#1288: the tests above all stub `resolveProvider` directly, which
  // hid a real defect — `ProviderService.resolveProvider`'s pairing guard
  // ("Conversation provider and model overrides must be supplied together")
  // throws on exactly the shape the station-agent relay sends (a
  // `providerModel` with no `providerId`), so `providerManagedFallback` alone
  // was NOT enough; a flipped managed-chat turn 500'd instead of 400'ing.
  // These exercise the REAL `ProviderService` (only its LLM-provider
  // factory dependency is mocked) through `prepareChatRequest`, feeding it
  // the adapter's exact outbound options shape.
  describe('resolves the station-agent relay carrier through a real ProviderService (#1288)', () => {
    function createStorageAdapter(connections: Array<Record<string, unknown>>) {
      return {
        listProviderConnections: () => connections,
        getProject: vi.fn(),
      } as any;
    }

    function relayOptions(model: string) {
      // Exactly what station-agent-adapter.ts's sendTurn now sends when
      // input.modelId is set: conversationId + model + the fallback carrier,
      // never a providerId (neither ProviderSendTurnInput nor
      // ProviderSessionStartInput carries one).
      return {
        conversationId: 'task-1288',
        model,
        providerManagedFallback: true,
        providerModel: model,
      };
    }

    beforeEach(() => {
      vi.mocked(createLLMProvider).mockReset();
    });

    test('a lone providerModel (no providerId) resolves against the sole enabled connection', async () => {
      const connections = [
        {
          id: 'ollama-local',
          type: 'ollama',
          name: 'Ollama',
          enabled: true,
          capabilities: ['llm'],
          config: {},
        },
      ];
      vi.mocked(createLLMProvider).mockReturnValue({
        listModels: vi.fn(async () => [
          { id: 'qwen3-coder:latest', name: 'Qwen3 Coder' },
        ]),
      } as any);
      const providerService = new ProviderService(
        createStorageAdapter(connections),
        async () => ({}) as any,
      );

      const result = await prepareChatRequest({
        ctx: {
          providerService,
          knowledgeService: {
            getInjectContext: vi.fn(async () => null),
            getRAGContextDetailed: vi.fn(async () => null),
          },
          feedbackService: { getBehaviorGuidelinesDetailed: vi.fn(() => null) },
          storageAdapter: {} as any,
          activeAgents: new Map(),
          logger: { warn: vi.fn(), debug: vi.fn() },
        } as any,
        slug: 'reviewer',
        input: 'Use qwen for this one',
        options: relayOptions('qwen3-coder:latest'),
      });

      expect(result.options.model).toBe('qwen3-coder:latest');
      expect(result.resolvedProviderConn).toMatchObject({
        id: 'ollama-local',
        type: 'ollama',
      });
    });

    test('a model unavailable on the resolved connection rejects with an actionable, non-leaking error', async () => {
      const connections = [
        {
          id: 'ollama-local',
          type: 'ollama',
          name: 'Ollama',
          enabled: true,
          capabilities: ['llm'],
          config: {},
        },
      ];
      vi.mocked(createLLMProvider).mockReturnValue({
        listModels: vi.fn(async () => [{ id: 'llama3.2', name: 'Llama 3.2' }]),
      } as any);
      const providerService = new ProviderService(
        createStorageAdapter(connections),
        async () => ({}) as any,
      );

      await expect(
        prepareChatRequest({
          ctx: {
            providerService,
            knowledgeService: {
              getInjectContext: vi.fn(async () => null),
              getRAGContextDetailed: vi.fn(async () => null),
            },
            feedbackService: {
              getBehaviorGuidelinesDetailed: vi.fn(() => null),
            },
            storageAdapter: {} as any,
            activeAgents: new Map(),
            logger: { warn: vi.fn(), debug: vi.fn() },
          } as any,
          slug: 'reviewer',
          input: 'Use a model that does not exist',
          options: relayOptions('not-a-real-model'),
        }),
      ).rejects.toThrow(
        "Model 'not-a-real-model' is not available on provider connection 'Ollama'.",
      );
    });

    test('no default connection configured rejects with an actionable error naming the model', async () => {
      const providerService = new ProviderService(
        createStorageAdapter([]),
        async () => ({}) as any,
      );

      await expect(
        prepareChatRequest({
          ctx: {
            providerService,
            knowledgeService: {
              getInjectContext: vi.fn(async () => null),
              getRAGContextDetailed: vi.fn(async () => null),
            },
            feedbackService: {
              getBehaviorGuidelinesDetailed: vi.fn(() => null),
            },
            storageAdapter: {} as any,
            activeAgents: new Map(),
            logger: { warn: vi.fn(), debug: vi.fn() },
          } as any,
          slug: 'reviewer',
          input: 'Use qwen for this one',
          options: relayOptions('qwen3-coder:latest'),
        }),
      ).rejects.toThrow("apply the model override 'qwen3-coder:latest'");
    });
  });

  test('extractChatUserText returns the first user text part', () => {
    expect(
      extractChatUserText([
        {
          role: 'system',
          parts: [{ type: 'text', text: 'system' }],
        },
        {
          role: 'user',
          parts: [
            { type: 'file', text: 'ignored' },
            { type: 'text', text: 'user message' },
          ],
        },
      ]),
    ).toBe('user message');
  });
});

describe('chat-request-preparation — workflow steering (S3)', () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const dir of workspaces.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * flow-agents 3.x's workflow-steering hook reads active-work sidecars only
   * from the durable `.kontourai/flow-agents/` root (its shared
   * `flowAgentsArtifactRootsForRead` no longer falls back to the legacy
   * `.flow-agents/` dir) — see agent-policy-service.test.ts's equivalent
   * fixture comment for the full explanation.
   */
  function steeringWorkspace(conversationId: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'chat-prep-policy-'));
    workspaces.push(dir);
    const taskDir = join(dir, '.kontourai', 'flow-agents', 'demo-task');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, 'state.json'),
      JSON.stringify({
        task_slug: 'demo-task',
        status: 'blocked',
        phase: 'execute',
        next_action: { status: 'needs_user', summary: 'decide on API shape' },
        updated_at: new Date().toISOString(),
      }),
    );
    bindHostWorkflowSession({
      artifactRoot: flowAgentsArtifactRoot(dir),
      artifactDir: taskDir,
      actorKey: stationWorkflowActorKey(conversationId),
      owner: 'station-test',
      source: 'fixture',
    });
    return dir;
  }

  function createCtx(workingDirectory?: string) {
    return {
      providerService: {
        resolveProvider: vi.fn(),
        listProviderConnections: vi.fn(() => []),
      },
      knowledgeService: {
        getInjectContext: vi.fn(async () => null),
        getRAGContextDetailed: vi.fn(async () => ({
          context: 'rag-context',
          chunkCount: 1,
          sources: ['guide.md'],
        })),
      },
      feedbackService: {
        getBehaviorGuidelinesDetailed: vi.fn(() => ({
          text: 'feedback-guidelines',
          reinforce: 2,
          avoid: 1,
        })),
      },
      storageAdapter: {
        getProject: vi.fn(() => ({ workingDirectory })),
      },
      logger: { warn: vi.fn(), debug: vi.fn() },
    } as any;
  }

  function policyService(): AgentPolicyService {
    return new AgentPolicyService({
      env: { ...process.env, SA_HOOK_PROFILE: '', SA_DISABLED_HOOKS: '' },
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
  }

  test('appends the canonical steering for a project workspace with attention-needing state', async () => {
    const conversationId = 'managed-chat-1';
    const ws = steeringWorkspace(conversationId);
    const result = await prepareChatRequest({
      ctx: createCtx(ws),
      slug: 'default',
      input: 'continue please',
      options: { conversationId },
      projectSlug: 'proj-1',
      agentPolicyService: policyService(),
    });

    expect(result.ragContext).toContain('rag-context');
    expect(result.ragContext).toContain('feedback-guidelines');
    expect(result.ragContext).toContain('WORKFLOW STATE ATTENTION');
    expect(result.ragContext).toContain('decide on API shape');
  });

  test('does not inherit another conversation actor pointer', async () => {
    const ws = steeringWorkspace('bound-conversation');
    const result = await prepareChatRequest({
      ctx: createCtx(ws),
      slug: 'default',
      input: 'continue please',
      options: { conversationId: 'different-conversation' },
      projectSlug: 'proj-1',
      agentPolicyService: policyService(),
    });

    expect(result.ragContext).toBe('rag-context\n\nfeedback-guidelines');
  });

  test('non-opted project workspaces are untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-prep-plain-'));
    workspaces.push(dir);
    const result = await prepareChatRequest({
      ctx: createCtx(dir),
      slug: 'default',
      input: 'continue please',
      options: {},
      projectSlug: 'proj-1',
      agentPolicyService: policyService(),
    });

    expect(result.ragContext).toBe('rag-context\n\nfeedback-guidelines');
  });

  test('projects without a working directory and storage errors fail open', async () => {
    const noDir = await prepareChatRequest({
      ctx: createCtx(undefined),
      slug: 'default',
      input: 'hi',
      options: {},
      projectSlug: 'proj-1',
      agentPolicyService: policyService(),
    });
    expect(noDir.ragContext).toBe('rag-context\n\nfeedback-guidelines');

    const throwingCtx = createCtx('/tmp');
    throwingCtx.storageAdapter.getProject = vi.fn(() => {
      throw new Error('missing project');
    });
    const errored = await prepareChatRequest({
      ctx: throwingCtx,
      slug: 'default',
      input: 'hi',
      options: {},
      projectSlug: 'proj-1',
      agentPolicyService: policyService(),
    });
    expect(errored.ragContext).toBe('rag-context\n\nfeedback-guidelines');
  });
  describe('user profile block (station#2652)', () => {
    /**
     * A minimal ctx with no knowledge, no feedback guidelines and no project,
     * so `ragContext` is entirely whatever the profile block contributes.
     */
    const ctxWithProfile = (userProfile: unknown) =>
      ({
        providerService: {
          resolveProvider: vi.fn(),
          listProviderConnections: vi.fn(() => []),
        },
        knowledgeService: {
          getInjectContext: vi.fn(async () => null),
          getRAGContextDetailed: vi.fn(async () => null),
        },
        feedbackService: { getBehaviorGuidelinesDetailed: vi.fn(() => null) },
        storageAdapter: {} as any,
        activeAgents: new Map(),
        appConfig: userProfile === undefined ? {} : { userProfile },
        logger: { warn: vi.fn(), debug: vi.fn() },
      }) as any;

    const prepare = (userProfile: unknown) =>
      prepareChatRequest({
        ctx: ctxWithProfile(userProfile),
        slug: 'default',
        input: 'hi',
        options: {},
      });

    // The honesty property. A skipped question must add NOTHING — not a
    // default role, not an empty block, not a header.
    test.each([
      ['the step was never reached (no userProfile key)', undefined],
      ['the user skipped both questions', {}],
      [
        'the persisted values are outside the vocabulary',
        { role: 'astronaut' },
      ],
    ])('injects nothing when %s', async (_label, userProfile) => {
      const result = await prepare(userProfile);
      expect(result.ragContext).toBeNull();
    });

    test('injects exactly the authored block for a Station-engine turn', async () => {
      const result = await prepare({ role: 'engineer', comfort: 'expert' });
      expect(result.ragContext).toBe(
        buildUserProfileContextBlock({ role: 'engineer', comfort: 'expert' }),
      );
      // Not merely "contains a profile" — byte-identical to the one authored
      // derivation, so the first-run preview cannot drift from what is sent.
      expect(result.ragContext).toContain('[USER PROFILE]');
    });

    test('composes after the blocks already on ragContext, never replacing them', async () => {
      const ctx = ctxWithProfile({ role: 'manager' });
      ctx.knowledgeService.getRAGContextDetailed = vi.fn(async () => ({
        context: 'rag-context',
        chunkCount: 1,
        sources: ['guide.md'],
      }));
      ctx.feedbackService.getBehaviorGuidelinesDetailed = vi.fn(() => ({
        text: 'feedback-guidelines',
        reinforce: 2,
        avoid: 1,
      }));
      const result = await prepareChatRequest({
        ctx,
        slug: 'default',
        input: 'hi',
        options: {},
        projectSlug: 'proj-1',
      });
      expect(result.ragContext).toBe(
        `rag-context\n\nfeedback-guidelines\n\n${buildUserProfileContextBlock({ role: 'manager' })}`,
      );
    });

    test('leaves an existing ragContext byte-identical when the profile is unanswered', async () => {
      const ctx = ctxWithProfile(undefined);
      ctx.knowledgeService.getRAGContextDetailed = vi.fn(async () => ({
        context: 'rag-context',
        chunkCount: 1,
        sources: ['guide.md'],
      }));
      ctx.feedbackService.getBehaviorGuidelinesDetailed = vi.fn(() => ({
        text: 'feedback-guidelines',
        reinforce: 2,
        avoid: 1,
      }));
      const result = await prepareChatRequest({
        ctx,
        slug: 'default',
        input: 'hi',
        options: {},
        projectSlug: 'proj-1',
      });
      expect(result.ragContext).toBe('rag-context\n\nfeedback-guidelines');
    });
  });
});
