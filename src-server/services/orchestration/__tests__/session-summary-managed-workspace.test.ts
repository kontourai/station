import type { ProviderSession } from '@kontourai/station-contracts/provider';
import { describe, expect, test } from 'vitest';
import { buildOrchestrationSessionSummary } from '../orchestration-session-state.js';

/**
 * The session summary says when its `cwd` is a folder Station created for the
 * chat (`cwdManagedWorkspace`), so clients can name it ("Chat workspace")
 * instead of printing a hash path — and never have to match the path
 * themselves. The server's own `isManagedAcpWorkspace` decides.
 */
function summarize(cwd: string | undefined) {
  const persisted: ProviderSession = {
    provider: 'acp-test',
    threadId: 'thread-managed',
    status: 'ready',
    ...(cwd ? { cwd } : {}),
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
  };
  return buildOrchestrationSessionSummary({
    persisted,
    answerability: {
      threadAttachment: 'detached',
      providerRegistered: true,
      observedBy: 'test',
      observedAt: '2026-10-20T10:00:00.000Z',
    },
    events: [],
  });
}

const DIGEST = 'ab12'.repeat(16);

describe('cwdManagedWorkspace on the session summary', () => {
  test('a chat running in a Station-managed ACP session workspace is flagged', () => {
    const summary = summarize(
      `/Users/someone/.station/runtime/acp-workspaces/session/${DIGEST}`,
    );
    expect(summary.cwdManagedWorkspace).toBe(true);
    // The path itself still travels, for whoever needs to copy it.
    expect(summary.cwd).toContain(DIGEST);
  });

  test.each([
    ['a user folder', '/Users/someone/dev/project'],
    [
      'a folder shaped like one with a short digest',
      `/Users/someone/.station/runtime/acp-workspaces/session/${DIGEST.slice(1)}`,
    ],
    [
      'a user folder that merely mentions the layout',
      `/Users/someone/notes/acp-workspaces/session/${DIGEST}/sub`,
    ],
  ])('%s is not', (_, cwd) => {
    expect(summarize(cwd).cwdManagedWorkspace).toBeUndefined();
  });

  test('no cwd, no flag', () => {
    expect(summarize(undefined).cwdManagedWorkspace).toBeUndefined();
  });
});
