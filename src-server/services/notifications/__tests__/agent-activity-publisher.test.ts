/**
 * The publisher end to end: a real EventBus, a real pairing registry, push
 * key and registration store on a temp home, session rows folded by the real
 * read-model builder from canonical events (entry identity included), and a
 * fake gateway `fetch` that runs the REAL gateway verifier and request
 * parser and then opens the sealed card the way the phone does — so a card
 * the deployed gateway would refuse, or a phone could not open, fails here.
 */
import { createDecipheriv } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_PUSH_SEALED_AAD_PREFIX } from '@kontourai/station-contracts/native-push';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { parseSendRequest } from '../../../../deploy/push-gateway/src/send-request.js';
import { verifyStationRequest } from '../../../../deploy/push-gateway/src/station-auth.js';
import { createAgentActivitySessionReader } from '../../../runtime/routes/agent-activity-session-reader.js';
import { EventBus } from '../../orchestration/event-bus.js';
import { buildOrchestrationSessionSummary } from '../../orchestration/orchestration-session-state.js';
import { DevicePairingService } from '../../ssh/device-pairing-service.js';
import { agentActivityEntryId } from '../agent-activity-card.js';
import {
  type AgentActivitySessionRow,
  agentActivityRowFromSummary,
  agentActivityRowsWithEntries,
  resolvePushGatewayConfig,
  wireAgentActivityPublisher,
} from '../agent-activity-publisher.js';
import type { NativePushRegistration } from '../native-push-registration-store.js';
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

type SessionState = 'running' | 'approval' | 'input' | 'completed';

let eventCounter = 0;
function ev(
  threadId: string,
  at: number,
  fields: Record<string, unknown>,
): CanonicalRuntimeEvent {
  eventCounter += 1;
  return {
    provider: 'claude',
    threadId,
    createdAt: new Date(at).toISOString(),
    eventId: `${threadId}-${eventCounter}`,
    ...fields,
  } as unknown as CanonicalRuntimeEvent;
}

/** A realistic event log: two prompts, output, a tool, then `state`. */
function sessionEvents(
  threadId: string,
  state: SessionState,
  at: number,
): CanonicalRuntimeEvent[] {
  const events = [
    ev(threadId, at - 5000, {
      method: 'session.started',
      sessionId: threadId,
      metadata: {
        projectSlug: 'login-app',
        cwd: '/Users/someone/private-repo',
      },
    }),
    ev(threadId, at - 4000, {
      method: 'turn.started',
      turnId: 'turn-1',
      prompt: 'Fix the flaky login test',
    }),
    ev(threadId, at - 3500, {
      method: 'content.text-delta',
      turnId: 'turn-1',
      itemId: 'item-1',
      delta: 'ASSISTANT_REPLY_SECRET',
    }),
    ev(threadId, at - 3000, {
      method: 'turn.completed',
      turnId: 'turn-1',
    }),
    // The second message must never become the title or reach the card.
    ev(threadId, at - 2000, {
      method: 'turn.started',
      turnId: 'turn-2',
      prompt: 'SECOND_PROMPT_SECRET please also rotate the keys',
    }),
    ev(threadId, at - 1500, {
      method: 'tool.completed',
      turnId: 'turn-2',
      itemId: 'item-2',
      toolCallId: 'call-1',
      toolName: 'bash',
      status: 'success',
      output: 'TOOL_OUTPUT_SECRET at /Users/someone/private-repo',
    }),
  ];
  if (state === 'approval' || state === 'input')
    events.push(openRequest(threadId, `${threadId}-req`, state, at));
  if (state === 'completed')
    events.push(
      ev(threadId, at, { method: 'turn.completed', turnId: 'turn-2' }),
    );
  return events;
}

function openRequest(
  threadId: string,
  requestId: string,
  kind: 'approval' | 'input',
  at: number,
) {
  return ev(threadId, at, {
    method: 'request.opened',
    turnId: 'turn-2',
    requestId,
    requestType: kind,
    title: 'REQUEST_TITLE_SECRET',
    description:
      'REQUEST_DESCRIPTION_SECRET rm -rf /Users/someone/private-repo',
  });
}

/** The read model's session summaries, folded by the real builder. */
function readSummaries(sessions: Map<string, CanonicalRuntimeEvent[]>) {
  return [...sessions].map(([threadId, events]) => {
    const session = {
      provider: 'claude',
      threadId,
      status: 'running',
      cwd: '/Users/someone/private-repo',
      createdAt: events[0]?.createdAt,
      updatedAt: events.at(-1)?.createdAt,
    } as never;
    return buildOrchestrationSessionSummary({
      loaded: session,
      persisted: session,
      events,
      answerability: { answerable: true } as never,
    });
  });
}

/** Folds sessions exactly as the runtime wiring does. */
function readRows(sessions: Map<string, CanonicalRuntimeEvent[]>) {
  const rows = readSummaries(sessions).map((summary) =>
    agentActivityRowFromSummary(summary, (slug) =>
      slug === 'login-app' ? 'Login App' : undefined,
    ),
  );
  return agentActivityRowsWithEntries(
    rows,
    (ids) => new Map(ids.map((id) => [id, sessions.get(id) ?? []])),
  );
}

/** The runtime's reader (runtime-route-support.ts) over a pairing registry. */
function pairingReader(
  pairing: () => DevicePairingService,
  sessions: Map<string, CanonicalRuntimeEvent[]>,
) {
  return createAgentActivitySessionReader({
    listDevices: () => pairing().listDevices(),
    listSessionReadModel: async () => readSummaries(sessions),
    listProjectionEvents: (ids) =>
      new Map(ids.map((id) => [id, sessions.get(id) ?? []])),
    projectNames: () => new Map([['login-app', 'Login App']]),
  });
}

type GatewayAnswer = number | Error;

interface Delivered {
  token: string;
  data: Record<string, string>;
  card: Record<string, string>;
}

async function harness(
  options: {
    answers?: GatewayAnswer[];
    answerFor?: (token: string) => GatewayAnswer | undefined;
    /** Per-device reading principal; default: every device reads everything. */
    principalFor?: (
      deviceId: string,
    ) => { principalId: string; sessionIds: string[] } | null;
    /** Principals whose session read throws. */
    failingPrincipals?: Set<string>;
    /**
     * Read through the runtime's own reader over this pairing registry, so a
     * device's stored scope decides whether it may read, as in production.
     */
    readerFromPairing?: boolean;
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
  const sessions = new Map<string, CanonicalRuntimeEvent[]>();
  const listSessions = vi.fn(async () => readRows(sessions));
  const answers = [...(options.answers ?? [])];
  const delivered: Delivered[] = [];
  const refused: string[] = [];
  const beforeAnswer: Array<() => void> = [];
  const fetchInits: RequestInit[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    fetchInits.push(init);
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
    if (answer === 200) {
      const { data } = parsed.request;
      const registration = registrationFor(data.device_id ?? '');
      delivered.push({
        token: parsed.request.token,
        data: { ...data, station_key: auth.keyThumbprint },
        card: openCard(data.sealed ?? '', registration),
      });
    }
    return new Response('{}', { status: answer });
  });
  const registered = new Map<string, NativePushRegistration>();
  function registrationFor(registrationId: string) {
    const found = registered.get(registrationId);
    if (!found) throw new Error('card for an unknown registration');
    return found;
  }
  const timers: Array<{ fn: () => void; at: number; live: boolean }> = [];
  const warn = vi.fn();
  const publisher = wireAgentActivityPublisher({
    eventBus,
    devicePairing: pairing,
    signingKey: keys,
    sessionReaderFor: (deviceId) => {
      if (options.readerFromPairing)
        return pairingReader(() => pairing, sessions)(deviceId);
      if (!options.principalFor) return { principalId: 'reader', listSessions };
      const reader = options.principalFor(deviceId);
      if (!reader) return null;
      return {
        principalId: reader.principalId,
        listSessions: async () => {
          if (options.failingPrincipals?.has(reader.principalId))
            throw new Error(`read failed for ${reader.principalId}`);
          return (await listSessions()).filter((row) =>
            reader.sessionIds.includes(row.sessionId),
          );
        },
      };
    },
    gateway: GATEWAY,
    logger: { warn },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => clock,
    windowMs: 1,
    setTimer: (fn, delayMs) => {
      const timer = { fn, at: clock + delayMs, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
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
    const key = await keys.loadOrCreate();
    const registration = pairing.setNativePush(
      paired.device.id,
      { token, packageName, platform: 'android' },
      key.thumbprint,
    );
    registered.set(registration.registrationId, registration);
    return { deviceId: paired.device.id, registration };
  }
  const emit = (method: string, threadId = 's1') =>
    eventBus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
      event: { method, threadId },
    });
  const liveTimers = () => timers.filter((timer) => timer.live);
  return {
    homeDir,
    pairing,
    keys,
    eventBus,
    sessions,
    listSessions,
    fetchImpl,
    fetchInits,
    delivered,
    refused,
    warn,
    publisher,
    beforeAnswer,
    registered,
    pairAndRegister,
    emit,
    settle: () => publisher.drain(),
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    liveTimers,
    /** Moves the clock to the next timer and runs it. */
    async fireNextTimer() {
      const next = liveTimers().sort((a, b) => a.at - b.at)[0];
      if (!next) throw new Error('no timer armed');
      clock = Math.max(clock, next.at);
      next.live = false;
      next.fn();
      await publisher.drain();
      return next;
    },
  };
}

/** Opens a sealed card as the phone does. */
function openCard(sealed: string, registration: NativePushRegistration) {
  const bytes = Buffer.from(sealed, 'base64url');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(registration.payloadKey, 'base64url'),
    bytes.subarray(0, 12),
  );
  decipher.setAAD(
    Buffer.from(
      `${NATIVE_PUSH_SEALED_AAD_PREFIX}${registration.registrationId}`,
      'utf8',
    ),
  );
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.length - 16)),
      decipher.final(),
    ]).toString('utf8'),
  ) as Record<string, string>;
}

describe('agent-activity publisher', () => {
  test('does nothing at all while no phone is registered', async () => {
    const h = await harness();
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    h.emit('turn.started');
    await h.settle();
    // The boot timer finds no registration either.
    await h.fireNextTimer();
    expect(h.listSessions).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    await h.publisher.stop();
  });

  test('seals one card per phone: only routing data travels in clear', async () => {
    const h = await harness();
    const first = await h.pairAndRegister('A');
    const second = await h.pairAndRegister(
      'B',
      `fcm-token-${'b'.repeat(60)}`,
      'io.kontourai.station.debug',
    );
    h.sessions.set('s1', sessionEvents('s1', 'running', START - 1000));
    h.emit('turn.started');
    await h.settle();

    expect(h.refused).toEqual([]);
    expect(h.delivered).toHaveLength(2);
    for (const delivery of h.delivered)
      expect(Object.keys(delivery.data).sort()).toEqual([
        'device_id',
        'sealed',
        'station_key',
        'station_kind',
      ]);
    const byDevice = new Map(h.delivered.map((d) => [d.data.device_id, d]));
    const a = byDevice.get(first.registration.registrationId);
    expect(byDevice.get(second.registration.registrationId)).toBeDefined();
    expect(a?.token).toBe(TOKEN);
    expect(a?.data).toMatchObject({
      station_kind: 'agent_activity',
      // Stamped by the gateway from the verified key: the value the phone pins.
      station_key: h.keys.read()?.thumbprint,
    });
    expect(a?.card).toMatchObject({
      user_id: ENVIRONMENT_ID,
      updated_at: String(START),
      active: 'true',
      activity_phase: 'running',
      activity_line_0: 'Working\tFix the flaky login test\tLogin App',
      activity_active_count: '1',
      activity_attention_count: '0',
    });
    expect(a?.card.station_kind).toBeUndefined();
    expect(a?.card.device_id).toBeUndefined();
    // Each phone's card is sealed under its own key.
    expect(() => openCard(a?.data.sealed ?? '', second.registration)).toThrow();
    // Redirects are refused, never followed with the token.
    expect(h.fetchInits.every((init) => init.redirect === 'error')).toBe(true);
    await h.publisher.stop();
  });

  test('never sends transcript, later prompts, tool output, request text or paths — sealed or in clear', async () => {
    const h = await harness();
    await h.pairAndRegister();
    h.sessions.set('s1', sessionEvents('s1', 'approval', START));
    h.sessions.set('s2', sessionEvents('s2', 'input', START));
    h.sessions.set('s3', sessionEvents('s3', 'completed', START));
    h.emit('request.opened');
    await h.settle();
    expect(h.delivered).toHaveLength(1);
    const card = JSON.stringify(h.delivered[0]?.card);
    const clear = JSON.stringify(h.delivered[0]?.data);
    for (const secret of SECRETS) {
      expect(card).not.toContain(secret);
      expect(clear).not.toContain(secret);
    }
    // The title is the FIRST prompt, even though a later one exists.
    expect(card).toContain('Fix the flaky login test');
    expect(clear).not.toContain('Fix the flaky login test');
    expect(h.delivered[0]?.card.activity_attention_count).toBe('2');
    await h.publisher.stop();
  });

  test('a second approval on the same session alerts again, even inside one coalescing window', async () => {
    const h = await harness();
    await h.pairAndRegister();
    const events = sessionEvents('s1', 'running', START);
    events.push(openRequest('s1', 'req-A', 'approval', START + 100));
    h.sessions.set('s1', events);
    h.emit('request.opened');
    await h.settle();
    expect(h.delivered[0]?.card.alert_id).toBe(
      agentActivityEntryId({
        stationId: ENVIRONMENT_ID,
        sessionId: 's1',
        phase: 'waiting_for_approval',
        entryKey: 'request:req-A',
      }),
    );

    // A is answered and B opens before the publisher looks again: the
    // session never leaves waiting_for_approval as far as it can see.
    h.advance(5000);
    events.push(
      ev('s1', START + 4000, {
        method: 'request.resolved',
        requestId: 'req-A',
        status: 'approved',
      }),
      openRequest('s1', 'req-B', 'approval', START + 4500),
    );
    h.emit('request.resolved');
    h.emit('request.opened');
    await h.settle();
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1]?.card.alert_id).toBe(
      agentActivityEntryId({
        stationId: ENVIRONMENT_ID,
        sessionId: 's1',
        phase: 'waiting_for_approval',
        entryKey: 'request:req-B',
      }),
    );
    expect(h.delivered[1]?.card.alert_title).toBe('Approval needed');
    await h.publisher.stop();
  });

  test('several new alerts in one flush arrive as one grouped alert, raised once', async () => {
    const h = await harness();
    h.sessions.set('s1', sessionEvents('s1', 'approval', START));
    h.sessions.set('s2', sessionEvents('s2', 'input', START - 10));
    await h.pairAndRegister();
    h.publisher.requestFlush();
    await h.settle();
    expect(h.delivered[0]?.card.alert_title).toBe('2 agents need you');
    expect(h.delivered[0]?.card.alert_body?.split('\n')).toHaveLength(2);

    // A card change without a new entry carries no alert at all.
    h.advance(5000);
    h.sessions.set('s3', sessionEvents('s3', 'running', START + 4000));
    h.emit('turn.started', 's3');
    await h.settle();
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1]?.card.alert_id).toBeUndefined();
    await h.publisher.stop();
  });

  test('streamed content does not trigger a read; unchanged cards are not re-sent', async () => {
    const h = await harness();
    await h.pairAndRegister();
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    h.emit('content.text-delta');
    h.emit('tool.completed');
    await h.settle();
    expect(h.listSessions).not.toHaveBeenCalled();

    h.emit('turn.started');
    await h.settle();
    expect(h.delivered).toHaveLength(1);
    h.advance(5000);
    h.emit('turn.started');
    await h.settle();
    expect(h.listSessions).toHaveBeenCalledTimes(2);
    expect(h.delivered).toHaveLength(1);
    await h.publisher.stop();
  });

  test('updated_at is strictly increasing across sends', async () => {
    const h = await harness();
    await h.pairAndRegister();
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    h.emit('turn.started');
    await h.settle();
    h.advance(4000);
    h.sessions.set('s1', sessionEvents('s1', 'input', START + 4000));
    h.emit('request.opened');
    await h.settle();
    const stamps = h.delivered.map((d) => Number(d.card.updated_at));
    expect(stamps).toHaveLength(2);
    expect(stamps[1]).toBeGreaterThan(stamps[0] ?? Infinity);
    await h.publisher.stop();
  });

  test('a canceled-only Station clears the card', async () => {
    const h = await harness();
    await h.pairAndRegister();
    const events = sessionEvents('s1', 'running', START);
    h.sessions.set('s1', events);
    h.emit('turn.started');
    await h.settle();
    h.advance(5000);
    events.push(
      ev('s1', START + 4000, { method: 'turn.aborted', turnId: 'turn-2' }),
    );
    h.emit('turn.aborted');
    await h.settle();
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1]?.card).toMatchObject({
      active: 'false',
      activity_expires_at: String(START + 5000),
      activity_active_count: '0',
    });
    expect(h.delivered[1]?.card.activity_line_0).toBeUndefined();
    await h.publisher.stop();
  });

  test('a 410 clears that registration only', async () => {
    const h = await harness({
      answerFor: (token) => (token === TOKEN ? 410 : 200),
    });
    await h.pairAndRegister('A');
    const live = await h.pairAndRegister('B', `fcm-token-${'c'.repeat(60)}`);
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    h.emit('turn.started');
    await h.settle();
    expect(
      h.pairing.listNativePushRegistrations().map((entry) => entry.deviceId),
    ).toEqual([live.deviceId]);
    await h.publisher.stop();
  });

  test('a 410 for an old token does not erase a registration refreshed meanwhile', async () => {
    const h = await harness({ answers: [410] });
    const { deviceId, registration } = await h.pairAndRegister();
    const fresh = `fcm-token-${'d'.repeat(60)}`;
    h.beforeAnswer.push(() => {
      h.pairing.setNativePush(
        deviceId,
        {
          token: fresh,
          packageName: 'io.kontourai.station',
          platform: 'android',
        },
        registration.stationKey,
      );
    });
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    h.emit('turn.started');
    await h.settle();
    expect(h.pairing.listNativePushRegistrations()).toEqual([
      { deviceId, registration: expect.objectContaining({ token: fresh }) },
    ]);
    await h.publisher.stop();
  });

  test('503 and 429 wait for the timer with backoff instead of retrying at once, and a waiting alert is not lost', async () => {
    const h = await harness({ answers: [503, 429] });
    await h.pairAndRegister();
    h.sessions.set('s1', sessionEvents('s1', 'approval', START));
    h.emit('request.opened');
    await h.settle();
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);

    const retry = await h.fireNextTimer();
    expect(retry.at).toBe(START + 5000);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    const second = await h.fireNextTimer();
    expect(second.at).toBe(START + 5000 + 15_000);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.card.alert_title).toBe('Approval needed');
    await h.publisher.stop();
  });

  test('timed retries are bounded', async () => {
    const h = await harness({ answers: Array(20).fill(503) });
    await h.pairAndRegister();
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    h.emit('turn.started');
    await h.settle();
    let fired = 0;
    while (
      h.liveTimers().some((timer) => timer.at <= h.now() + 10 * 60_000) &&
      fired < 50
    ) {
      await h.fireNextTimer();
      fired += 1;
    }
    expect(h.fetchImpl).toHaveBeenCalledTimes(9);
    await h.publisher.stop();
  });

  test('never sends to one phone more often than every three seconds; the change is coalesced', async () => {
    const h = await harness();
    await h.pairAndRegister();
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    h.emit('turn.started');
    await h.settle();
    h.advance(1000);
    h.sessions.set('s1', sessionEvents('s1', 'input', START + 1000));
    h.emit('request.opened');
    await h.settle();
    expect(h.delivered).toHaveLength(1);
    const deferred = await h.fireNextTimer();
    expect(deferred.at).toBe(START + 3000);
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1]?.card.activity_phase).toBe('waiting_for_input');
    await h.publisher.stop();
  });

  test('a live card is re-sent before the phone would expire it', async () => {
    const h = await harness();
    await h.pairAndRegister();
    h.sessions.set('s1', sessionEvents('s1', 'approval', START));
    h.emit('request.opened');
    await h.settle();
    expect(h.delivered[0]?.card.activity_expires_at).toBe(
      String(START + 2 * 3_600_000),
    );
    const refresh = await h.fireNextTimer();
    expect(refresh.at).toBe(START + 90 * 60_000);
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1]?.card.activity_expires_at).toBe(
      String(START + 90 * 60_000 + 2 * 3_600_000),
    );
    // The alert was already delivered; a refresh does not raise it again.
    expect(h.delivered[1]?.card.alert_id).toBeUndefined();
    await h.publisher.stop();
  });

  test('flushes once at boot when phones are registered', async () => {
    const earlier = await harness();
    await earlier.pairAndRegister();
    const boot = earlier.liveTimers()[0];
    expect(boot?.at).toBe(START + 5000);
    earlier.sessions.set('s1', sessionEvents('s1', 'running', START));
    await earlier.fireNextTimer();
    expect(earlier.delivered).toHaveLength(1);
    await earlier.publisher.stop();
    expect(earlier.liveTimers()).toEqual([]);
  });

  test('a registration pinned to a previous push key is dropped, not sent to', async () => {
    const h = await harness();
    const { deviceId, registration } = await h.pairAndRegister();
    h.pairing.setNativePush(
      deviceId,
      {
        token: registration.token,
        packageName: 'io.kontourai.station',
        platform: 'android',
      },
      'Z'.repeat(43),
    );
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    h.emit('turn.started');
    await h.settle();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.pairing.listNativePushRegistrations()).toEqual([]);
    expect(h.warn).toHaveBeenCalledWith(
      'agent-activity: dropped a registration pinned to a previous push key',
    );
    await h.publisher.stop();
  });

  test('an unreadable push key fails closed and is logged once, not per flush', async () => {
    const h = await harness();
    await h.pairAndRegister();
    const read = vi.spyOn(h.keys, 'read').mockImplementation(() => {
      throw new Error('key_store_invalid');
    });
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    h.emit('turn.started');
    await h.settle();
    h.advance(5000);
    h.emit('turn.completed');
    await h.settle();
    expect(read).toHaveBeenCalledTimes(2);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(
      h.warn.mock.calls.filter(([message]) =>
        String(message).includes('push signing key file is unreadable'),
      ),
    ).toHaveLength(1);
    await h.publisher.stop();
  });

  test('a change that reverts inside the send interval leaves no retry timer spinning', async () => {
    const h = await harness();
    await h.pairAndRegister();
    const events = sessionEvents('s1', 'running', START);
    h.sessions.set('s1', events);
    h.emit('turn.started');
    await h.settle();
    // An approval opens (held back by the 3 s interval)…
    h.advance(1000);
    events.push(openRequest('s1', 'req-A', 'approval', START + 1000));
    h.emit('request.opened');
    await h.settle();
    // …and is answered before the interval ends: the card is back to what
    // the phone already has.
    h.advance(1000);
    events.push(
      ev('s1', START + 2000, {
        method: 'request.resolved',
        requestId: 'req-A',
        status: 'approved',
      }),
    );
    h.emit('request.resolved');
    await h.settle();
    const readsBefore = h.listSessions.mock.calls.length;
    let fired = 0;
    while (
      h.liveTimers().some((timer) => timer.at <= START + 2 * 3_600_000) &&
      fired < 100
    ) {
      await h.fireNextTimer();
      fired += 1;
    }
    // Over two simulated hours: the deferred wake, then the one refresh of
    // the live card — not a flush a second.
    expect(fired).toBeLessThanOrEqual(3);
    expect(h.listSessions.mock.calls.length - readsBefore).toBeLessThanOrEqual(
      3,
    );
    await h.publisher.stop();
  });

  test('a finished card whose change reverts arms no timer at all', async () => {
    const h = await harness();
    await h.pairAndRegister();
    h.sessions.set('s1', sessionEvents('s1', 'completed', START - 60_000));
    h.emit('turn.completed');
    await h.settle();
    expect(h.delivered).toHaveLength(1);
    h.advance(1000);
    const briefly = sessionEvents('s2', 'running', START + 1000);
    h.sessions.set('s2', briefly);
    h.emit('turn.started', 's2');
    await h.settle();
    h.advance(1000);
    h.sessions.delete('s2');
    h.emit('turn.aborted', 's2');
    await h.settle();
    let fired = 0;
    while (h.liveTimers().length > 0 && fired < 100) {
      await h.fireNextTimer();
      fired += 1;
    }
    expect(fired).toBeLessThanOrEqual(1);
    expect(h.delivered).toHaveLength(1);
    await h.publisher.stop();
  });

  test('a later failure is a new entry, not the earlier failure it follows', async () => {
    const h = await harness();
    await h.pairAndRegister();
    const events = sessionEvents('s1', 'running', START);
    events.push(
      ev('s1', START, {
        method: 'runtime.error',
        turnId: 'turn-2',
        message: 'first failure',
      }),
    );
    h.sessions.set('s1', events);
    h.emit('runtime.error');
    await h.settle();
    const firstAlert = h.delivered[0]?.card.alert_id;
    expect(h.delivered[0]?.card.alert_title).toBe('Agent failed');

    // An hour later a new turn runs and fails through a state change, with
    // no runtime.error of its own.
    h.advance(60 * 60_000);
    events.push(
      ev('s1', START + 60 * 60_000, {
        method: 'turn.started',
        turnId: 'turn-3',
        prompt: 'try again',
      }),
      ev('s1', START + 60 * 60_000 + 500, {
        method: 'session.state-changed',
        from: 'running',
        to: 'errored',
      }),
    );
    h.emit('session.state-changed');
    await h.settle();
    const latest = h.delivered.at(-1)?.card;
    expect(latest?.activity_line_0).toBe(
      'Failed\tFix the flaky login test\tLogin App',
    );
    expect(latest?.alert_title).toBe('Agent failed');
    expect(latest?.alert_id).not.toBe(firstAlert);
    await h.publisher.stop();
  });

  test('a terminal event from before the latest turn is not this outcome’s entry', () => {
    const events = [
      ev('s1', START, {
        method: 'runtime.error',
        turnId: 'turn-1',
        message: 'earlier failure',
      }),
      ev('s1', START + 60 * 60_000, {
        method: 'turn.started',
        turnId: 'turn-2',
        prompt: 'try again',
      }),
    ];
    const [row] = agentActivityRowsWithEntries(
      [
        {
          sessionId: 's1',
          lifecycleState: 'failed',
          status: 'running',
          isLoaded: true,
        },
      ],
      () => new Map([['s1', events]]),
    );
    // No terminal event of this run: the publisher falls back to the time it
    // observes the failure, rather than dating it an hour back.
    expect(row?.entry).toBeUndefined();
  });

  test('an entry event older than the phase already observed is not trusted', async () => {
    const h = await harness();
    const { registration } = await h.pairAndRegister();
    const cards: Array<Record<string, string>> = [];
    let clock = START;
    let rows: AgentActivitySessionRow[] = [];
    const publisher = wireAgentActivityPublisher({
      eventBus: new EventBus(),
      devicePairing: h.pairing,
      signingKey: h.keys,
      sessionReaderFor: () => ({
        principalId: 'reader',
        listSessions: async () => rows,
      }),
      gateway: GATEWAY,
      logger: { warn: vi.fn() },
      now: () => clock,
      windowMs: 1,
      setTimer: () => () => {},
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(Buffer.from(init.body as Buffer)));
        cards.push(openCard(body.data.sealed, registration));
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    const base = {
      sessionId: 's1',
      title: 'Fix the flaky login test',
      project: 'Login App',
      status: 'running' as const,
      isLoaded: true,
      hasActiveTurn: true,
    };
    rows = [
      {
        ...base,
        lifecycleState: 'running',
        entry: { key: 'turn:2', at: START },
      },
    ];
    publisher.requestFlush();
    await publisher.drain();
    // The session fails; the only terminal event the log offers is from long
    // before the run this publisher watched start.
    clock = START + 60_000;
    rows = [
      {
        ...base,
        lifecycleState: 'failed',
        entry: { key: 'event:old', at: START - 60 * 60_000 },
      },
    ];
    publisher.requestFlush();
    await publisher.drain();
    expect(cards.at(-1)?.activity_line_0).toBe(
      'Failed\tFix the flaky login test\tLogin App',
    );
    expect(cards.at(-1)?.alert_title).toBe('Agent failed');
    await publisher.stop();
    await h.publisher.stop();
  });

  test('a grouped alert is not raised again after a restart or a token rotation', async () => {
    const h = await harness();
    h.sessions.set('s1', sessionEvents('s1', 'approval', START));
    h.sessions.set('s2', sessionEvents('s2', 'input', START - 10));
    const { deviceId, registration } = await h.pairAndRegister();
    h.publisher.requestFlush();
    await h.settle();
    expect(h.delivered[0]?.card.alert_title).toBe('2 agents need you');
    await h.publisher.stop();

    // Token rotation, then a fresh publisher (a restart) over the same home.
    const rotated = h.pairing.setNativePush(
      deviceId,
      {
        token: `fcm-token-${'r'.repeat(60)}`,
        packageName: 'io.kontourai.station',
        platform: 'android',
      },
      registration.stationKey,
    );
    expect(rotated.registrationId).toBe(registration.registrationId);
    const cards: Array<Record<string, string>> = [];
    // A new process: nothing in memory, only what is on disk.
    const reopened = new DevicePairingService({
      homeDir: h.homeDir,
      environmentId: ENVIRONMENT_ID,
    });
    const restarted = wireAgentActivityPublisher({
      eventBus: new EventBus(),
      devicePairing: reopened,
      signingKey: h.keys,
      sessionReaderFor: () => ({
        principalId: 'reader',
        listSessions: h.listSessions,
      }),
      gateway: GATEWAY,
      logger: { warn: vi.fn() },
      now: () => h.now() + 10_000,
      windowMs: 1,
      setTimer: () => () => {},
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(Buffer.from(init.body as Buffer)));
        cards.push(openCard(body.data.sealed, rotated));
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    restarted.requestFlush();
    await restarted.drain();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.alert_id).toBeUndefined();
    await restarted.stop();
  });

  test('a failed session read still re-arms the timer, without spinning it', async () => {
    const h = await harness();
    await h.pairAndRegister();
    h.sessions.set('s1', sessionEvents('s1', 'approval', START));
    h.emit('request.opened');
    await h.settle();
    const refresh = h.liveTimers()[0];
    expect(refresh?.at).toBe(START + 90 * 60_000);
    h.listSessions.mockRejectedValueOnce(new Error('read model down'));
    await h.fireNextTimer();
    const rearmed = h.liveTimers();
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0]?.at).toBeGreaterThanOrEqual(h.now() + 60_000);
    await h.fireNextTimer();
    expect(h.delivered).toHaveLength(2);
    await h.publisher.stop();
  });

  test('a 401 is retried on the timer and does not use up the alert; a 422 is final', async () => {
    const h = await harness({ answers: [401] });
    await h.pairAndRegister();
    h.sessions.set('s1', sessionEvents('s1', 'approval', START));
    h.emit('request.opened');
    await h.settle();
    expect(h.delivered).toHaveLength(0);
    await h.fireNextTimer();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.card.alert_title).toBe('Approval needed');
    await h.publisher.stop();

    const final = await harness({ answers: [422] });
    await final.pairAndRegister();
    final.sessions.set('s1', sessionEvents('s1', 'running', START));
    final.emit('turn.started');
    await final.settle();
    expect(final.fetchImpl).toHaveBeenCalledTimes(1);
    expect(final.liveTimers()).toEqual([]);
    await final.publisher.stop();
  });

  test('an unreadable registration store is not "nobody registered": delivery state survives it', async () => {
    const h = await harness();
    await h.pairAndRegister();
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    h.emit('turn.started');
    await h.settle();
    const list = vi
      .spyOn(h.pairing, 'listNativePushRegistrations')
      .mockImplementationOnce(() => {
        throw new Error('store unreadable');
      });
    h.advance(5000);
    h.publisher.requestFlush();
    await h.settle();
    list.mockRestore();
    h.advance(5000);
    h.publisher.requestFlush();
    await h.settle();
    // The same card is not re-sent just because one read failed.
    expect(h.delivered).toHaveLength(1);
    await h.publisher.stop();
  });

  test('each phone gets only the sessions its own device may read, one read per principal', async () => {
    let first = '';
    let second = '';
    let third = '';
    const h = await harness({
      principalFor: (deviceId) =>
        deviceId === first
          ? { principalId: 'principal-a', sessionIds: ['s1'] }
          : deviceId === second
            ? { principalId: 'principal-b', sessionIds: ['s2'] }
            : deviceId === third
              ? { principalId: 'principal-a', sessionIds: ['s1'] }
              : null,
    });
    first = (await h.pairAndRegister('A')).deviceId;
    second = (await h.pairAndRegister('B', `fcm-token-${'b'.repeat(60)}`))
      .deviceId;
    third = (await h.pairAndRegister('C', `fcm-token-${'c'.repeat(60)}`))
      .deviceId;
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    h.sessions.set('s2', sessionEvents('s2', 'approval', START));
    h.emit('turn.started');
    await h.settle();
    const byToken = new Map(h.delivered.map((d) => [d.token, d.card]));
    expect(byToken.get(TOKEN)?.activity_active_count).toBe('1');
    expect(byToken.get(TOKEN)?.activity_phase).toBe('running');
    expect(byToken.get(TOKEN)?.alert_id).toBeUndefined();
    expect(byToken.get(`fcm-token-${'b'.repeat(60)}`)?.activity_phase).toBe(
      'waiting_for_approval',
    );
    expect(byToken.get(`fcm-token-${'c'.repeat(60)}`)?.activity_phase).toBe(
      'running',
    );
    // Two principals, two reads — the third device shares principal-a's.
    expect(h.listSessions).toHaveBeenCalledTimes(2);
    await h.publisher.stop();
  });

  test("one principal's failed read skips only its phones, and they are retried in a minute", async () => {
    let first = '';
    let second = '';
    const failing = new Set<string>();
    const h = await harness({
      principalFor: (deviceId) =>
        deviceId === first
          ? { principalId: 'principal-a', sessionIds: ['s1'] }
          : deviceId === second
            ? { principalId: 'principal-b', sessionIds: ['s1'] }
            : null,
      failingPrincipals: failing,
    });
    first = (await h.pairAndRegister('A')).deviceId;
    second = (await h.pairAndRegister('B', `fcm-token-${'b'.repeat(60)}`))
      .deviceId;
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    failing.add('principal-a');
    h.emit('turn.started');
    await h.settle();
    // B's card went out although A's read failed first.
    expect(h.delivered.map((d) => d.token)).toEqual([
      `fcm-token-${'b'.repeat(60)}`,
    ]);
    const retry = h.liveTimers().sort((a, b) => a.at - b.at)[0];
    expect(retry?.at).toBe(START + 60_000);
    failing.clear();
    await h.fireNextTimer();
    expect(h.delivered.map((d) => d.token)).toContain(TOKEN);
    await h.publisher.stop();
  });

  test('a device whose reader cannot be resolved skips only that phone', async () => {
    let first = '';
    const h = await harness({
      principalFor: (deviceId) => {
        if (deviceId === first) throw new Error('corrupt device record');
        return { principalId: 'principal-b', sessionIds: ['s1'] };
      },
    });
    first = (await h.pairAndRegister('A')).deviceId;
    await h.pairAndRegister('B', `fcm-token-${'b'.repeat(60)}`);
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    h.emit('turn.started');
    await h.settle();
    expect(h.delivered.map((d) => d.token)).toEqual([
      `fcm-token-${'b'.repeat(60)}`,
    ]);
    await h.publisher.stop();
  });

  test('a failed read keeps a longer backoff and warns once per failure spell', async () => {
    const failing = new Set<string>();
    const h = await harness({
      principalFor: () => ({ principalId: 'principal-a', sessionIds: ['s1'] }),
      failingPrincipals: failing,
      answers: [503, 503, 503, 503],
    });
    await h.pairAndRegister();
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    h.emit('turn.started');
    await h.settle();
    // Four failed sends: the next send may not happen for 5 s x 3^3 = 135 s.
    await h.fireNextTimer();
    await h.fireNextTimer();
    await h.fireNextTimer();
    const attempts = h.fetchImpl.mock.calls.length;
    expect(attempts).toBe(4);
    const backoffAt = Math.min(...h.liveTimers().map((t) => t.at));
    failing.add('principal-a');
    h.emit('turn.started');
    await h.settle();
    h.emit('turn.started');
    await h.settle();
    // The read recovers at the stalled-read retry (60 s), but the phone's own
    // backoff still stands: no send before it.
    failing.clear();
    await h.fireNextTimer();
    expect(h.fetchImpl.mock.calls.length).toBe(attempts);
    while (h.liveTimers().some((t) => t.at <= backoffAt))
      await h.fireNextTimer();
    expect(h.fetchImpl.mock.calls.length).toBeGreaterThan(attempts);
    const readWarnings = h.warn.mock.calls.filter(
      (call) => call[0] === 'agent-activity: session read failed',
    );
    expect(readWarnings).toHaveLength(1);
    await h.publisher.stop();
  });

  test('a first flush that reads nothing is looked at again, with no device state yet', async () => {
    const h = await harness({
      principalFor: () => ({ principalId: 'principal-a', sessionIds: ['s1'] }),
      failingPrincipals: new Set(['principal-a']),
    });
    await h.pairAndRegister();
    h.emit('turn.started');
    await h.settle();
    const armed = h.liveTimers();
    expect(armed).toHaveLength(1);
    expect(armed[0]?.at).toBe(START + 60_000);
    await h.publisher.stop();
  });

  test('a registered device that may no longer read sessions is sent nothing', async () => {
    const h = await harness({ principalFor: () => null });
    await h.pairAndRegister();
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    h.emit('turn.started');
    await h.settle();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.liveTimers()).toEqual([]);
    await h.publisher.stop();
  });

  test('a phone that unregisters and registers again gets the card again', async () => {
    const h = await harness();
    const { deviceId, registration } = await h.pairAndRegister();
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    h.emit('turn.started');
    await h.settle();
    h.pairing.clearNativePush(deviceId);
    const again = h.pairing.setNativePush(
      deviceId,
      {
        token: TOKEN,
        packageName: 'io.kontourai.station',
        platform: 'android',
      },
      registration.stationKey,
    );
    h.registered.set(again.registrationId, again);
    h.advance(5000);
    h.publisher.requestFlush();
    await h.settle();
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1]?.data.device_id).toBe(again.registrationId);
    await h.publisher.stop();
  });

  test('the listener never throws, whatever fails underneath', async () => {
    const h = await harness({ answers: [new Error('ECONNRESET')] });
    await h.pairAndRegister();
    const subscribe = vi.spyOn(EventBus.prototype, 'subscribe');
    const bus = new EventBus();
    const publisher = wireAgentActivityPublisher({
      eventBus: bus,
      devicePairing: {
        listNativePushRegistrations: () => {
          throw new Error('registry unreadable');
        },
        clearNativePush: () => {},
        recordNativePushAlerts: () => {},
        recordNativePushCardShown: () => {},
        onDeviceAccessChanged: () => () => {},
        environmentId: () => ENVIRONMENT_ID,
      },
      signingKey: h.keys,
      sessionReaderFor: () => ({
        principalId: 'reader',
        listSessions: async () => [],
      }),
      gateway: GATEWAY,
      logger: { warn: vi.fn() },
      windowMs: 1,
      setTimer: () => () => {},
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
      listener?.({ event: SERVER_EVENTS.ORCHESTRATION_EVENT, data: undefined }),
    ).not.toThrow();
    await publisher.stop();

    // Network errors and a failing session read are logged, not thrown.
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    h.emit('turn.started');
    await h.settle();
    expect(h.warn).toHaveBeenCalledWith(
      'agent-activity: gateway request failed',
      { error: 'ECONNRESET' },
    );
    h.listSessions.mockRejectedValueOnce(new Error('read model down'));
    h.emit('turn.completed');
    await expect(h.settle()).resolves.toBeUndefined();
    expect(h.warn).toHaveBeenCalledWith('agent-activity: session read failed', {
      error: 'read model down',
    });
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
        recordNativePushAlerts: () => {},
        recordNativePushCardShown: () => {},
        onDeviceAccessChanged: () => () => {},
        environmentId: () => ENVIRONMENT_ID,
      },
      signingKey: { read: () => null },
      sessionReaderFor: () => ({
        principalId: 'reader',
        listSessions: async () => [],
      }),
      gateway: GATEWAY,
      logger: { warn: vi.fn() },
      enabled: false,
    });
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe('agent-activity publisher: a device narrowed below read access (#2517)', () => {
  const READ_ONLY = ['orchestration:read'] as const;
  const NO_READ = ['inference:invoke'] as const;
  const operator = { kind: 'presented-credential' } as const;

  function stored(h: Awaited<ReturnType<typeof harness>>, deviceId: string) {
    return h.pairing
      .listNativePushRegistrations()
      .find((entry) => entry.deviceId === deviceId)?.registration;
  }

  /**
   * A new process over the same home: nothing in memory, only what is on
   * disk. Its boot flush is the only thing that runs.
   */
  function restart(h: Awaited<ReturnType<typeof harness>>) {
    const reopened = new DevicePairingService({
      homeDir: h.homeDir,
      environmentId: ENVIRONMENT_ID,
    });
    const cards: Array<Record<string, string>> = [];
    const boot: Array<() => void> = [];
    const publisher = wireAgentActivityPublisher({
      eventBus: new EventBus(),
      devicePairing: reopened,
      signingKey: h.keys,
      sessionReaderFor: pairingReader(() => reopened, h.sessions),
      gateway: GATEWAY,
      logger: { warn: vi.fn() },
      now: () => h.now() + 10_000,
      windowMs: 1,
      setTimer: (fn) => {
        boot.push(fn);
        return () => {};
      },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(Buffer.from(init.body as Buffer)));
        const registration = [...h.registered.values()].find(
          (entry) => entry.registrationId === body.data.device_id,
        );
        if (!registration) throw new Error('card for an unknown registration');
        cards.push(openCard(body.data.sealed, registration));
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    return {
      reopened,
      publisher,
      cards,
      async boot() {
        for (const fn of boot.splice(0)) fn();
        await publisher.drain();
      },
    };
  }

  test('the scope change itself sends the final empty card, with no other event', async () => {
    const h = await harness({ readerFromPairing: true });
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    const { deviceId } = await h.pairAndRegister();
    h.emit('turn.started');
    await h.settle();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.card.activity_line_0).toBeDefined();
    expect(stored(h, deviceId)?.cardShown).toBe(true);

    h.advance(5000);
    h.pairing.setDeviceScope(deviceId, [...NO_READ], operator);
    await h.settle();
    expect(h.delivered).toHaveLength(2);
    const last = h.delivered[1]?.card;
    expect(last?.active).toBe('false');
    expect(last?.activity_line_0).toBeUndefined();
    expect(last?.activity_active_count).toBe('0');
    // The phone now shows nothing, and that is durable.
    expect(stored(h, deviceId)?.cardShown).toBeUndefined();

    // Nothing after that, whatever happens.
    h.advance(5000);
    h.emit('turn.completed');
    await h.settle();
    expect(h.delivered).toHaveLength(2);
    await h.publisher.stop();
  });

  test('a narrowing inside the send interval is paced, not dropped', async () => {
    const h = await harness({ readerFromPairing: true });
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    const { deviceId } = await h.pairAndRegister();
    h.emit('turn.started');
    await h.settle();
    h.advance(1000);
    h.pairing.setDeviceScope(deviceId, [...NO_READ], operator);
    await h.settle();
    // Inside the three-second floor: held back, with a timer for it.
    expect(h.delivered).toHaveLength(1);
    await h.fireNextTimer();
    expect(h.now()).toBe(START + 3000);
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1]?.card.activity_line_0).toBeUndefined();
    await h.publisher.stop();
  });

  test('a restart between the narrowing and its flush still sends the final empty card', async () => {
    const h = await harness({ readerFromPairing: true });
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    const { deviceId } = await h.pairAndRegister();
    h.emit('turn.started');
    await h.settle();
    expect(h.delivered).toHaveLength(1);
    // The process goes away before any flush can follow the narrowing.
    await h.publisher.stop();
    h.pairing.setDeviceScope(deviceId, [...NO_READ], operator);

    const first = restart(h);
    await first.boot();
    expect(first.cards).toHaveLength(1);
    expect(first.cards[0]?.active).toBe('false');
    expect(first.cards[0]?.activity_line_0).toBeUndefined();
    expect(
      first.reopened
        .listNativePushRegistrations()
        .find((entry) => entry.deviceId === deviceId)?.registration.cardShown,
    ).toBeUndefined();
    await first.publisher.stop();

    // Once only: the next process sends it nothing.
    const second = restart(h);
    await second.boot();
    expect(second.cards).toEqual([]);
    await second.publisher.stop();
  });

  test('a device that never showed a row is sent no empty card, before or after a restart', async () => {
    const h = await harness({ readerFromPairing: true });
    // Registered while nothing was running: it was only ever sent an empty
    // card.
    const quiet = await h.pairAndRegister('Quiet');
    const never = await h.pairAndRegister(
      'Never',
      `fcm-token-${'n'.repeat(60)}`,
    );
    h.publisher.requestFlush();
    await h.settle();
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered.every((d) => d.card.activity_line_0 === undefined)).toBe(
      true,
    );
    expect(stored(h, quiet.deviceId)?.cardShown).toBeUndefined();
    await h.publisher.stop();
    h.pairing.setDeviceScope(quiet.deviceId, [...NO_READ], operator);
    h.pairing.setDeviceScope(never.deviceId, [...NO_READ], operator);

    const after = restart(h);
    await after.boot();
    expect(after.cards).toEqual([]);
    await after.publisher.stop();

    // In process too: registered, narrowed, and never sent anything.
    const fresh = await harness({ readerFromPairing: true });
    fresh.sessions.set('s1', sessionEvents('s1', 'running', START));
    const { deviceId } = await fresh.pairAndRegister();
    fresh.pairing.setDeviceScope(deviceId, [...NO_READ], operator);
    await fresh.settle();
    expect(fresh.fetchImpl).not.toHaveBeenCalled();
    await fresh.publisher.stop();
  });

  test('only a card the phone accepted changes the persisted bit', async () => {
    // A refused final empty card: the phone still shows rows.
    const h = await harness({ readerFromPairing: true, answers: [200, 422] });
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    const { deviceId } = await h.pairAndRegister();
    h.emit('turn.started');
    await h.settle();
    expect(stored(h, deviceId)?.cardShown).toBe(true);
    h.advance(5000);
    h.pairing.setDeviceScope(deviceId, [...NO_READ], operator);
    await h.settle();
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(h.delivered).toHaveLength(1);
    expect(stored(h, deviceId)?.cardShown).toBe(true);
    await h.publisher.stop();

    // A refused card with rows: the phone never showed one.
    const refused = await harness({ readerFromPairing: true, answers: [422] });
    refused.sessions.set('s1', sessionEvents('s1', 'running', START));
    const other = await refused.pairAndRegister();
    refused.emit('turn.started');
    await refused.settle();
    expect(refused.fetchImpl).toHaveBeenCalledTimes(1);
    expect(refused.delivered).toEqual([]);
    expect(stored(refused, other.deviceId)?.cardShown).toBeUndefined();
    await refused.publisher.stop();
  });

  test('widening sends no spurious empty card, and re-widening restores the real card', async () => {
    const h = await harness({ readerFromPairing: true });
    h.sessions.set('s1', sessionEvents('s1', 'running', START));
    const { deviceId } = await h.pairAndRegister();
    h.pairing.setDeviceScope(deviceId, [...READ_ONLY], operator);
    await h.settle();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.card.activity_line_0).toBeDefined();

    // Widened while it could already read: the card is unchanged, not re-sent.
    h.advance(5000);
    h.pairing.setDeviceScope(
      deviceId,
      [...READ_ONLY, 'inference:invoke'],
      operator,
    );
    await h.settle();
    expect(h.delivered).toHaveLength(1);

    // Narrowed, then given read back: the second send is the real card.
    h.pairing.setDeviceScope(deviceId, [...NO_READ], operator);
    await h.settle();
    expect(h.delivered).toHaveLength(2);
    h.advance(5000);
    h.pairing.setDeviceScope(deviceId, [...READ_ONLY], operator);
    await h.settle();
    expect(h.delivered).toHaveLength(3);
    expect(h.delivered[2]?.card.activity_line_0).toBeDefined();
    expect(h.delivered[2]?.card.active).toBe('true');
    expect(stored(h, deviceId)?.cardShown).toBe(true);
    await h.publisher.stop();
  });
});

describe('resolvePushGatewayConfig', () => {
  test('defaults to the Kontour gateway', () => {
    expect(resolvePushGatewayConfig({})).toEqual({
      sendUrl: 'https://push.kontourai.io/v1/fcm/send',
      audience: 'https://push.kontourai.io',
    });
  });

  test('accepts a bare https origin', () => {
    expect(
      resolvePushGatewayConfig({
        STATION_PUSH_GATEWAY_URL: 'https://push.example.test/',
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
    'https://push.example.test/some/path',
    'https://push.example.test/?x=1',
    'https://push.example.test/#frag',
  ])('refuses %s', (value) => {
    expect(
      resolvePushGatewayConfig({ STATION_PUSH_GATEWAY_URL: value }),
    ).toBeNull();
  });
});
