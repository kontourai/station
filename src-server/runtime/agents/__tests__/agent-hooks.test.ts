import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AgentPolicyService } from '../../../services/agents/agent-policy-service.js';
import { makeUnattendedGrantResolver } from '../../../services/agents/unattended-grant-resolver.js';
import {
  principalKey,
  UnattendedGrantStore,
} from '../../../services/agents/unattended-grant-store.js';
import { createAgentHooks } from '../agent-hooks.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  policyChecks: { add: vi.fn() },
  toolDenials: { add: vi.fn() },
  pluginGrantsStoreCorruption: { add: vi.fn() },
  unattendedGrantStoreUnavailable: { add: vi.fn() },
  unattendedGrantUses: { add: vi.fn() },
  unattendedGrantOperations: { add: vi.fn() },
}));

vi.mock(
  '@kontourai/station-shared/lifecycle-events',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/lifecycle-events')
      >();
    return {
      ...actual,
      // The stores take the ASYNC lock since archive#2646; overriding only the sync
      // twin left this injection inert and the grants store failing with
      // `store infrastructure failure (ENOENT)`.
      acquireFileMutationLockAsync: (
        lock: string,
        options?: Parameters<typeof actual.acquireFileMutationLockAsync>[1],
      ) =>
        actual.acquireFileMutationLockAsync(lock, {
          ...options,
          birthFingerprint: () => 'agent-hooks-unattended-grant-test',
        }),
    };
  },
);

const { toolDenials } = await import('../../../telemetry/metrics.js');

beforeEach(() => {
  vi.mocked(toolDenials.add).mockClear();
});

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    spec: {
      name: 'Planner',
      prompt: 'Plan carefully',
      tools: { autoApprove: ['github_*'] },
    },
    appConfig: {},
    configLoader: {
      loadAgent: vi.fn(),
    },
    agentFixedTokens: new Map(),
    memoryAdapters: new Map(),
    approvalRegistry: {} as any,
    approvalGuardian: undefined,
    toolNameMapping: new Map(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  } as any;
}

describe('createAgentHooks', () => {
  test('blocks tool execution after its runtime generation is revoked', async () => {
    let current = true;
    const deps = createDeps({
      isCurrentRuntimeGeneration: vi.fn(() => current),
    });
    const hooks = createAgentHooks(deps);
    current = false;

    const approved = await hooks.beforeToolCall!(
      {
        toolName: 'github_create_issue',
        toolCallId: 'tool-1',
        toolArgs: {},
      },
      { agentSlug: 'planner', conversationId: 'conv-1' },
    );

    expect(approved).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('runtime configuration changed'),
    });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'Stale agent generation blocked tool execution',
      {
        toolName: 'github_create_issue',
        agentSlug: 'planner',
        conversationId: 'conv-1',
      },
    );
    expect(toolDenials.add).toHaveBeenCalledWith(1, {
      reason: 'stale_generation',
    });
  });

  test('blocks tools that are disallowed for delegated child sessions', async () => {
    const hooks = createAgentHooks(createDeps());

    const approved = await hooks.beforeToolCall!(
      {
        toolName: 'station-control_send_message',
        toolCallId: 'tool-1',
        toolArgs: {},
      },
      {
        agentSlug: 'planner',
        conversationId: 'conv-1',
        delegation: {
          mode: 'isolated-child',
          depth: 1,
          maxDepth: 2,
          parentAgentSlug: agentId('root'),
          rootAgentSlug: agentId('root'),
          blockedTools: ['station-control_send_message'],
        },
      },
    );

    expect(approved).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('delegated child session'),
      // archive#3091: a denial produced by the staged pre-tool policy
      // evaluator (this is pre-tool-policy.ts's `delegated_tool_blocked`
      // deny()) must reach the caller with `policyDenied: true` intact —
      // this is what the UI's policy-denied badge derives from.
      policyDenied: true,
    });
    expect(toolDenials.add).toHaveBeenCalledWith(1, {
      reason: 'delegated_tool_blocked',
    });
  });

  test('denies approval-bound tools inside delegated child sessions', async () => {
    const hooks = createAgentHooks(createDeps());
    hooks.requestApproval = vi.fn().mockResolvedValue(true);

    const approved = await hooks.beforeToolCall!(
      {
        toolName: 'filesystem_write',
        toolCallId: 'tool-1',
        toolArgs: {},
      },
      {
        agentSlug: 'planner',
        conversationId: 'conv-1',
        delegation: {
          mode: 'isolated-child',
          depth: 1,
          maxDepth: 2,
          parentAgentSlug: agentId('root'),
          rootAgentSlug: agentId('root'),
          denyApprovals: true,
        },
      },
    );

    expect(approved).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('delegated child sessions cannot grant'),
    });
    expect(hooks.requestApproval).not.toHaveBeenCalled();
    expect(toolDenials.add).toHaveBeenCalledWith(1, {
      reason: 'delegation_deny_approvals',
    });
  });

  test('keeps guardian approval for attended invocations', async () => {
    const guardian = {
      isEnabled: vi.fn(() => true),
      getMode: vi.fn(() => 'review'),
      reviewToolCall: vi.fn().mockResolvedValue({
        decision: 'allow',
        reason: 'Safe and scoped.',
      }),
    };
    const hooks = createAgentHooks(createDeps({ approvalGuardian: guardian }));

    await expect(
      hooks.beforeToolCall!(
        {
          toolName: 'filesystem_write',
          toolCallId: 'tool-1',
          toolArgs: { path: 'notes.md' },
        },
        { agentSlug: 'planner', conversationId: 'conv-1' },
      ),
    ).resolves.toBe(true);
    expect(guardian.reviewToolCall).toHaveBeenCalledOnce();
  });

  test('denies tool execution when the guardian blocks in enforce mode', async () => {
    const hooks = createAgentHooks(
      createDeps({
        approvalGuardian: {
          isEnabled: () => true,
          getMode: () => 'enforce',
          reviewToolCall: vi.fn().mockResolvedValue({
            decision: 'deny',
            reason: 'Too destructive.',
          }),
        },
      }),
    );
    hooks.requestApproval = vi.fn().mockResolvedValue(true);

    const approved = await hooks.beforeToolCall!(
      {
        toolName: 'filesystem_write',
        toolCallId: 'tool-1',
        toolArgs: { path: '/etc/passwd' },
      },
      {
        agentSlug: 'planner',
        conversationId: 'conv-1',
      },
    );

    expect(approved).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('Too destructive.'),
    });
    expect(hooks.requestApproval).not.toHaveBeenCalled();
    expect(toolDenials.add).toHaveBeenCalledWith(1, {
      reason: 'guardian_denied',
    });
  });

  test('falls back to human approval when the guardian defers', async () => {
    const hooks = createAgentHooks(
      createDeps({
        approvalGuardian: {
          isEnabled: () => true,
          getMode: () => 'review',
          reviewToolCall: vi.fn().mockResolvedValue({
            decision: 'defer',
            reason: 'Unclear.',
          }),
        },
      }),
    );
    hooks.requestApproval = vi.fn().mockResolvedValue(true);

    const approved = await hooks.beforeToolCall!(
      {
        toolName: 'filesystem_write',
        toolCallId: 'tool-1',
        toolArgs: { path: 'notes.md' },
      },
      {
        agentSlug: 'planner',
        conversationId: 'conv-1',
      },
    );

    expect(approved).toBe(true);
    expect(hooks.requestApproval).toHaveBeenCalledOnce();
  });

  test('message enrichment preserves absent token categories', async () => {
    const addMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = {
      getConversation: vi.fn().mockResolvedValue({
        resourceId: 'planner',
        metadata: {},
      }),
      getMessages: vi.fn().mockResolvedValue([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ]),
      updateConversation: vi.fn().mockResolvedValue(undefined),
      removeLastMessage: vi.fn().mockResolvedValue(undefined),
      addMessage,
      applyEnrichmentUsage: vi.fn().mockResolvedValue(undefined),
    };
    const deps = createDeps({
      appConfig: { defaultModel: 'model-a' },
      configLoader: {
        loadAgent: vi.fn().mockResolvedValue({ model: 'model-a' }),
      },
      memoryAdapters: new Map([['planner', adapter]]),
    });
    const hooks = createAgentHooks(deps);

    await hooks.afterInvocation!({
      invocation: {
        agentSlug: 'planner',
        conversationId: 'conv-1',
        userId: 'user-1',
      },
      usage: { completionTokens: 7 },
      toolCallCount: 0,
    });

    const enrichedUsage = addMessage.mock.calls[0]?.[0]?.metadata?.usage;
    const persistedUsage = addMessage.mock.calls[0]?.[3]?.usage;
    expect(enrichedUsage).toEqual({
      outputTokens: 7,
      totalTokens: 7,
      estimatedCost: null,
    });
    expect(persistedUsage).toEqual(enrichedUsage);
    expect(enrichedUsage).not.toHaveProperty('inputTokens');
  });
});

describe('createAgentHooks — Flow Agents policy seams (S3)', () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const dir of workspaces.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function optedInWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hooks-policy-'));
    workspaces.push(dir);
    mkdirSync(join(dir, '.flow-agents'), { recursive: true });
    return dir;
  }

  function policyService(): AgentPolicyService {
    return new AgentPolicyService({
      env: { ...process.env, SA_HOOK_PROFILE: '', SA_DISABLED_HOOKS: '' },
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
  }

  test('config-protection blocks a protected-config write before dispatch', async () => {
    const ws = optedInWorkspace();
    const deps = createDeps({ agentPolicyService: policyService() });
    const hooks = createAgentHooks(deps);
    hooks.requestApproval = vi.fn().mockResolvedValue(true);

    const approved = await hooks.beforeToolCall!(
      {
        toolName: 'fs_write',
        toolCallId: 'tool-1',
        toolArgs: { path: join(ws, 'biome.json'), content: '{}' },
      },
      { agentSlug: 'planner', conversationId: 'conv-1' },
    );

    expect(approved).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('config-protection'),
    });
    expect(hooks.requestApproval).not.toHaveBeenCalled();
    expect(toolDenials.add).toHaveBeenCalledWith(1, {
      reason: 'policy_config_protection',
    });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'Policy blocked tool execution (config-protection)',
      expect.objectContaining({
        toolName: 'fs_write',
        engine: 'native',
        reason: expect.stringContaining('biome.json'),
      }),
    );
  });

  test('safe writes in an opted-in workspace still flow to approval', async () => {
    const ws = optedInWorkspace();
    const hooks = createAgentHooks(
      createDeps({ agentPolicyService: policyService() }),
    );
    hooks.requestApproval = vi.fn().mockResolvedValue(true);

    const approved = await hooks.beforeToolCall!(
      {
        toolName: 'fs_write',
        toolCallId: 'tool-1',
        toolArgs: { path: join(ws, 'src', 'index.ts'), content: 'x' },
      },
      { agentSlug: 'planner', conversationId: 'conv-1' },
    );

    expect(approved).toBe(true);
    expect(hooks.requestApproval).toHaveBeenCalledOnce();
  });

  test('keeps concurrent conversation approval requesters task-scoped', async () => {
    const hooks = createAgentHooks(createDeps());
    const firstRequester = vi.fn().mockResolvedValue(true);
    const secondRequester = vi.fn().mockResolvedValue(false);
    const releaseFirst = hooks.registerApprovalRequester(
      'conversation-1',
      firstRequester,
    );
    hooks.registerApprovalRequester('conversation-2', secondRequester);
    const tool = {
      toolName: 'fs_write',
      toolCallId: 'tool-1',
      toolArgs: { path: 'README.md', content: 'x' },
    };

    await expect(
      hooks.beforeToolCall!(tool, {
        agentSlug: 'planner',
        conversationId: 'conversation-1',
      }),
    ).resolves.toBe(true);
    const secondDenial = await hooks.beforeToolCall!(tool, {
      agentSlug: 'planner',
      conversationId: 'conversation-2',
    });
    expect(secondDenial).toMatchObject({
      allowed: false,
      reason: expect.any(String),
    });
    // archive#3091: a human declining via the approval requester is NOT a
    // policy denial — `policyDenied` must stay unset here, or the UI would
    // mislabel a user's own choice as something Station's policy blocked.
    expect((secondDenial as { policyDenied?: true }).policyDenied).toBe(
      undefined,
    );
    // archive#3210 (the inversion): this reason is a PURE Station template —
    // it embeds no guardian, hook, or tool-supplied prose — yet the absent
    // `policyDenied` marker was making both engine adapters redact it to
    // `Tool call failed.`, so the user who clicked Deny was told nothing
    // about their own decision. Authorship is now marked separately, and it
    // is what carries the words.
    expect(
      (secondDenial as { stationComposedReason?: true }).stationComposedReason,
    ).toBe(true);
    expect((secondDenial as { reason: string }).reason).toBe(
      "Tool 'fs_write' was denied: the user declined the approval request.",
    );

    expect(firstRequester).toHaveBeenCalledOnce();
    expect(secondRequester).toHaveBeenCalledOnce();
    releaseFirst();
    // archive#1834: once the requester is released the conversation has no
    // approval channel any more — the gate fails closed instead of silently
    // approving (the pre-fix behavior this assertion used to pin).
    await expect(
      hooks.beforeToolCall!(tool, {
        agentSlug: 'planner',
        conversationId: 'conversation-1',
      }),
    ).resolves.toMatchObject({ allowed: false });
    expect(firstRequester).toHaveBeenCalledOnce();
  });

  test('non-opted workspaces see zero behavior change', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hooks-plain-'));
    workspaces.push(dir);
    const hooks = createAgentHooks(
      createDeps({ agentPolicyService: policyService() }),
    );
    hooks.requestApproval = vi.fn().mockResolvedValue(true);

    const approved = await hooks.beforeToolCall!(
      {
        toolName: 'fs_write',
        toolCallId: 'tool-1',
        toolArgs: { path: join(dir, 'biome.json'), content: '{}' },
      },
      { agentSlug: 'planner', conversationId: 'conv-1' },
    );

    expect(approved).toBe(true);
  });

  test('quality gate runs after successful writes and logs warnings, never throws', () => {
    const ws = optedInWorkspace();
    const service = policyService();
    const afterWriteSpy = vi
      .spyOn(service, 'afterWrite')
      .mockReturnValue({ warnings: ['format drift in notes.md'] });
    const deps = createDeps({ agentPolicyService: service });
    const hooks = createAgentHooks(deps);

    hooks.afterToolCall!(
      {
        toolName: 'fs_write',
        toolCallId: 'tool-1',
        toolArgs: { path: join(ws, 'notes.md') },
      },
      { output: 'ok' },
      { agentSlug: 'planner', conversationId: 'conv-1' },
    );

    expect(afterWriteSpy).toHaveBeenCalledWith(join(ws, 'notes.md'), {
      runtimeKind: 'managed',
    });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'Policy quality-gate warning',
      expect.objectContaining({ warning: 'format drift in notes.md' }),
    );
  });

  test('quality gate skips failed tool calls and non-write tools', () => {
    const ws = optedInWorkspace();
    const service = policyService();
    const afterWriteSpy = vi.spyOn(service, 'afterWrite');
    const hooks = createAgentHooks(createDeps({ agentPolicyService: service }));

    hooks.afterToolCall!(
      {
        toolName: 'fs_write',
        toolCallId: 'tool-1',
        toolArgs: { path: join(ws, 'notes.md') },
      },
      { error: new Error('boom') },
      { agentSlug: 'planner' },
    );
    hooks.afterToolCall!(
      {
        toolName: 'read_file',
        toolCallId: 'tool-2',
        toolArgs: { path: join(ws, 'notes.md') },
      },
      { output: 'ok' },
      { agentSlug: 'planner' },
    );

    expect(afterWriteSpy).not.toHaveBeenCalled();
  });
});

describe('createAgentHooks — fail-closed approval fallthrough (station#1834)', () => {
  test('unattended principal is behavior-neutral across the approval gate', async () => {
    const principal = {
      kind: 'voice' as const,
      agentSlug: 'planner',
      sessionId: 'voice-session-1',
    };
    const invocation = { agentSlug: 'planner' };
    const cases = [
      {
        name: 'auto-approved read-only tool',
        tool: {
          toolName: 'github_get_issue',
          toolCallId: 'auto-approved',
          toolArgs: {},
        },
        deps: () => createDeps(),
      },
      {
        name: 'guardian allow',
        tool: {
          toolName: 'filesystem_write',
          toolCallId: 'guardian-allow',
          toolArgs: { path: 'notes.md' },
        },
        deps: () =>
          createDeps({
            approvalGuardian: {
              isEnabled: () => true,
              getMode: () => 'enforce',
              reviewToolCall: vi.fn().mockResolvedValue({
                decision: 'allow',
                reason: 'Safe and scoped.',
              }),
            },
          }),
      },
      {
        name: 'guardian enforce deny',
        tool: {
          toolName: 'filesystem_write',
          toolCallId: 'guardian-deny',
          toolArgs: { path: 'notes.md' },
        },
        deps: () =>
          createDeps({
            approvalGuardian: {
              isEnabled: () => true,
              getMode: () => 'enforce',
              reviewToolCall: vi.fn().mockResolvedValue({
                decision: 'deny',
                reason: 'Too destructive.',
              }),
            },
          }),
      },
      {
        name: 'no approval channel deny',
        tool: {
          toolName: 'filesystem_write',
          toolCallId: 'no-channel',
          toolArgs: { path: 'notes.md' },
        },
        deps: () => createDeps(),
      },
    ];

    for (const scenario of cases) {
      const withoutPrincipal = createAgentHooks(scenario.deps());
      const withPrincipal = createAgentHooks(scenario.deps());

      await expect(
        withPrincipal.beforeToolCall!(scenario.tool, {
          ...invocation,
          unattendedPrincipal: principal,
        }),
        scenario.name,
      ).resolves.toEqual(
        await withoutPrincipal.beforeToolCall!(scenario.tool, invocation),
      );
    }
  });

  test('denies an approval-bound tool when no approval channel exists', async () => {
    const deps = createDeps();
    const hooks = createAgentHooks(deps);

    const approved = await hooks.beforeToolCall!(
      {
        toolName: 'filesystem_write',
        toolCallId: 'tool-1',
        toolArgs: { path: 'notes.md' },
      },
      { agentSlug: 'planner' },
    );

    expect(approved).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('tools.autoApprove'),
    });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'No approval channel; denied tool execution',
      {
        toolName: 'filesystem_write',
        agentSlug: 'planner',
        conversationId: undefined,
        reason: 'no_approval_channel',
      },
    );
    expect(toolDenials.add).toHaveBeenCalledWith(1, {
      reason: 'no_approval_channel',
    });
  });

  test('still allows an autoApproved tool with no approval channel (guards over-denial)', async () => {
    const deps = createDeps();
    const hooks = createAgentHooks(deps);

    const approved = await hooks.beforeToolCall!(
      {
        toolName: 'github_create_issue',
        toolCallId: 'tool-1',
        toolArgs: {},
      },
      { agentSlug: 'planner' },
    );

    expect(approved).toBe(true);
    expect(deps.logger.warn).not.toHaveBeenCalled();
    expect(toolDenials.add).not.toHaveBeenCalled();
  });

  test('a requester scoped to another conversation does not cover the invocation', async () => {
    const deps = createDeps();
    const hooks = createAgentHooks(deps);
    const requester = vi.fn().mockResolvedValue(true);
    hooks.registerApprovalRequester('conversation-1', requester);

    const approved = await hooks.beforeToolCall!(
      {
        toolName: 'filesystem_write',
        toolCallId: 'tool-1',
        toolArgs: { path: 'notes.md' },
      },
      { agentSlug: 'planner', conversationId: 'conversation-2' },
    );

    expect(approved).toMatchObject({
      allowed: false,
      reason: expect.any(String),
    });
    expect(requester).not.toHaveBeenCalled();
    expect(toolDenials.add).toHaveBeenCalledWith(1, {
      reason: 'no_approval_channel',
    });
  });

  test('resolveUnattendedGrant returning true allows the tool (station#1859 seam)', async () => {
    const resolveUnattendedGrant = vi.fn().mockResolvedValue(true);
    const hooks = createAgentHooks(createDeps({ resolveUnattendedGrant }));
    const tool = {
      toolName: 'filesystem_write',
      toolCallId: 'tool-1',
      toolArgs: { path: 'notes.md' },
    };

    await expect(
      hooks.beforeToolCall!(tool, { agentSlug: 'planner' }),
    ).resolves.toBe(true);
    expect(resolveUnattendedGrant).toHaveBeenCalledWith(tool, {
      agentSlug: 'planner',
    });
    expect(toolDenials.add).not.toHaveBeenCalled();
  });

  test('a recorded voice grant authorizes a mutating station-control tool end-to-end', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-grant-hooks-'));
    try {
      const store = new UnattendedGrantStore(home);
      const principal = {
        kind: 'voice' as const,
        agentSlug: 'planner',
        sessionId: 'voice-session-1',
      };
      const tool = {
        toolName: 'station-control_create_project',
        toolCallId: 'tool-1',
        toolArgs: { name: 'unattended' },
      };
      const invocation = {
        agentSlug: 'planner',
        unattendedPrincipal: principal,
      };
      const resolver = makeUnattendedGrantResolver(store, {
        logger: createDeps().logger,
      });
      const hooks = createAgentHooks(
        createDeps({ resolveUnattendedGrant: resolver }),
      );

      await expect(
        hooks.beforeToolCall!(tool, invocation),
      ).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('unattended run'),
      });

      await store.grantTool(principalKey(principal), tool.toolName, 'operator');
      await expect(hooks.beforeToolCall!(tool, invocation)).resolves.toBe(true);

      await store.revokeGrant(principalKey(principal), tool.toolName);
      await expect(
        hooks.beforeToolCall!(tool, invocation),
      ).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining('unattended run'),
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a guardian enforce-deny wins over a resolver that would grant', async () => {
    const resolveUnattendedGrant = vi.fn().mockResolvedValue(true);
    const hooks = createAgentHooks(
      createDeps({
        resolveUnattendedGrant,
        approvalGuardian: {
          isEnabled: () => true,
          getMode: () => 'enforce',
          reviewToolCall: vi.fn().mockResolvedValue({
            decision: 'deny',
            reason: 'destructive operation',
          }),
        },
      }),
    );

    await expect(
      hooks.beforeToolCall!(
        {
          toolName: 'station-control_create_project',
          toolCallId: 'tool-1',
          toolArgs: {},
        },
        {
          agentSlug: 'planner',
          unattendedPrincipal: {
            kind: 'voice',
            agentSlug: 'planner',
            sessionId: 'voice-session-1',
          },
        },
      ),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('approval guardian'),
    });
    expect(resolveUnattendedGrant).not.toHaveBeenCalled();
    expect(toolDenials.add).toHaveBeenCalledWith(1, {
      reason: 'guardian_denied',
    });
  });

  test('resolveUnattendedGrant returning false denies the tool', async () => {
    const resolveUnattendedGrant = vi.fn().mockResolvedValue(false);
    const hooks = createAgentHooks(createDeps({ resolveUnattendedGrant }));

    await expect(
      hooks.beforeToolCall!(
        {
          toolName: 'filesystem_write',
          toolCallId: 'tool-1',
          toolArgs: { path: 'notes.md' },
        },
        { agentSlug: 'planner' },
      ),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('unattended run'),
    });
    expect(toolDenials.add).toHaveBeenCalledWith(1, {
      reason: 'unattended_grant_denied',
    });
  });

  test('a truthy non-true resolveUnattendedGrant return DENIES (literal-true contract)', async () => {
    // A resolver drifting from the boolean contract ({ granted: false },
    // 'deny', 1, ...) is truthy — treating it as consent would reopen the
    // fail-open hole through the seam itself.
    const resolveUnattendedGrant = vi
      .fn()
      .mockResolvedValue({ granted: false } as unknown as boolean);
    const hooks = createAgentHooks(createDeps({ resolveUnattendedGrant }));

    await expect(
      hooks.beforeToolCall!(
        {
          toolName: 'filesystem_write',
          toolCallId: 'tool-1',
          toolArgs: { path: 'notes.md' },
        },
        { agentSlug: 'planner' },
      ),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('unattended run'),
    });
    expect(toolDenials.add).toHaveBeenCalledWith(1, {
      reason: 'unattended_grant_denied',
    });
  });

  test('an absent resolveUnattendedGrant seam denies (fail-closed seam)', async () => {
    const hooks = createAgentHooks(createDeps());

    await expect(
      hooks.beforeToolCall!(
        {
          toolName: 'filesystem_write',
          toolCallId: 'tool-1',
          toolArgs: { path: 'notes.md' },
        },
        { agentSlug: 'planner' },
      ),
    ).resolves.toMatchObject({ allowed: false });
    expect(toolDenials.add).toHaveBeenCalledWith(1, {
      reason: 'no_approval_channel',
    });
  });

  // The scheduler-seam regression (real hooks + SC_READ_ONLY_TOOLS +
  // mutating station-control tool, no conversationId) is pinned END-TO-END
  // in voltagent-adapter.test.ts ('default temp agent denies ...'), which
  // builds the default-shaped temp agent through the real adapter and a
  // real model round-trip instead of modeling the caller contract here.
  // The read-only twin (SC_READ_ONLY_TOOLS still auto-approves) lives
  // there too.
});
