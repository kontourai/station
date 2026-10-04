import { readFileSync } from 'node:fs';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type {
  InstalledSkillExperienceV1,
  SkillExperienceDefinitionV1,
  SkillExperienceSessionViewV1,
} from '@kontourai/station-contracts/skill-experience';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { sendExecutionMessageWithInventory } from '../client/execution';
import { sendExecutionMessage } from '../client/send-execution-message';
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
  test('an injected inventory reader replaces the static fetch and gates the POST', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      response({
        conversationId: 'conversation-1',
        sessionId: 'thread-1',
        providerTurnId: 'turn-1',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const opts = { headers: { 'x-test': '1' } };
    const readInventory = vi.fn().mockResolvedValue({
      executionContract: '1.0',
      experiences: [entry],
      diagnostics: [],
    });
    await expect(
      sendExecutionMessageWithInventory(
        'http://station.test',
        input,
        readInventory,
        opts,
      ),
    ).resolves.toMatchObject({ providerTurnId: 'turn-1' });
    expect(readInventory).toHaveBeenCalledWith('http://station.test', opts);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'http://station.test/api/orchestration/chat',
    ]);

    fetchMock.mockClear();
    readInventory.mockResolvedValueOnce({
      experiences: [entry],
      diagnostics: [],
    });
    await expect(
      sendExecutionMessageWithInventory(
        'http://station.test',
        input,
        readInventory,
      ),
    ).rejects.toThrow(/cannot execute/);
    expect(fetchMock).not.toHaveBeenCalled();

    readInventory.mockClear();
    const { skillExperience: _start, ...plain } = input;
    await sendExecutionMessageWithInventory(
      'http://station.test',
      plain,
      readInventory,
    );
    expect(readInventory).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
  test('refuses a history page that claims older stages without a continuation cursor', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(response({ ...session, hasMore: true })),
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
  test('binds a rich session read to the exact current invocation and preserves cursor encoding', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(session));
    vi.stubGlobal('fetch', fetchMock);
    const expectedSkillExperience = {
      identity: entry.identity,
      eventId: 'event-1',
    };
    await fetchSkillExperienceSession(
      'http://station.test',
      'thread/1',
      'older cursor',
      { expectedSkillExperience },
    );
    const requested = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requested.pathname).toBe(
      '/api/orchestration/sessions/thread%2F1/skill-experience',
    );
    expect(requested.searchParams.get('cursor')).toBe('older cursor');
    expect(
      JSON.parse(
        requested.searchParams.get('expectedSkillExperience') ?? 'null',
      ),
    ).toEqual(expectedSkillExperience);
  });
  test('preserves a structured HTTP source refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: 'The source was revoked.',
            code: 'SOURCE_REVOKED',
          }),
          { status: 409 },
        ),
      ),
    );
    await expect(
      fetchSkillExperienceSession('http://station.test', 'thread-1'),
    ).rejects.toMatchObject({
      status: 409,
      code: 'SOURCE_REVOKED',
      message: 'The source was revoked.',
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
