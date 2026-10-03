import { readFileSync } from 'node:fs';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type {
  InstalledSkillExperienceV1,
  SkillExperienceDefinitionV1,
  SkillExperienceSessionViewV1,
} from '@kontourai/station-contracts/skill-experience';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { sendExecutionMessage } from '../client/execution';
import {
  fetchSkillExperienceInventory,
  fetchSkillExperienceSession,
} from '../client/skill-experiences';

const definition: SkillExperienceDefinitionV1 = JSON.parse(
  readFileSync(
    new URL(
      '../../../../examples/visual-skill-experience/io.kontourai.station/experiences/stress-test-idea.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const entry: InstalledSkillExperienceV1 = {
  definition,
  identity: {
    pluginId: 'example',
    pluginVersion: '1.0.0',
    experienceId: definition.id,
    incarnation: 'installed-1',
    materialization: 'materialization-1',
    contentDigest: 'digest-1',
    definitionDigest: 'definition-1',
  },
};
const start = { identity: entry.identity, inputs: { idea: 'A useful idea' } };
const input = {
  message: 'Start',
  target: {
    environment: { kind: 'current' as const },
    agent: agentId('station'),
  },
  skillExperience: start,
};
const response = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), { status: 200 });
const session: SkillExperienceSessionViewV1 = {
  current: {
    eventId: 'event-1',
    threadId: 'thread-1',
    snapshot: {
      version: '1.0',
      identity: entry.identity,
      definition,
      inputs: start.inputs,
      clientTurnId: 'turn-1',
      questionnaireDelivery: 'canonical-request',
    },
    availability: { status: 'available' },
  },
  history: [],
  hasMore: false,
};

describe('visual skill HTTP boundary', () => {
  afterEach(() => vi.unstubAllGlobals());
  test('preflights current source and carries the source-bound start only through foreground chat', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          executionContract: '1.0',
          experiences: [entry],
          diagnostics: [],
        }),
      )
      .mockResolvedValueOnce(
        response({
          conversationId: 'conversation-1',
          sessionId: 'thread-1',
          providerTurnId: 'turn-1',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      sendExecutionMessage('http://station.test', input),
    ).resolves.toMatchObject({ providerTurnId: 'turn-1' });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'http://station.test/api/skills/experiences',
      'http://station.test/api/orchestration/chat',
    ]);
    expect(
      JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).skillExperience,
    ).toEqual(start);
  });
  test.each([
    [
      'inventory-only host',
      { experiences: [entry], diagnostics: [] },
      /cannot execute/,
    ],
    [
      'changed source',
      {
        executionContract: '1.0',
        experiences: [
          {
            ...entry,
            identity: { ...entry.identity, incarnation: 'replacement' },
          },
        ],
        diagnostics: [],
      },
      /changed or is unavailable/,
    ],
  ])('refuses %s before a POST', async (_name, inventory, expected) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(inventory))
      .mockResolvedValue(
        response({
          conversationId: 'unexpected-conversation',
          sessionId: 'unexpected-session',
          providerTurnId: 'unexpected-turn',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      sendExecutionMessage('http://station.test', input),
    ).rejects.toThrow(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
  });
  test('background replay cannot acquire a visual skill start', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      sendExecutionMessage('http://station.test', {
        ...input,
        automaticBackground: true,
      }),
    ).rejects.toThrow(/foreground/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test.each([
    [
      'invalid definition',
      {
        experiences: [
          { ...entry, definition: { ...definition, schemaVersion: '2.0' } },
        ],
        diagnostics: [],
      },
    ],
    [
      'unknown execution contract',
      { executionContract: '2.0', experiences: [entry], diagnostics: [] },
    ],
  ])('rejects %s inventory', async (_name, inventory) => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(response(inventory)),
    );
    await expect(
      fetchSkillExperienceInventory('http://station.test'),
    ).rejects.toThrow(/unsupported/);
  });
  test.each([
    [
      'malformed reference',
      {
        ...session.current,
        reference: { version: '1.0', identity: entry.identity },
      },
    ],
    [
      'snapshot identity mismatch',
      {
        ...session.current,
        snapshot: {
          ...session.current?.snapshot,
          identity: { ...entry.identity, experienceId: 'another' },
        },
      },
    ],
    [
      'unavailable snapshot disguised as available',
      { ...session.current, snapshot: null },
    ],
  ])('rejects %s session projection', async (_name, current) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(response({ ...session, current })),
    );
    await expect(
      fetchSkillExperienceSession('http://station.test', 'thread-1'),
    ).rejects.toThrow(/unsupported/);
  });
  test('reads historical missing snapshots without treating them as execution authority', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        response({
          ...session,
          history: [
            {
              eventId: 'old-event',
              threadId: 'thread-1',
              snapshot: null,
              availability: { status: 'snapshot-unavailable' },
            },
          ],
          hasMore: true,
          nextCursor: 'older cursor',
        }),
      ),
    );
    await expect(
      fetchSkillExperienceSession('http://station.test', 'thread-1'),
    ).resolves.toMatchObject({
      current: session.current,
      hasMore: true,
      nextCursor: 'older cursor',
    });
  });
  test('retains HTTP denial detail even when the body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('Forbidden', { status: 403 })),
    );
    await expect(
      fetchSkillExperienceInventory('http://station.test'),
    ).rejects.toThrow(/403/);
  });
});
