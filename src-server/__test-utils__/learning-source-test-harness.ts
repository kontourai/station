/** Hermetic production-constructor/auth/owner read fixture; no provider or child process. */
import { EventEmitter } from 'node:events';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts/environment-security';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { parseHostedTenantRegistry } from '@kontourai/station-contracts/tenancy';
import {
  KNOWLEDGE_ROOT_IDENTITY_HEADER,
  knowledgeRootIncarnationKey,
} from '@kontourai/station-shared/knowledge-root-identity';
import { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { Hono } from 'hono';
import { FileStorageAdapter } from '../domain/file-storage-adapter.js';
import { KitDefaultStoreAdapter } from '../knowledge-store/adapters/default-store.js';
import { isLocalKnowledgeSourceRequestCurrent } from '../knowledge-store/knowledge-source-observation-policy.js';
import { createKnowledgeRecordRoutes } from '../routes/knowledge/knowledge-record-routes.js';
import { createKnowledgeSourceRoutes } from '../routes/knowledge/knowledge-source-routes.js';
import { createKnowledgeStoreRoutes } from '../routes/knowledge/knowledge-store-routes.js';
import { configureRuntimeHttp } from '../runtime/bootstrap/runtime-http.js';
import { createRuntimeServiceBundle } from '../runtime/bootstrap/runtime-service-bootstrap.js';
import {
  createHostedTenantMiddleware,
  createPersonalRuntimeRequestGuard,
  getTenantRequestContext,
} from '../runtime/bootstrap/runtime-tenant-context.js';
import { EventBus } from '../services/orchestration/event-bus.js';

export async function createLearningSourceFixture(
  directory: string,
  tenantFixture = false,
) {
  mkdirSync(directory, { recursive: true });
  const fixture = realpathSync(directory);
  const home = join(fixture, 'home');
  const rootPath = join(fixture, 'records-root');
  mkdirSync(join(home, 'config'), { recursive: true });
  const oldHome = process.env.STATION_HOME;
  process.env.STATION_HOME = home;
  const persistence = new FileStorageAdapter(home);
  const root: KnowledgeStoreRoot = {
    id: 'root:personal',
    adapterId: 'kit-default-store',
    scope: { kind: 'personal' },
    storeRoot: rootPath,
    displayName: 'Personal learning sources',
    createdAt: '2026-09-01T00:00:00.000Z',
  };
  await persistence.saveKnowledgeStoreRoot(root);
  const producer = new KitDefaultStoreAdapter({ storeRoot: rootPath });
  const recordId = await producer.create({
    id: 'source-record-12345678',
    type: 'raw',
    title: 'Keep verification evidence visible',
    category: 'feedback',
    body: 'Retain the exact check result when reporting a change. This is a source record, not an approved learning.',
    provenance: {
      agent: 'fixture-owner',
      note: 'Owner-produced source fixture; no learning promotion is recorded.',
    },
  });
  const allowed = new Set([
    'local-fixture',
    'remote-fixture',
    'operator-fixture',
  ]);
  let grant = DEFAULT_GRANT_PAIRING_SCOPE;
  let locality = true;
  const security = {
    verifyCredential: (credential: string) => allowed.has(credential),
    authorizeCredential: (credential: string) => allowed.has(credential),
    resolveGrantedScope: () => grant,
    credentialLocality: (credential: string) =>
      credential === 'local-fixture' && locality
        ? ('home-possession' as const)
        : undefined,
  };
  const noop = () => ({});
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
    child() {
      return this;
    },
    setLevel() {},
    getLevel() {
      return 'info' as const;
    },
  };
  const eventBus = new EventBus();
  const bundle = createRuntimeServiceBundle(
    {
      projectHomeDir: home,
      port: 43210,
      logger,
      configLoader: {
        getProjectHomeDir: () => home,
        loadACPConfig: async () => ({ connections: [] }),
        loadAppConfig: async () => ({}),
        updateAppConfig: async () => ({}),
        mutateAppConfig: async () => ({}),
      } as any,
      approvalRegistry: {} as any,
      eventBus,
      orchestrationEventStore: {
        voiceTurnRunAuthority: noop,
        createCredentialApplicationFactory: noop,
      } as any,
      environmentSecurityService: security,
      monitoringEvents: new EventEmitter(),
      memoryAdapters: new Map(),
      activeAgents: new Map(),
      agentMetadataMap: new Map(),
      agentSpecs: new Map(),
      agentTools: new Map(),
      agentHooks: new Map(),
      mcpCustody: new MCPLocalConnectionCustody(),
      mcpConfigs: new Map(),
      mcpConnectionStatus: new Map(),
      integrationMetadata: new Map(),
      toolNameMapping: new Map(),
      resetAllRuntimeProjections: async (reset) => reset(),
      usageAggregatorRef: { get: noop },
      getTerminalShell: () => undefined,
      persistEvent: async () => {},
      bootstrapVoiceAgent: async () => {},
      resolveVectorDbProvider: noop,
      resolveEmbeddingProvider: noop,
    },
    {
      createStorageAdapter: () => persistence,
      createAgentService: noop,
      createSkillService: noop,
      createMcpService: noop,
      createLayoutService: noop,
      createProjectService: noop,
      createProviderService: noop,
      createProposedChangeService: noop,
      createKnowledgeService: noop,
      // Deliberately no KnowledgeStoreProvider factory: execute production policy construction.
      createFileTreeService: noop,
      createPtyAdapter: noop,
      createHistoryStore: noop,
      createTerminalService: noop,
      createTerminalWsServer: noop,
      createVoiceService: noop,
      createMonitoringEmitter: noop,
      createACPManager: () => ({ getStatus: noop }),
      createConnectionService: noop,
      createFeedbackService: noop,
      createSshEnvironmentService: noop,
    },
  );
  const provider = bundle.knowledgeStoreProvider;
  const app = new Hono();
  const tenantContexts: string[] = [];
  if (tenantFixture) {
    app.use(
      '*',
      createHostedTenantMiddleware(
        parseHostedTenantRegistry({
          schemaVersion: 1,
          tenants: [{ id: 'alpha', authority: 'alpha.example.test' }],
        }),
      ),
    );
    app.use('*', async (c, next) => {
      const context = getTenantRequestContext(c.req.raw);
      if (context) tenantContexts.push(context.tenantId);
      await next();
    });
  }
  const personalRequest = createPersonalRuntimeRequestGuard();
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus,
    security: {
      allowedOrigins: ['http://localhost:5173'],
      verifyCredential: security.verifyCredential,
      resolveGrantedScope: security.resolveGrantedScope,
      resolveCredentialAuthority: (credential) =>
        credential === 'operator-fixture'
          ? 'operator-credential'
          : 'device-credential',
      resolveCredentialDeviceId: (credential) => credential,
      resolveCredentialLocality: security.credentialLocality,
      resolveCredentialMintKind: (credential) =>
        credential === 'local-fixture' ? 'ui-bootstrap' : undefined,
      resolvePairingSource: () => 'same-origin',
    },
  });
  app.route(
    '/api/knowledge',
    createKnowledgeSourceRoutes(provider, (request) =>
      isLocalKnowledgeSourceRequestCurrent(request, security, personalRequest),
    ),
  );
  app.route(
    '/api/knowledge',
    createKnowledgeStoreRoutes({ store: provider, dataDir: home }),
  );
  app.route('/api/knowledge', createKnowledgeRecordRoutes({ store: provider }));
  app.get('/api/knowledge/status', (c) =>
    c.json({
      success: true,
      data: { stats: { totalDocuments: 1, totalChunks: 0, projectCount: 0 } },
    }),
  );
  const path = `/api/knowledge/roots/${encodeURIComponent(root.id)}/records/${recordId}/source-observation`;
  const headers = (
    credential = 'local-fixture',
    rootIdentity = knowledgeRootIncarnationKey(root),
  ) => ({
    Authorization: `Bearer ${credential}`,
    [KNOWLEDGE_ROOT_IDENTITY_HEADER]: encodeURIComponent(rootIdentity),
  });
  return {
    app,
    root,
    recordId,
    home,
    fixture,
    rootPath,
    path,
    headers,
    provider,
    tenantContexts,
    persistence,
    producer,
    revoke() {
      allowed.delete('local-fixture');
    },
    narrowScope() {
      grant = '';
    },
    revokeLocality() {
      locality = false;
    },
    close() {
      if (oldHome === undefined) delete process.env.STATION_HOME;
      else process.env.STATION_HOME = oldHome;
      rmSync(fixture, { recursive: true, force: true });
    },
  };
}
