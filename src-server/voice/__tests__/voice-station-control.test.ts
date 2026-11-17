/**
 * #2377 slice D (owner decision 2026-11-16): a voice session's Station tools
 * act for the person whose credential authenticated the socket. A loopback
 * connection with no credential keeps speech and has no Station tools; a
 * credential that resolves to no one is refused.
 *
 * Real pieces: the voice WebSocket listener and its auth handshake, the
 * production credential resolver (`credentialPrincipal`), the voice session
 * service, the per-session in-process station-control caller, the tools'
 * own `api()` loopback, the runtime auth boundary, the authority guard and
 * the policy table. Faked: the speech provider (it emits the tool call a
 * model would) and the Station route the tool reaches, which records who the
 * guard said called.
 */
import { randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import { attachVoiceWebSocket } from '../../routes/operations/voice.js';
import { credentialPrincipal } from '../../runtime/bootstrap/orchestration-request-principal.js';
import {
  configureRuntimeHttp,
  deviceSessionCookieName,
} from '../../runtime/bootstrap/runtime-http.js';
import {
  createStationControlCallerRecordResolver,
  resolveStationControlCallerForRequest,
} from '../../runtime/mcp/station-control-caller.js';
import { __resetStationControlMcpTokensForTests } from '../../runtime/mcp/station-control-mcp-token.js';
import {
  __resetNativeStationControlForTests,
  callNativeStationControlTool,
} from '../../runtime/mcp/station-control-native-tools.js';
import { markTrustedNativeStationControlTool } from '../../runtime/tools/tool-provenance.js';
import { RuntimeAuthFailureLimiter } from '../../security/runtime-request-security.js';
import { createStationControlAuthorityGuard } from '../../security/station-control-authority-guard.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import { __resetStationServerSelfAttestationForTests } from '../../security/station-server-scope.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import {
  __resetStationControlStdioEntryForTests,
  setRuntimeControlApiBase,
} from '../../tools/station-control-shared.js';
import type { Logger } from '../../utils/logger.js';
import type {
  IS2SProvider,
  S2SAudioFormat,
  S2SSessionConfig,
} from '../s2s-types.js';
import {
  VOICE_NO_STATION_TOOLS_NOTE,
  VoiceSessionService,
} from '../voice-session.js';

const OPERATOR_CREDENTIAL = 'test-only-voice-operator-credential';
const ACCOUNT_DEVICE_CREDENTIAL = 'test-only-voice-account-device';
// A UI-bootstrap device credential in the issued format (32 random bytes,
// base64url), carried in the local UI's HttpOnly cookie under its real name.
const UI_DEVICE_CREDENTIAL = randomBytes(32).toString('base64url');
const UI_COOKIE = `${deviceSessionCookieName(false, 'environment-test')}=${UI_DEVICE_CREDENTIAL}`;
const STATION_ORIGIN = 'http://127.0.0.1:5173';
// A device this Station issued and has since revoked: recognized, not valid.
const REVOKED_DEVICE_CREDENTIAL = randomBytes(32).toString('base64url');
const FORMAT: S2SAudioFormat = {
  mediaType: 'audio/pcm',
  sampleRateHertz: 16000,
  sampleSizeBits: 16,
  channelCount: 1,
  encoding: 'base64',
};

/** The speech provider: it emits the tool call a model would make. */
class FakeProvider extends EventEmitter implements IS2SProvider {
  readonly outputAudioFormat = FORMAT;
  config: S2SSessionConfig | undefined;
  results: Array<{ toolUseId: string; result: string }> = [];
  state: IS2SProvider['state'] = 'disconnected';
  async connect(config: S2SSessionConfig) {
    this.config = config;
    this.state = 'listening';
    return FORMAT;
  }
  sendAudio(): void {}
  sendToolResult(toolUseId: string, result: string): void {
    this.results.push({ toolUseId, result });
  }
  async disconnect() {
    this.state = 'disconnected';
  }
}

// What the loader builds for the built-in: a trusted native tool.
const updateConfig = markTrustedNativeStationControlTool({
  name: 'stationControl_updateConfig',
  description: 'Update app configuration',
  parameters: { type: 'object' },
  execute: (args: Record<string, unknown>) =>
    callNativeStationControlTool('update_config', args),
});
// Any other tool the voice agent carries stays listed either way.
const otherTool = {
  name: 'weather_today',
  description: 'Today’s weather',
  parameters: { type: 'object' },
  execute: async () => 'sunny',
};

let apiServer: ReturnType<typeof serve>;
let voiceListener: WebSocketServer;
let voiceUrl: string;
let providers: FakeProvider[] = [];
const createSession = vi.fn();
const audit = vi.fn();
const limiter = new RuntimeAuthFailureLimiter();
const recordFailure = vi.spyOn(limiter, 'recordFailure');
const clearFailures = vi.spyOn(limiter, 'clear');
const seen: Array<ReturnType<typeof stationControlRequestAuthority>> = [];

beforeAll(async () => {
  __resetStationServerSelfAttestationForTests();
  __resetStationControlStdioEntryForTests();
  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
      verifyCredential: () => false,
      resolveGrantedScope: () => undefined,
      now: () => Date.now(),
      maxFailures: 100,
      windowMs: 60_000,
      audit: () => {},
      allowedOrigins: [],
    },
  } as Parameters<typeof configureRuntimeHttp>[0]);
  const resolveRecord = createStationControlCallerRecordResolver({
    actingPrincipal: () => undefined,
    startedMetadata: () => undefined,
    localProjectId: () => undefined,
    conversationId: () => undefined,
  });
  app.use(
    '*',
    createStationControlAuthorityGuard({
      resolveCaller: (request) =>
        resolveStationControlCallerForRequest(request, resolveRecord),
      isOperatorPrincipal: (id) => id === LOCAL_OPERATOR_PRINCIPAL_ID,
    }),
  );
  app.put('/config/app', (c) => {
    seen.push(stationControlRequestAuthority(c.req.raw));
    return c.json({ success: true });
  });
  let resolvePort!: (port: number) => void;
  const listening = new Promise<number>((done) => {
    resolvePort = done;
  });
  apiServer = serve(
    { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
    (info) => resolvePort((info as AddressInfo).port),
  );
  setRuntimeControlApiBase(await listening);

  const service = new VoiceSessionService({
    providerFactory: () => {
      const provider = new FakeProvider();
      providers.push(provider);
      return provider;
    },
    agentTools: new Map([['station-voice', [updateConfig, otherTool]]]),
    agentSpecs: new Map([['station-voice', { systemPrompt: 'Voice agent.' }]]),
    // The approval gate admits every call; authority is the guard's job.
    agentHooks: new Map([
      ['station-voice', { beforeToolCall: async () => true } as never],
    ]),
  });
  const realCreate = service.createSession.bind(service);
  createSession.mockImplementation(realCreate);
  // The security service a real Station hands the resolver.
  const security = {
    verifyOperatorCredential: (credential: string) =>
      credential === OPERATOR_CREDENTIAL,
    identifyDevice: (credential: string) =>
      credential === ACCOUNT_DEVICE_CREDENTIAL
        ? ({
            id: 'device-1',
            name: 'Phone',
            principalBinding: {
              kind: 'account',
              issuer: 'station-accounts',
              subject: 'someone',
            },
          } as never)
        : credential === UI_DEVICE_CREDENTIAL ||
            credential === REVOKED_DEVICE_CREDENTIAL
          ? ({ id: 'device-ui', name: 'Station UI' } as never)
          : null,
    // A UI-bootstrap device is minted with home-possession locality.
    credentialLocality: (credential: string) =>
      credential === UI_DEVICE_CREDENTIAL ||
      credential === REVOKED_DEVICE_CREDENTIAL
        ? 'home-possession'
        : undefined,
    credentialHasOwnerStanding: () => false,
  };
  const listener = attachVoiceWebSocket(
    0,
    { createSession, getActiveCount: () => 0 } as never,
    '127.0.0.1',
    {
      // These credentials verify; the account device resolves to no one.
      verifyCredential: (credential) =>
        credential === OPERATOR_CREDENTIAL ||
        credential === ACCOUNT_DEVICE_CREDENTIAL ||
        credential === UI_DEVICE_CREDENTIAL,
      resolvePrincipal: (credential) =>
        credentialPrincipal(credential, security as never)?.id,
      recognizesDeviceCredential: (credential) =>
        security.identifyDevice(credential) !== null,
      // Only Station's own UI origin may open a browser-shaped upgrade.
      browserOrigins: { admits: async (origin) => origin === STATION_ORIGIN },
      audit,
      limiter,
    },
  );
  if (!listener) throw new Error('voice listener was not created');
  voiceListener = listener;
  await once(voiceListener, 'listening');
  voiceUrl = `ws://127.0.0.1:${(voiceListener.address() as AddressInfo).port}/`;
});

afterEach(() => {
  audit.mockClear();
  recordFailure.mockClear();
  clearFailures.mockClear();
  seen.length = 0;
  providers = [];
  createSession.mockClear();
});

afterAll(async () => {
  for (const client of voiceListener.clients) client.terminate();
  await new Promise<void>((done) => voiceListener.close(() => done()));
  setRuntimeControlApiBase(undefined);
  await new Promise<void>((done) => apiServer.close(() => done()));
  await __resetNativeStationControlForTests();
  __resetStationControlMcpTokensForTests();
  __resetStationServerSelfAttestationForTests();
});

/** Connect, authenticate when given a credential, and wait for the session. */
async function connect(credential?: string, headers?: Record<string, string>) {
  const ws = new WebSocket(
    credential ? `${voiceUrl}?authenticate=1` : voiceUrl,
    headers ? { headers } : undefined,
  );
  await once(ws, 'open');
  if (credential) {
    ws.send(JSON.stringify({ type: 'auth', protocolVersion: 1, credential }));
    const [code] = await Promise.race([
      once(ws, 'message').then(() => [0]),
      once(ws, 'close'),
    ]);
    if (code !== 0) return { ws, closed: code as number };
  }
  await vi.waitFor(() => expect(providers.at(-1)?.config).toBeDefined());
  return { ws, provider: providers.at(-1)! };
}

test('a voice session signed in as a person calls a Station tool as that person', async () => {
  const { ws, provider } = await connect(OPERATOR_CREDENTIAL);
  expect(provider!.config?.tools?.map((tool) => tool.name)).toContain(
    'stationControl_updateConfig',
  );
  provider!.emit('toolUse', {
    toolName: 'stationControl_updateConfig',
    toolUseId: 'tu-1',
    parameters: { updates: { theme: 'dark' } },
  });
  await vi.waitFor(() => expect(provider!.results).toHaveLength(1));
  // An operator-only write reached its route as a bound operator.
  expect(JSON.parse(provider!.results[0]!.result)).toMatchObject({
    content: [{ text: expect.stringContaining('"success": true') }],
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    kind: 'caller',
    boundOperator: true,
    caller: {
      assurance: 'bound',
      principal: { id: LOCAL_OPERATOR_PRINCIPAL_ID },
    },
  });
  ws.close();
});

test('a credential-free loopback session keeps speech and is offered no Station tools', async () => {
  const { ws, provider } = await connect();
  const names = provider!.config?.tools?.map((tool) => tool.name) ?? [];
  expect(names).not.toContain('stationControl_updateConfig');
  // The control: the agent's other tools are still offered.
  expect(names).toContain('weather_today');
  expect(provider!.config?.systemPrompt).toContain(VOICE_NO_STATION_TOOLS_NOTE);
  ws.close();
});

test('a credential that verifies but names no person keeps speech with no Station tools', async () => {
  const { ws, provider, closed } = await connect(ACCOUNT_DEVICE_CREDENTIAL);
  expect(closed).toBeUndefined();
  const names = provider!.config?.tools?.map((tool) => tool.name) ?? [];
  expect(names).not.toContain('stationControl_updateConfig');
  expect(names).toContain('weather_today');
  ws.close();
});

test('a credential that fails verification is refused', async () => {
  const { closed } = await connect('test-only-not-a-credential');
  expect(closed).toBe(4401);
  expect(createSession).not.toHaveBeenCalled();
});

// The local UI's credential is an HttpOnly cookie its page cannot read, so a
// loopback upgrade carrying it authenticates with it, no auth frame needed.
test('a loopback upgrade carrying the UI device cookie gets Station tools as that person', async () => {
  const { ws, provider } = await connect(undefined, {
    cookie: `other-app=1; ${UI_COOKIE}`,
    origin: STATION_ORIGIN,
  });
  expect(provider!.config?.tools?.map((tool) => tool.name)).toContain(
    'stationControl_updateConfig',
  );
  provider!.emit('toolUse', {
    toolName: 'stationControl_updateConfig',
    toolUseId: 'tu-cookie',
    parameters: { updates: { theme: 'dark' } },
  });
  await vi.waitFor(() => expect(provider!.results).toHaveLength(1));
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    kind: 'caller',
    boundOperator: true,
    caller: { principal: { id: LOCAL_OPERATOR_PRINCIPAL_ID } },
  });
  ws.close();
});

test('a cookie whose credential fails verification gives the session no Station tools', async () => {
  const { ws, provider } = await connect(undefined, {
    cookie: `${deviceSessionCookieName(false, 'environment-test')}=${REVOKED_DEVICE_CREDENTIAL}`,
    origin: STATION_ORIGIN,
  });
  const names = provider!.config?.tools?.map((tool) => tool.name) ?? [];
  expect(names).not.toContain('stationControl_updateConfig');
  expect(names).toContain('weather_today');
  // Counted and audited exactly as a failed auth frame is, never cleared.
  expect(recordFailure).toHaveBeenCalledWith('127.0.0.1');
  expect(clearFailures).not.toHaveBeenCalled();
  expect(audit).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'station.auth.failure',
      reason: 'invalid_credential',
      peerClass: 'loopback',
    }),
  );
  ws.close();
});

test('a peer over its failure budget is refused before its cookie is verified, as an auth frame is', async () => {
  const overBudget = vi.spyOn(limiter, 'retryAfterSeconds').mockReturnValue(30);
  try {
    // Even a cookie that would verify is not tried.
    const ws = new WebSocket(voiceUrl, {
      headers: { cookie: UI_COOKIE, origin: STATION_ORIGIN },
    });
    // Bounded, so a missing refusal fails here, readably, not by timeout.
    const code = await Promise.race([
      once(ws, 'close').then(([closeCode]) => closeCode as number),
      new Promise<string>((done) =>
        setTimeout(() => done('still open after 2 s'), 2_000),
      ),
    ]);
    expect(code).toBe(4429);
    ws.terminate();
    expect(createSession).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'station.auth.rate_limited',
        reason: 'too_many_failures',
        peerClass: 'loopback',
      }),
    );
    // The control: a cookie-free loopback session is not a credential
    // guess, so it still gets speech.
    const { ws: speech, provider } = await connect();
    expect(provider).toBeDefined();
    speech.close();
  } finally {
    overBudget.mockRestore();
  }
});

test('a verified cookie is neither counted nor audited as a failure', async () => {
  const { ws } = await connect(undefined, {
    cookie: UI_COOKIE,
    origin: STATION_ORIGIN,
  });
  expect(recordFailure).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
  // And it clears the peer's earlier failures, as a verified auth frame does.
  expect(clearFailures).toHaveBeenCalledWith('127.0.0.1');
  ws.close();
});

test('another site’s page cannot ride the cookie: its upgrade is refused by the Origin check', async () => {
  const ws = new WebSocket(voiceUrl, {
    headers: { cookie: UI_COOKIE, origin: 'https://attacker.example' },
  });
  const [, response] = (await once(ws, 'unexpected-response')) as [
    unknown,
    { statusCode: number },
  ];
  expect(response.statusCode).toBe(403);
  expect(createSession).not.toHaveBeenCalled();
});
