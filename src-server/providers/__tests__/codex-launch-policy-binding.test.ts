import { expect, test, vi } from 'vitest';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import {
  emit,
  FakeCodexProcess,
  flushIo,
  withTimeout,
} from './codex-adapter-wire-harness.js';

/**
 * Codex's own MCP calls never pass through Station's pre-tool policy. What
 * Station can do is restart a Codex session whose Agent or integrations
 * changed at its next turn, which needs the session's launch binding to stay
 * alive. The binding is held by the policy the adapter resolves, so it is
 * resolved and kept for every Agent session, with or without bound tools.
 */
test('a Codex Agent session without bound tools still resolves and holds its launch policy', async () => {
  const process = new FakeCodexProcess();
  const policy = vi.fn(async () => ({ behavior: 'defer' as const }));
  const resolveBoundToolPolicy = vi.fn(async () => policy);
  const adapter = new CodexAdapter({
    processFactory: () => process as never,
    boundToolsEnabled: () => false,
    resolveBoundToolPolicy,
  });
  const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
  void (async () => {
    for (;;) if ((await iterator.next()).done) return;
  })();
  const session = adapter.startSession({
    provider: 'codex',
    threadId: 'session-plain',
    cwd: '/tmp',
    agent: { slug: 'writer' } as never,
  });
  await flushIo();
  await emit(process, { id: '1', result: { userAgent: 'test' } });
  await emit(process, { id: '2', result: { thread: { id: 'native-plain' } } });
  await withTimeout(session, 'start');

  expect(resolveBoundToolPolicy).toHaveBeenCalledOnce();
  const record = (adapter as any).transport.sessions.get('session-plain');
  expect(record.launchPolicy).toBe(policy);
  // Nothing is decided by it: there are no bound tools to call.
  expect(policy).not.toHaveBeenCalled();
  await adapter.stopSession('session-plain');
});
