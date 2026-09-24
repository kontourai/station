/**
 * The publisher end to end: a real EventBus, a real pairing registry and push
 * key on a temp home, session rows folded by the real read-model builder from
 * canonical events, and a fake gateway `fetch` that runs the REAL gateway
 * verifier and request parser — so a card the deployed gateway would refuse
 * fails here, not on a phone.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { parseSendRequest } from '../../../../deploy/push-gateway/src/send-request.js';
import { verifyStationRequest } from '../../../../deploy/push-gateway/src/station-auth.js';
import { EventBus } from '../../orchestration/event-bus.js';
import { buildOrchestrationSessionSummary } from '../../orchestration/orchestration-session-state.js';
import { DevicePairingService } from '../../ssh/device-pairing-service.js';
import {
  type AgentActivitySessionRow,
  agentActivityRowFromSummary,
  resolvePushGatewayConfig,
  wireAgentActivityPublisher,
} from '../agent-activity-publisher.js';
import { PushSigningKeyStore } from '../push-signing-key-store.js';

const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const GATEWAY = resolvePushGatewayConfig({})!;
const PACKAGES = ['io.kontourai.station', 'io.kontourai.station.debug'];
const TOKEN = `fcm-token-${'a'.repeat(60)}`;
const START = Date.parse('2026-09-24T10:00:00.000Z');
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

// Content that exists in the session and must never reach a card.
const SECRETS = [
  'ASSISTANT_REPLY_SECRET',
  'TOOL_OUTPUT_SECRET',
  'REQUEST_TITLE_SECRET',
  'REQUEST_DESCRIPTION_SECRET',
  '/Users/someone/private-repo',
  'SECOND_PROMPT_SECRET',
];

function sessionEvents(
  threadId: string,
  state: 'running' | 'approval' | 'input' | 'completed',
  at: string,
): CanonicalRuntimeEvent[] {
  const base = { provider: 'claude', threadId, createdAt: at } as const;
  const events: Array<Record<string, unknown>> = [
    {
      ...base,
      eventId: `${threadId}-started`,
      method: 'session.started',
      sessionId: threadId,
      metadata: {
        projectSlug: 'login-app',
        cwd: '/Users/someone/private-repo',
      },
    },
    {
      ...base,
      eventId: `${threadId}-turn`,
      method: 'turn.started',
      turnId: 'turn-1',
      prompt: 'Fix the flaky login test',
    },
    {
      ...base,
      eventId: `${threadId}-delta`,
      method: 'content.text-delta',
      turnId: 'turn-1',
      itemId: 'item-1',
      delta: 'ASSISTANT_REPLY_SECRET',
    },
    {
      ...base,
      eventId: `${threadId}-tool`,
      method: 'tool.completed',
      turnId: 'turn-1',
      itemId: 'item-2',
      toolCallId: 'call-1',
      toolName: 'bash',
      status: 'success',
      output: 'TOOL_OUTPUT_SECRET at /Users/someone/private-repo',
    },
  ];
  if (state === 'approval' || state === 'input')
    events.push({
      ...base,
      eventId: `${threadId}-request`,
      method: 'request.opened',
      turnId: 'turn-1',
      requestId: `${threadId}-req`,
      requestType: state === 'input' ? 'input' : 'approval',
      title: 'REQUEST_TITLE_SECRET',
      description:
        'REQUEST_DESCRIPTION_SECRET rm -rf /Users/someone/private-repo',
    });
  if (state === 'completed')
    events.push({
      ...base,
      eventId: `${threadId}-done`,
      method: 'turn.completed',
      turnId: 'turn-1',
    });
  return events as unknown as CanonicalRuntimeEvent[];
}

function summaryRow(
  threadId: string,
  state: Parameters<typeof sessionEvents>[1],
  at: string,
): AgentActivitySessionRow {
  const session = {
    provider: 'claude',
    threadId,
    status: 'running',
    cwd: '/Users/someone/private-repo',
    createdAt: at,
    updatedAt: at,
  } as never;
  return agentActivityRowFromSummary(
    buildOrchestrationSessionSummary({
      loaded: session,
      persisted: session,
      events: sessionEvents(threadId, state, at),
      answerability: { answerable: true } as never,
    }),
    (slug) => (slug === 'login-app' ? 'Login App' : undefined),
  );
}

type GatewayAnswer = number | Error;

async function harness(
  options: {
    answers?: GatewayAnswer[];
    /** Answers by push token, for concurrent sends whose order is not fixed. */
    answerFor?: (token: string) => GatewayAnswer | undefined;
  } = {},
) {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-agent-activity-'));
  homes.push(homeDir);
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  const pairing = new DevicePairingService({
    homeDir,
    environmentId: ENVIRONMENT_ID,
  });
  const keys = new PushSigningKeyStore(homeDir, () => pairing.environmentId());
  const eventBus = new EventBus();
  let clock = START;
  const rows: AgentActivitySessionRow[] = [];
  const listSessions = vi.fn(async () => [...rows]);
  const answers = [...(options.answers ?? [])];
  const delivered: Array<{ data: Record<string, string>; token: string }> = [];
  const refused: string[] = [];
  const beforeAnswer: Array<() => void> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('https://push.kontourai.io/v1/fcm/send');
    const body = new Uint8Array(init.body as Buffer) as Uint8Array<ArrayBuffer>;
    const auth = await verifyStationRequest({
      authorization: new Headers(init.headers).get('authorization'),
      body,
      audiences: ['https://push.kontourai.io'],
      nowSeconds: Math.floor(clock / 1000),
    });
    if (!auth.ok) {
      refused.push(auth.reason);
      return new Response('{}', { status: 401 });
    }
    const parsed = parseSendRequest(body, PACKAGES);
    if (!parsed.ok) {
      refused.push(parsed.reason);
      return new Response('{}', { status: 400 });
    }
    for (const hook of beforeAnswer.splice(0)) hook();
    const answer =
      options.answerFor?.(parsed.request.token) ?? answers.shift() ?? 200;
    if (answer instanceof Error) throw answer;
    if (answer === 200)
      delivered.push({
        data: { ...parsed.request.data, station_key: auth.keyThumbprint },
        token: parsed.request.token,
      });
    return new Response('{}', { status: answer });
  });
  const sleeps: number[] = [];
  const warn = vi.fn();
  const publisher = wireAgentActivityPublisher({
    eventBus,
    devicePairing: pairing,
    signingKey: keys,
    listSessions,
    gateway: GATEWAY,
    logger: { warn },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    windowMs: 1,
  });
  async function pairAndRegister(
    name = 'Pixel',
    token = TOKEN,
    packageName:
      | 'io.kontourai.station'
      | 'io.kontourai.station.debug' = 'io.kontourai.station',
  ) {
    const offer = pairing.createOffer({
      endpoint: 'https://station.example.test',
    });
    const request = pairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: name,
    });
    pairing.confirmRequest(request.requestId, {
      kind: 'presented-credential',
    });
    const paired = pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
    });
    await keys.loadOrCreate();
    const registration = pairing.setNativePush(paired.device.id, {
      token,
      packageName,
      platform: 'android',
    });
    return { deviceId: paired.device.id, registration };
  }
  const emit = (method: string, threadId = 's1') =>
    eventBus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
      event: { method, threadId },
    });
  async function settle() {
    await publisher.drain();
  }
  return {
    pairing,
    keys,
    eventBus,
    rows,
    listSessions,
    fetchImpl,
    delivered,
    refused,
    sleeps,
    warn,
    publisher,
    beforeAnswer,
    pairAndRegister,
    emit,
    settle,
    advance: (ms: number) => {
      clock += ms;
    },
    setClock: (value: number) => {
      clock = value;
    },
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

describe('agent-activity publisher', () => {
  test('does nothing at all while no phone is registered', async () => {
    const h = await harness();
    h.rows.push(summaryRow('s1', 'running', iso(START)));
    h.emit('turn.started');
    await h.settle();
    expect(h.listSessions).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    await h.publisher.stop();
  });

  test('sends one gateway-valid card per registered phone, bound to that registration', async () => {
    const h = await harness();
    const first = await h.pairAndRegister('A');
    const second = await h.pairAndRegister(
      'B',
      `fcm-token-${'b'.repeat(60)}`,
      'io.kontourai.station.debug',
    );
    h.rows.push(summaryRow('s1', 'running', iso(START - 1000)));
    h.emit('turn.started');
    await h.settle();

    expect(h.refused).toEqual([]);
    expect(h.delivered).toHaveLength(2);
    const byDevice = new Map(h.delivered.map((d) => [d.data.device_id, d]));
    const a = byDevice.get(first.registration.registrationId);
    const b = byDevice.get(second.registration.registrationId);
    expect(a?.token).toBe(TOKEN);
    expect(b?.token).toBe(`fcm-token-${'b'.repeat(60)}`);
    expect(a?.data).toMatchObject({
      station_kind: 'agent_activity',
      user_id: ENVIRONMENT_ID,
      updated_at: String(START),
      active: 'true',
      activity_phase: 'running',
      activity_line_0: 'Working\tFix the flaky login test\tLogin App',
      activity_active_count: '1',
      activity_attention_count: '0',
      // Stamped by the gateway from the verified key: the value the phone pins.
      station_key: h.keys.read()?.thumbprint,
    });
    await h.publisher.stop();
  });

  test('never sends transcript, tool output, request text or paths', async () => {
    const h = await harness();
    await h.pairAndRegister();
    h.rows.push(
      summaryRow('s1', 'approval', iso(START)),
      summaryRow('s2', 'input', iso(START)),
      summaryRow('s3', 'completed', iso(START)),
    );
    h.emit('request.opened');
    await h.settle();
    expect(h.delivered).toHaveLength(1);
    const payload = JSON.stringify(h.delivered[0]?.data);
    for (const secret of SECRETS) expect(payload).not.toContain(secret);
    // It does carry what the card is for.
    expect(payload).toContain('Fix the flaky login test');
    expect(h.delivered[0]?.data.activity_attention_count).toBe('2');
    expect(h.delivered[0]?.data.alert_title).toMatch(/needed|finished/);
    await h.publisher.stop();
  });

  test('an approval request reads waiting_for_approval and raises an alert', async () => {
    const h = await harness();
    await h.pairAndRegister();
    h.rows.push(summaryRow('s1', 'approval', iso(START - 500)));
    h.emit('request.opened');
    await h.settle();
    expect(h.delivered[0]?.data).toMatchObject({
      activity_phase: 'waiting_for_approval',
      activity_line_0: 'Approval\tFix the flaky login test\tLogin App',
      alert_title: 'Approval needed',
    });
    expect(h.delivered[0]?.data.alert_id).toMatch(/^[0-9a-f]{64}$/);
    await h.publisher.stop();
  });

  test('streamed content does not trigger a read; unchanged cards are not re-sent', async () => {
    const h = await harness();
    await h.pairAndRegister();
    h.rows.push(summaryRow('s1', 'running', iso(START)));
    h.emit('content.text-delta');
    h.emit('tool.completed');
    await h.settle();
    expect(h.listSessions).not.toHaveBeenCalled();

    h.emit('turn.started');
    await h.settle();
    expect(h.delivered).toHaveLength(1);
    h.advance(1000);
    h.emit('turn.started');
    await h.settle();
    expect(h.listSessions).toHaveBeenCalledTimes(2);
    expect(h.delivered).toHaveLength(1);

    h.rows.splice(0, 1, summaryRow('s1', 'input', iso(START + 1000)));
    h.emit('request.opened');
    await h.settle();
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1]?.data.activity_phase).toBe('waiting_for_input');
    await h.publisher.stop();
  });

  test('updated_at is strictly increasing even when the clock steps back', async () => {
    const h = await harness();
    await h.pairAndRegister();
    h.rows.push(summaryRow('s1', 'running', iso(START)));
    h.emit('turn.started');
    await h.settle();
    h.setClock(START - 5_000);
    h.rows.splice(0, 1, summaryRow('s1', 'input', iso(START - 5_000)));
    h.emit('request.opened');
    await h.settle();
    const stamps = h.delivered.map((d) => Number(d.data.updated_at));
    expect(stamps).toHaveLength(2);
    expect(stamps[1]).toBeGreaterThan(stamps[0] ?? Infinity);
    await h.publisher.stop();
  });

  test('a canceled-only Station clears the card', async () => {
    const h = await harness();
    await h.pairAndRegister();
    h.rows.push(summaryRow('s1', 'running', iso(START)));
    h.emit('turn.started');
    await h.settle();
    h.rows.splice(0, 1, {
      ...summaryRow('s1', 'running', iso(START)),
      lifecycleState: 'canceled',
    });
    h.emit('turn.aborted');
    await h.settle();
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1]?.data).toMatchObject({
      active: 'false',
      activity_expires_at: String(START),
      activity_active_count: '0',
    });
    expect(h.delivered[1]?.data.activity_line_0).toBeUndefined();
    await h.publisher.stop();
  });

  test('a 410 clears that registration only', async () => {
    const h = await harness({
      answerFor: (token) => (token === TOKEN ? 410 : 200),
    });
    await h.pairAndRegister('A');
    const live = await h.pairAndRegister('B', `fcm-token-${'c'.repeat(60)}`);
    h.rows.push(summaryRow('s1', 'running', iso(START)));
    h.emit('turn.started');
    await h.settle();
    expect(
      h.pairing.listNativePushRegistrations().map((entry) => entry.deviceId),
    ).toEqual([live.deviceId]);
    expect(h.delivered.map((d) => d.token)).toEqual([
      `fcm-token-${'c'.repeat(60)}`,
    ]);
    await h.publisher.stop();
  });

  test('a 410 for an old token does not erase a registration refreshed meanwhile', async () => {
    const h = await harness({ answers: [410] });
    const { deviceId } = await h.pairAndRegister();
    const fresh = `fcm-token-${'d'.repeat(60)}`;
    h.beforeAnswer.push(() => {
      h.pairing.setNativePush(deviceId, {
        token: fresh,
        packageName: 'io.kontourai.station',
        platform: 'android',
      });
    });
    h.rows.push(summaryRow('s1', 'running', iso(START)));
    h.emit('turn.started');
    await h.settle();
    expect(h.pairing.listNativePushRegistrations()).toEqual([
      { deviceId, registration: expect.objectContaining({ token: fresh }) },
    ]);
    await h.publisher.stop();
  });

  test('503 and 429 are retried a bounded number of times, then left for the next change', async () => {
    const h = await harness({ answers: [503, 429, 503] });
    await h.pairAndRegister();
    h.rows.push(summaryRow('s1', 'running', iso(START)));
    h.emit('turn.started');
    await h.settle();
    expect(h.fetchImpl).toHaveBeenCalledTimes(3);
    expect(h.sleeps).toEqual([1000, 4000]);
    expect(h.delivered).toHaveLength(0);
    // Not recorded as delivered: the next flush sends the same card.
    h.emit('turn.started');
    await h.settle();
    expect(h.delivered).toHaveLength(1);
    await h.publisher.stop();
  });

  test('a retry that succeeds stops retrying', async () => {
    const h = await harness({ answers: [503, 200] });
    await h.pairAndRegister();
    h.rows.push(summaryRow('s1', 'running', iso(START)));
    h.emit('turn.started');
    await h.settle();
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(h.delivered).toHaveLength(1);
    await h.publisher.stop();
  });

  test('401 and 422 are not retried', async () => {
    for (const status of [401, 422]) {
      const h = await harness({ answers: [status] });
      await h.pairAndRegister();
      h.rows.push(summaryRow('s1', 'running', iso(START)));
      h.emit('turn.started');
      await h.settle();
      expect(h.fetchImpl).toHaveBeenCalledTimes(1);
      expect(h.sleeps).toEqual([]);
      expect(h.warn).toHaveBeenCalledWith(
        'agent-activity: gateway refused a card',
        { status },
      );
      await h.publisher.stop();
    }
  });

  test('the listener never throws, whatever fails underneath', async () => {
    const h = await harness({ answers: [new Error('ECONNRESET')] });
    await h.pairAndRegister();
    const subscribe = vi.spyOn(EventBus.prototype, 'subscribe');
    const bus = new EventBus();
    const failingPairing = {
      listNativePushRegistrations: () => {
        throw new Error('registry unreadable');
      },
      clearNativePush: () => {},
      environmentId: () => ENVIRONMENT_ID,
    };
    const publisher = wireAgentActivityPublisher({
      eventBus: bus,
      devicePairing: failingPairing,
      signingKey: h.keys,
      listSessions: async () => [],
      gateway: GATEWAY,
      logger: { warn: vi.fn() },
      windowMs: 1,
    });
    const listener = subscribe.mock.calls.at(-1)?.[0];
    subscribe.mockRestore();
    expect(listener).toBeTypeOf('function');
    expect(() =>
      listener?.({
        event: SERVER_EVENTS.ORCHESTRATION_EVENT,
        data: { event: { method: 'turn.started', threadId: 's1' } },
      }),
    ).not.toThrow();
    expect(() =>
      listener?.({
        event: SERVER_EVENTS.ORCHESTRATION_EVENT,
        data: undefined,
      }),
    ).not.toThrow();
    await publisher.stop();

    // Network errors and a failing session read are logged, not thrown.
    h.rows.push(summaryRow('s1', 'running', iso(START)));
    h.emit('turn.started');
    await h.settle();
    expect(h.warn).toHaveBeenCalledWith(
      'agent-activity: gateway request failed',
      { error: 'ECONNRESET' },
    );
    h.listSessions.mockRejectedValueOnce(new Error('read model down'));
    h.emit('turn.completed');
    await expect(h.settle()).resolves.toBeUndefined();
    expect(h.warn).toHaveBeenCalledWith('agent-activity: card flush failed', {
      error: 'read model down',
    });
    await h.publisher.stop();
  });

  test('a registration triggers a card without waiting for session activity', async () => {
    const h = await harness();
    h.rows.push(summaryRow('s1', 'running', iso(START)));
    await h.pairAndRegister();
    h.publisher.requestFlush();
    await h.settle();
    expect(h.delivered).toHaveLength(1);
    await h.publisher.stop();
  });

  test('hosted mode does not subscribe', () => {
    const bus = new EventBus();
    const subscribe = vi.spyOn(bus, 'subscribe');
    wireAgentActivityPublisher({
      eventBus: bus,
      devicePairing: {
        listNativePushRegistrations: () => [],
        clearNativePush: () => {},
        environmentId: () => ENVIRONMENT_ID,
      },
      signingKey: { read: () => null },
      listSessions: async () => [],
      gateway: GATEWAY,
      logger: { warn: vi.fn() },
      enabled: false,
    });
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe('resolvePushGatewayConfig', () => {
  test('defaults to the Kontour gateway', () => {
    expect(resolvePushGatewayConfig({})).toEqual({
      sendUrl: 'https://push.kontourai.io/v1/fcm/send',
      audience: 'https://push.kontourai.io',
    });
  });

  test('uses the configured origin as the audience', () => {
    expect(
      resolvePushGatewayConfig({
        STATION_PUSH_GATEWAY_URL: 'https://push.example.test/ignored/path',
      }),
    ).toEqual({
      sendUrl: 'https://push.example.test/v1/fcm/send',
      audience: 'https://push.example.test',
    });
  });

  test.each([
    'http://push.example.test',
    'not a url',
    'https://user:pass@push.example.test',
  ])('refuses %s', (value) => {
    expect(
      resolvePushGatewayConfig({ STATION_PUSH_GATEWAY_URL: value }),
    ).toBeNull();
  });
});
