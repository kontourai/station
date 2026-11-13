/** Opt-in real HTTP/SDK/Task/native sync, using only synthetic loopback model replies. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

if (!process.argv.includes('--run-real-local-lab'))
  throw new Error(
    'Pass --run-real-local-lab to start isolated native group sessions.',
  );
assert.match(
  process.env.CHILD_WORK_NATIVE_LAB_SOURCE_HEAD ?? '',
  /^[a-f0-9]{40}$/,
);

if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('native_group_lab_requires_darwin_arm64');

const artifacts = mkdtempSync(join(tmpdir(), 'child-work-native-group-sync-'));
const home = join(artifacts, 'home');
const workspace = join(artifacts, 'workspace');
const registry = join(artifacts, 'owned-processes');
for (const directory of [home, workspace, registry, join(home, '.claude')])
  mkdirSync(directory, { recursive: true, mode: 0o700 });
Object.assign(process.env, {
  HOME: home,
  STATION_HOME: home,
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  STATION_INSTANCE_ID: `native-group-${randomUUID()}`,
  STATION_BOOT_ID: randomUUID(),
  STATION_OWNED_PROCESS_REGISTRY: registry,
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
});
for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
])
  delete process.env[key];

const requests: {
  kind: string;
  output: string;
  sha256: string;
  model: string;
}[] = [];
const warnings: unknown[] = [];
const receipt: Record<string, unknown> = {
  sourceHead: process.env.CHILD_WORK_NATIVE_LAB_SOURCE_HEAD,
  driverSha256: createHash('sha256')
    .update(readFileSync(import.meta.filename))
    .digest('hex'),
  scope: 'real-http-sdk-task-native-context-sync-with-synthetic-model',
  portableAuthorityQualified: false,
  providerBillingQualified: false,
  requests,
  warnings,
};
const save = () =>
  writeFileSync(
    join(artifacts, 'receipt.json'),
    JSON.stringify(receipt, null, 2),
  );
let syncRequests = 0;
const runId = `native-sync-${randomUUID()}`;
const content = `Complete folded result ${randomUUID()}: retain this exact content for the next round.`;
const lifetime = new AbortController();
const outerDeadline = setTimeout(
  () => lifetime.abort(new Error('native_group_lab_deadline')),
  120_000,
);
const model = createServer(async (request, response) => {
  try {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new Error('native_model_body_limit');
      chunks.push(Buffer.from(chunk));
    }
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/v1/messages/count_tokens') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    assert.equal(request.method, 'POST');
    assert.equal(path, '/v1/messages');
    if (requests.length >= 8) throw new Error('native_model_request_limit');
    const body = Buffer.concat(chunks);
    const parsed = JSON.parse(body.toString('utf8'));
    const lastUser = [...parsed.messages]
      .reverse()
      .find((message: { role: string }) => message.role === 'user');
    const text =
      typeof lastUser?.content === 'string'
        ? lastUser.content
        : (lastUser?.content ?? [])
            .filter((block: { type: string }) => block.type === 'text')
            .map((block: { text: string }) => block.text)
            .join('\n');
    const syncing = text.includes(`ACK SYNC ${runId}`);
    if (syncing) assert.ok(text.includes(content));
    const output = syncing
      ? ++syncRequests === 1
        ? 'DELIBERATE WRONG ACK'
        : `ACK SYNC ${runId}`
      : 'INITIAL_NATIVE_RESULT';
    requests.push({
      kind: syncing ? 'sync' : 'initial',
      output,
      sha256: createHash('sha256').update(body).digest('hex'),
      model: parsed.model,
    });
    writeFileSync(join(artifacts, `request-${requests.length}.json`), body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type: string, data: Record<string, unknown>) =>
      response.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
      );
    emit('message_start', {
      message: {
        id: `msg-${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: parsed.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    emit('content_block_start', {
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    emit('content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text: output },
    });
    emit('content_block_stop', { index: 0 });
    emit('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    emit('message_stop', {});
    response.end();
  } catch (error) {
    receipt.modelFailure = String(error);
    save();
    if (!response.headersSent)
      response.writeHead(400, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        error: { type: 'invalid_request_error', message: String(error) },
      }),
    );
  }
});

let service:
  | import('../src-server/services/orchestration/orchestration-service.js').OrchestrationService
  | undefined;
let store:
  | import('../src-server/services/orchestration/event-store.js').EventStore
  | undefined;
let api: ReturnType<typeof import('@hono/node-server')['serve']> | undefined;
let resetClientCredential: (() => void) | undefined;
try {
  const require = createRequire(import.meta.url);
  receipt.sdkVersion = JSON.parse(
    readFileSync(
      join(
        dirname(require.resolve('@anthropic-ai/claude-agent-sdk')),
        'package.json',
      ),
      'utf8',
    ),
  ).version;
  const manifest = JSON.parse(
    readFileSync(
      join(
        dirname(require.resolve('@anthropic-ai/claude-agent-sdk')),
        'manifest.json',
      ),
      'utf8',
    ),
  );
  const executable = join(
    import.meta.dirname,
    '../node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
  );
  const executableDigest = createHash('sha256');
  for await (const chunk of createReadStream(executable))
    executableDigest.update(chunk);
  receipt.executableSha256 = executableDigest.digest('hex');
  assert.equal(
    receipt.executableSha256,
    manifest.platforms['darwin-arm64'].checksum,
  );
  receipt.bundledCliVersion = manifest.version;
  receipt.lockfileSha256 = createHash('sha256')
    .update(readFileSync(join(import.meta.dirname, '../pnpm-lock.yaml')))
    .digest('hex');
  const { serve } = await import('@hono/node-server');
  const { Hono } = await import('hono');
  const sdkClient = await import('@kontourai/station-sdk/client');
  resetClientCredential = () =>
    sdkClient.setClientCredentialResolver(undefined);
  const { agentId, engineConnectionId } = await import(
    '@kontourai/station-contracts/agent-identity'
  );
  const { ClaudeAdapter } = await import(
    '../src-server/providers/adapters/claude-adapter.js'
  );
  const { FileDelegationAttemptClaimStore } = await import(
    '../src-server/services/orchestration/delegation-attempt-claim-store.js'
  );
  const { EventBus } = await import(
    '../src-server/services/orchestration/event-bus.js'
  );
  const { EventStore } = await import(
    '../src-server/services/orchestration/event-store.js'
  );
  const { OrchestrationService } = await import(
    '../src-server/services/orchestration/orchestration-service.js'
  );
  const { createSessionAgentResolver } = await import(
    '../src-server/services/orchestration/session-agent-resolution.js'
  );
  const { createRuntimeResourcePostureController } = await import(
    '../src-server/services/infra/resource-posture.js'
  );
  const { EnvironmentSecurityService } = await import(
    '../src-server/services/ssh/environment-security-service.js'
  );
  const { createRemoteStationForwarder } = await import(
    '../src-server/services/remote-stations/remote-station-forwarder.js'
  );
  const { createOrchestrationRequestPrincipalResolver } = await import(
    '../src-server/runtime/bootstrap/orchestration-request-principal.js'
  );
  const { createOrchestrationRoutes } = await import(
    '../src-server/routes/orchestration/orchestration.js'
  );
  const auth = await import(
    '../src-server/security/runtime-request-security.js'
  );
  const delegation = await import(
    '../src-server/tools/station-control-delegation.js'
  );

  const storeOwner = new EventStore(join(home, 'events.sqlite'));
  store = storeOwner;
  const security = new EnvironmentSecurityService({ homeDir: home });
  const logger = {
    debug() {},
    warn(message: string, meta?: unknown) {
      if (warnings.length >= 64)
        throw new Error('native_warning_evidence_limit');
      warnings.push({ message, meta });
    },
  };
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const modelAddress = model.address();
  assert.ok(modelAddress && typeof modelAddress === 'object');
  const modelEnv = {
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    ANTHROPIC_API_KEY: 'synthetic-local-only',
    ANTHROPIC_AUTH_TOKEN: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelAddress.port}`,
    CLAUDE_CODE_USE_BEDROCK: '',
    CLAUDE_CODE_USE_VERTEX: '',
    CLAUDE_CODE_USE_FOUNDRY: '',
  };
  const adapter = new ClaudeAdapter({
    findBinary: async (command) => (command === 'claude' ? executable : null),
    getConnectionEnv: async () => modelEnv,
    nativeSessionOwnership: {
      assertMutable: (id) => storeOwner.assertNativeSessionMutable(id),
      claim: (key, id, rebind) =>
        storeOwner.claimNativeSessionIdentity(key, id, rebind),
      retired: (id) => storeOwner.recordNativeSessionRetired(id),
    },
  });
  await adapter.assertContextSyncRuntime();
  const bus = new EventBus();
  service = new OrchestrationService({
    adapterRegistry: {
      register() {
        throw new Error('Fixture inventory is fixed');
      },
      get: (id) => (id === 'claude' ? adapter : undefined),
      list: () => [adapter],
    },
    eventBus: bus,
    eventStore: storeOwner,
    logger,
    resourcePosture: createRuntimeResourcePostureController(),
    resolveSessionAgent: createSessionAgentResolver({
      loadAgentSpec: async (id) =>
        id === 'reviewer'
          ? {
              name: 'Native reviewer',
              prompt: 'Return the isolated report result.',
              execution: { agentConnectionId: engineConnectionId('claude') },
            }
          : null,
      resolveToolServer: async () => null,
      resolveSkillDir: async () => null,
    }),
  });
  const orchestration = service;
  const remote = createRemoteStationForwarder({
    ssh: {
      list: () => [],
      connect: async () => {
        throw new Error('This fixture is local only');
      },
    },
    peers: { get: () => null },
  });
  const credential = (await security.initialize()).credential;
  const resolvePrincipal = createOrchestrationRequestPrincipalResolver({
    environmentSecurityService: security,
  });
  const app = new Hono();
  app.use('/api/orchestration/*', async (c, next) => {
    const bearer = c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '';
    const admitted = security.withCurrentAuthority(() => {
      if (
        !security.verifyOperatorCredential(bearer) ||
        !security.authorizeCredential(bearer, {
          method: c.req.method,
          path: c.req.path,
        })
      )
        return false;
      auth.setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        kind: 'credential',
        credential: bearer,
        authority: 'operator-credential',
        source: 'bearer',
        locality: security.credentialLocality(bearer),
        mintKind: security.credentialMintKind(bearer),
      });
      auth.bindRuntimeLocalOperator(c.req.raw);
      return true;
    });
    if (!admitted) return c.json({ success: false }, 403);
    await next();
  });
  app.get('/.well-known/station/v1', (c) =>
    c.json({ environmentId: 'native-sync-fixture' }),
  );
  app.get('/api/agents/:slug', (c) =>
    c.req.param('slug') === 'reviewer'
      ? c.json({
          success: true,
          data: {
            slug: 'reviewer',
            name: 'Native reviewer',
            prompt: 'Return the isolated report result.',
            execution: { agentConnectionId: engineConnectionId('claude') },
          },
        })
      : c.notFound(),
  );
  app.get('/api/connections/:id', (c) =>
    c.req.param('id') === 'claude'
      ? c.json({
          success: true,
          data: {
            id: 'claude',
            kind: 'agent',
            enabled: true,
            status: 'ready',
            capabilities: ['agent-runtime'],
            config: { provider: 'claude' },
          },
        })
      : c.notFound(),
  );
  app.route(
    '/api/orchestration',
    createOrchestrationRoutes(orchestration, {
      cliSessionGroupHome: home,
      delegationAttemptClaimStore: new FileDelegationAttemptClaimStore(home),
      eventBus: bus,
      logger,
      resolvePrincipal,
      callerBindingForRequest: (request) =>
        auth.getRuntimeAuthenticatedRequestPrincipal(request)?.credential,
      isRequestPrincipalCurrent: (request) =>
        auth.isRuntimeRequestPrincipalCurrent(request, security),
      delegateTask: (input) =>
        delegation.delegateTask(input, orchestration, remote),
      observeDelegatedTask: (input) =>
        delegation.observeDelegatedTask(input, orchestration, remote),
      observeDelegatedTaskEvents: (input) =>
        delegation.observeDelegatedTaskEvents(input, orchestration, remote),
      respondToDelegatedTaskRequest: (input) =>
        delegation.respondToDelegatedTaskRequest(input, orchestration, remote),
      interruptDelegatedTask: (input) =>
        delegation.interruptDelegatedTask(input, orchestration, remote),
    }),
  );
  api = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  if (!api.listening) await once(api, 'listening');
  const apiAddress = api.address();
  assert.ok(apiAddress && typeof apiAddress === 'object');
  const apiBase = `http://127.0.0.1:${apiAddress.port}`;
  process.env.STATION_API_BASE = apiBase;
  process.env.STATION_INTERNAL_API_TOKEN = credential;
  sdkClient.setClientCredentialResolver(() => ({
    origin: apiBase,
    credential,
  }));
  const options = {
    credential,
    credentialOrigin: apiBase,
    signal: lifetime.signal,
  };
  const created = await sdkClient.createCliSessionGroup(
    apiBase,
    {
      operationId: 'native-create',
      maxConcurrent: 2,
      maxDispatches: 2,
      deadlineAt: Date.now() + 60_000,
      members: ['lead', 'check'].map((seatId) => ({
        seatId,
        prompt: `Native initial report ${seatId}`,
        target: {
          agent: agentId('reviewer'),
          expectedEngine: {
            kind: 'connection',
            connectionId: engineConnectionId('claude'),
          },
          model: { override: 'claude-sonnet-4-5' },
          workspace: { kind: 'directory', cwd: workspace },
        },
      })),
    },
    options,
  );
  receipt.groupId = created.groupId;
  const initial = await sdkClient.runCliSessionGroup(
    apiBase,
    created.groupId,
    options,
  );
  receipt.initial = initial;
  assert.equal(initial.members.length, 2);
  assert.ok(
    initial.members.every(
      (member) =>
        member.state === 'terminal' &&
        member.outcome === 'completed' &&
        member.handle,
    ),
  );
  const identities = initial.members.map((member) => {
    assert.ok(member.handle);
    const session = storeOwner.readSessionByThread(member.handle.sessionId);
    assert.ok(session && session.persistSession !== false);
    const native = adapter.nativeSessionIdentity(session.resumeCursor);
    assert.ok(native);
    return {
      seatId: member.seatId,
      sessionId: session.threadId,
      nativeSessionId: native.sessionId,
    };
  });
  assert.equal(
    new Set(identities.map((identity) => identity.nativeSessionId)).size,
    2,
  );
  receipt.initialIdentities = identities;
  const input = {
    operationId: 'native-wrong-ack-retry',
    runId,
    content,
    deadlineAt: Date.now() + 60_000,
  };
  const synced = await sdkClient.syncCliSessionGroup(
    apiBase,
    created.groupId,
    input,
    options,
  );
  receipt.synced = synced;
  assert.equal(synced.contextSync?.status, 'acknowledged');
  assert.equal(
    synced.contextSync.contentHash,
    `sha256:${createHash('sha256').update(content).digest('hex')}`,
  );
  assert.deepEqual(
    synced.contextSync.members.map((member) => member.attempts),
    [2, 1],
  );
  assert.ok(
    synced.contextSync.members.every(
      (member) =>
        member.status === 'acknowledged' &&
        member.toolCalls === 0 &&
        member.turnId &&
        member.terminalEventId,
    ),
  );
  assert.equal(syncRequests, 3);
  assert.equal(requests.length, 5);
  for (const identity of identities) {
    const session = storeOwner.readSessionByThread(identity.sessionId);
    assert.ok(session);
    assert.equal(
      adapter.nativeSessionIdentity(session.resumeCursor)?.sessionId,
      identity.nativeSessionId,
    );
  }
  const canonical = identities.flatMap(({ sessionId }) =>
    storeOwner.listEvents(sessionId),
  );
  assert.equal(
    canonical.filter((event) => event.payload.method === 'turn.started').length,
    5,
  );
  assert.equal(
    canonical.filter((event) => event.payload.method === 'turn.completed')
      .length,
    5,
  );
  const outputs = canonical.flatMap((row) => {
    const event = storeOwner.resolveCanonicalEventContent(row.payload);
    return event.method === 'turn.completed' ? [event.outputText] : [];
  });
  assert.equal(
    outputs.filter((output) => output === 'INITIAL_NATIVE_RESULT').length,
    2,
  );
  assert.equal(
    outputs.filter((output) => output === 'DELIBERATE WRONG ACK').length,
    1,
  );
  assert.equal(
    outputs.filter((output) => output === `ACK SYNC ${runId}`).length,
    2,
  );
  receipt.canonical = canonical;
  const replayed = await sdkClient.syncCliSessionGroup(
    apiBase,
    created.groupId,
    input,
    options,
  );
  assert.deepEqual(replayed.contextSync, synced.contextSync);
  assert.equal(requests.length, 5);
  const afterReplay = identities.flatMap(({ sessionId }) =>
    storeOwner.listEvents(sessionId),
  );
  assert.equal(
    afterReplay.filter((event) => event.payload.method === 'turn.started')
      .length,
    5,
  );
  receipt.replay = 'no additional native/model turn';
  assert.equal(receipt.modelFailure, undefined);
  receipt.status = 'PASS_SCOPED_NATIVE_WRONG_ACK_RETRY';
} catch (error) {
  receipt.status = 'FAIL';
  receipt.failure =
    error instanceof Error
      ? { message: error.message, stack: error.stack }
      : String(error);
  process.exitCode = 1;
} finally {
  clearTimeout(outerDeadline);
  lifetime.abort();
  resetClientCredential?.();
  const cleanupFailures: { owner: string; error: string }[] = [];
  const owners: [string, () => Promise<void>][] = [
    [
      'orchestration',
      async () => {
        if (service) await service.shutdown();
        receipt.orchestrationShutdown = 'awaited';
      },
    ],
    [
      'event-store',
      async () => {
        receipt.eventStoreClose = store?.close();
      },
    ],
    [
      'http',
      async () => {
        const currentApi = api;
        if (!currentApi) return;
        if (
          'closeAllConnections' in currentApi &&
          typeof currentApi.closeAllConnections === 'function'
        )
          currentApi.closeAllConnections();
        await new Promise<void>((done, reject) =>
          currentApi.close((error) => (error ? reject(error) : done())),
        );
      },
    ],
    [
      'model',
      async () => {
        model.closeAllConnections();
        if (model.listening)
          await new Promise<void>((done) => model.close(() => done()));
      },
    ],
  ];
  for (const [owner, stop] of owners) {
    try {
      await stop();
    } catch (error) {
      cleanupFailures.push({ owner, error: String(error) });
    }
  }
  receipt.remainingOwnedRecords = readdirSync(registry);
  if (readdirSync(registry).length)
    cleanupFailures.push({
      owner: 'native-processes',
      error: 'owned registry still retains work',
    });
  receipt.osDescendantCensus =
    'not performed; actual orchestration shutdown awaited';
  if (cleanupFailures.length) {
    receipt.cleanupFailures = cleanupFailures;
    receipt.status = 'FAIL';
    process.exitCode = 1;
  }
  save();
  process.stdout.write(
    `${JSON.stringify({ artifacts, status: receipt.status })}\n`,
  );
}
