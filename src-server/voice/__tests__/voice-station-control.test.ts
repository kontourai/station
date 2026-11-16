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
import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import { attachVoiceWebSocket } from '../../routes/operations/voice.js';
import { credentialPrincipal } from '../../runtime/bootstrap/orchestration-request-principal.js';
import { configureRuntimeHttp } from '../../runtime/bootstrap/runtime-http.js';
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
        : null,
    credentialLocality: () => undefined,
    credentialHasOwnerStanding: () => false,
  };
  const listener = attachVoiceWebSocket(
    0,
    { createSession, getActiveCount: () => 0 } as never,
    '127.0.0.1',
    {
      // Both credentials verify; only one resolves to a person.
      verifyCredential: (credential) =>
        credential === OPERATOR_CREDENTIAL ||
        credential === ACCOUNT_DEVICE_CREDENTIAL,
      resolvePrincipal: (credential) =>
        credentialPrincipal(credential, security as never)?.id,
      browserOrigins: { admits: () => true },
    },
  );
  if (!listener) throw new Error('voice listener was not created');
  voiceListener = listener;
  await once(voiceListener, 'listening');
  voiceUrl = `ws://127.0.0.1:${(voiceListener.address() as AddressInfo).port}/`;
});

afterEach(() => {
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
async function connect(credential?: string) {
  const ws = new WebSocket(
    credential ? `${voiceUrl}?authenticate=1` : voiceUrl,
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

test('a credential that verifies but resolves to no person is refused', async () => {
  const { closed } = await connect(ACCOUNT_DEVICE_CREDENTIAL);
  expect(closed).toBe(4401);
  expect(createSession).not.toHaveBeenCalled();
  expect(seen).toEqual([]);
});
