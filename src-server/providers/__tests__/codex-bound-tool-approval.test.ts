/**
 * Owner decision (2026-11-16): full access means Station's own bound tools
 * (the Station browser, station-control) ask nothing on Codex either, except a
 * built-in tool that changes authority, which asks a person on every call.
 *
 * Drives `approveBoundTool`, the method Codex's bound-tool handler calls for
 * each `item/tool/call`, with the real staged policy evaluator.
 */
import { describe, expect, test, vi } from 'vitest';
import { createStagedPreToolPolicyEvaluator } from '../../runtime/agents/pre-tool-policy.js';
import { NO_PERSON_INTENT } from '../../services/approvals/guardian-conversation.js';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import type { CodexSessionRecord } from '../adapters/codex-adapter-types.js';

function policy() {
  return createStagedPreToolPolicyEvaluator({
    spec: { name: 'Engine lab' },
    toolNameMapping: new Map(),
    isGranted: () => false,
    // The turn read a page: every later call takes the untrusted-content
    // permission, which no entry sets, so it would ask.
    untrustedContentPermission: async () => 'ask',
    logger: { info: vi.fn(), warn: vi.fn() },
  } as never);
}

function record(
  appliedApprovalMode?: CodexSessionRecord['appliedApprovalMode'],
): CodexSessionRecord {
  return {
    externalThreadId: 'thread-bound',
    codexThreadId: 'codex-thread-bound',
    approvedTools: new Set(),
    ...(appliedApprovalMode ? { appliedApprovalMode } : {}),
  } as unknown as CodexSessionRecord;
}

function approve(
  adapter: CodexAdapter,
  session: CodexSessionRecord,
  tool: string,
  evaluator = policy(),
) {
  const outcome = (
    adapter as unknown as {
      approveBoundTool: (...args: unknown[]) => Promise<boolean>;
    }
  ).approveBoundTool(
    session,
    'turn-1',
    tool,
    { expression: '1' },
    'rpc-1',
    { provider: 'codex', threadId: 'thread-bound', agent: { slug: 'lab' } },
    `call-${tool}`,
    evaluator,
    () => true,
  );
  let settled: boolean | undefined;
  void outcome.then((value) => {
    settled = value;
  });
  return { outcome, settled: () => settled };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('Codex bound tools under full access', () => {
  test('a Station browser call is answered without a prompt at full access', async () => {
    const adapter = new CodexAdapter({ processFactory: vi.fn() as never });
    const session = record('never');
    const call = approve(adapter, session, 'browser_evaluate');
    await flush();
    expect(call.settled()).toBe(true);
    expect(session.boundToolApprovals?.size ?? 0).toBe(0);
  });

  test('an enforce guardian defer denies the bound call when nobody can answer', async () => {
    const adapter = new CodexAdapter({ processFactory: vi.fn() as never });
    const session = record('auto');
    const evaluator = createStagedPreToolPolicyEvaluator({
      spec: { name: 'Engine lab' },
      toolNameMapping: new Map(),
      isGranted: () => false,
      approvalGuardian: {
        isEnabled: () => true,
        getMode: () => 'enforce',
        readConversation: () => NO_PERSON_INTENT,
        reviewToolCall: async () => ({
          decision: 'defer',
          reason: 'No confident verdict.',
        }),
      },
      logger: { info: vi.fn(), warn: vi.fn() },
    } as never);
    await expect(
      approve(adapter, session, 'browser_evaluate', evaluator).outcome,
    ).resolves.toBe(false);
    expect(session.boundToolApprovals?.size ?? 0).toBe(0);
  });

  test('a bound Codex approval publishes the reason only for a policy escalation', async () => {
    const adapter = new CodexAdapter({ processFactory: vi.fn() as never });
    const events = adapter.streamEvents()[Symbol.asyncIterator]();
    const session = record('never');
    const approval = approve(
      adapter,
      session,
      'browser_evaluate',
      async () => ({
        behavior: 'ask',
        required: true,
        guardianReason: 'The only-if-asked rule requires a person.',
      }),
    );
    const { value: opened } = await events.next();
    expect(opened).toMatchObject({
      method: 'request.opened',
      turnId: 'turn-1',
      guardianReason: 'The only-if-asked rule requires a person.',
      payload: { toolName: 'mcp__station-browser__browser_evaluate' },
    });
    for (const pending of session.boundToolApprovals?.values() ?? [])
      pending.resolve(false);
    await expect(approval.outcome).resolves.toBe(false);
    await events.return?.();
  });

  test('without full access the same call waits for a person', async () => {
    const adapter = new CodexAdapter({ processFactory: vi.fn() as never });
    const session = record('auto');
    const call = approve(adapter, session, 'browser_evaluate');
    await flush();
    expect(call.settled()).toBeUndefined();
    expect(session.boundToolApprovals?.size).toBe(1);
  });

  test('a tool that changes authority still waits for a person at full access', async () => {
    const adapter = new CodexAdapter({ processFactory: vi.fn() as never });
    const session = record('never');
    const call = approve(adapter, session, 'update_config');
    await flush();
    expect(call.settled()).toBeUndefined();
    expect(session.boundToolApprovals?.size).toBe(1);
  });
});
