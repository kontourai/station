// @vitest-environment jsdom
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { describe, expect, test } from 'vitest';
import { inboxContextParts } from '../inboxContext';

// Only the fields the resolver reads; the cast is the fixture boundary.
function session(
  extra: Partial<OrchestrationSessionSummary>,
): OrchestrationSessionSummary {
  return {
    threadId: 'thread-1',
    provider: 'claude',
    ...extra,
  } as OrchestrationSessionSummary;
}

const parts = (facts: Parameters<typeof inboxContextParts>[0]) =>
  Object.fromEntries(
    inboxContextParts(facts).map((part) => [part.kind, part.value]),
  );

describe('inboxContextParts', () => {
  test('names the Station, Project, chat, agent and engine a session carries', () => {
    expect(
      parts({
        title: 'Run a shell command',
        session: session({
          displayTitle: 'Notification inbox redesign',
          projectSlug: 'station',
          assignedAgentSlug: agentId('reviewer'),
          model: 'opus-5.5',
        }),
        localStationName: 'workstation',
      }),
    ).toEqual({
      station: 'workstation',
      project: 'station',
      chat: 'Notification inbox redesign',
      agent: 'reviewer',
      engine: 'Claude Code · opus-5.5',
    });
  });

  test('work delegated to another Station names that Station, not this one', () => {
    const result = parts({
      title: 'Which database?',
      session: session({
        delegation: {
          taskId: 'task-1',
          environmentKind: 'peer',
          environmentName: 'build-server',
        } as OrchestrationSessionSummary['delegation'],
      }),
      localStationName: 'workstation',
    });
    expect(result.station).toBe('build-server');
  });

  test("an item's own fields win over the session's", () => {
    const result = parts({
      title: 'Session failed',
      session: session({ projectSlug: 'from-session', provider: 'codex' }),
      projectSlug: 'from-item',
      engine: 'claude',
      agent: 'from-item-agent',
    });
    expect(result.project).toBe('from-item');
    expect(result.agent).toBe('from-item-agent');
    expect(result.engine).toBe('Claude Code');
  });

  test('a chat title that repeats the row headline is not said twice', () => {
    const result = parts({
      title: 'Fix the login redirect',
      session: session({ displayTitle: 'Fix the login redirect' }),
    });
    expect(result.chat).toBeUndefined();
  });

  test('a row naming no work claims no Station, and nothing is guessed', () => {
    expect(
      inboxContextParts({
        title: 'Nightly backup finished',
        localStationName: 'workstation',
      }),
    ).toEqual([]);
  });
});

test('an agent named for its engine is not repeated beside it', () => {
  const result = parts({
    title: 'Session failed',
    engine: 'codex',
    agent: 'codex',
  });
  expect(result.agent).toBeUndefined();
  expect(result.engine).toBe('Codex');
});

test('remote work with no Station name still reads as remote, never as this one', () => {
  const result = parts({
    title: 'Which database?',
    session: session({
      delegation: {
        taskId: 'task-1',
        environmentKind: 'peer',
        environmentId: 'env-1',
      } as OrchestrationSessionSummary['delegation'],
    }),
    localStationName: 'workstation',
  });
  expect(result.station).toBe('Another Station');
});
