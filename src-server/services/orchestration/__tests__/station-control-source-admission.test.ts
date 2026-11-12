import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { Hono } from 'hono';
import { test } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { readObservedSdkProviderCredential } from '../../../runtime/conversation/provider-credential-observation.js';
import { RuntimeFencedCredentialObservationOwner } from '../../../runtime/conversation/runtime-fenced-credential-observation.js';
import {
  createStationControlCallerRecordResolver,
  resolveStationControlCallerForRequest,
  stationControlCallerRecordSources,
} from '../../../runtime/mcp/station-control-caller.js';
import {
  mintStationControlMcpToken,
  revokeStationControlMcpToken,
} from '../../../runtime/mcp/station-control-mcp-token.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { createStationControlAuthorityGuard } from '../../../security/station-control-authority-guard.js';
import { STATION_CONTROL_CALLER_TOKEN_HEADER } from '../../../tools/station-control-shared.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
} from '../../../utils/internal-api-token.js';
import { ProjectManifestStore } from '../../projects/project-manifest-store.js';
import { ProjectMembershipService } from '../../projects/project-membership-service.js';
import { ProjectMembershipStore } from '../../projects/project-membership-store.js';
import { ProjectService } from '../../projects/project-service.js';
import {
  LocalSourceAdmissionOwner,
  readStationControlSourceCredentialAuthority,
} from '../delegation-group-source-admission.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { SESSION_LOCAL_PROJECT_ID_METADATA_KEY } from '../session-project-identity.js';
import { setup } from './delegation-source-fixtures/report.js';
import { selection, subject } from './delegation-source-fixtures/source.js';

test('guarded bound Session source custody survives token rotation and refuses foreign or revoked authority', async () => {
  const h = await setup();
  const f = h.f;
  const reviewer = await f.loader.loadAgent('reviewer');
  await f.loader.saveAgent('reviewer', { ...reviewer, project: 'source' });
  const person = humanPrincipal('test', 'source-owner', 'Source owner');
  const eventStore = new EventStore(join(f.root, 'source-session.sqlite'));
  const adapter = new GateTestAdapter();
  const orchestration = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore,
    logger: { debug() {}, warn() {} },
  });
  const db = new DatabaseSync(
    join(f.home, 'security', 'source-membership.sqlite'),
  );
  const store = new ProjectMembershipStore(db, f.record.environmentId);
  const projects = new ProjectService(f.storage);
  const membership = new ProjectMembershipService(
    f.record.environmentId,
    f.storage,
    new ProjectManifestStore(f.home, f.storage),
    store,
  );
  const scope = {
    stationId: f.record.environmentId,
    localProjectId: 'persistent-local-project',
    localProjectSlug: 'source',
    portableProjectId: 'prj_persistent',
  };
  store.enable(scope, person);
  const addSession = (id: string, userId: string, projectId: string) => {
    eventStore.appendEvent({
      eventId: `${id}:start`,
      threadId: id,
      sessionId: id,
      provider: 'claude',
      method: 'session.started',
      createdAt: new Date().toISOString(),
      metadata: {
        userId,
        projectSlug: 'source',
        [SESSION_LOCAL_PROJECT_ID_METADATA_KEY]: projectId,
      },
    });
    eventStore.upsertSession({
      threadId: id,
      provider: 'claude',
      status: 'closed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  };
  addSession('source-session', person.id, scope.localProjectId);
  addSession(
    'foreign-session',
    humanPrincipal('test', 'foreign', 'Foreign').id,
    scope.localProjectId,
  );
  const records = createStationControlCallerRecordResolver(
    stationControlCallerRecordSources({
      orchestrationService: orchestration,
      eventStore,
      getProject: (slug) => projects.getProject(slug),
      coordinatorEnabled: () => false,
    }),
  );
  const source = new LocalSourceAdmissionOwner(f.home, f.environment, f.store, {
    orchestration,
    eventStore,
    projects,
    membership,
    coordinatorEnabled: () => false,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
      kind: 'internal',
      credential: 'internal-token',
      authority: undefined,
      source: 'bearer',
      locality: 'home-possession',
    });
    await next();
  });
  app.use(
    '*',
    createStationControlAuthorityGuard({
      resolveCaller: (request) =>
        resolveStationControlCallerForRequest(request, records),
      isOperatorPrincipal: () => false,
    }),
  );
  let retained: Awaited<ReturnType<typeof source.captureSnapshot>> | undefined;
  let firstRequest: Request | undefined;
  let firstCapability: object | undefined;
  let firstCredential:
    | Awaited<
        ReturnType<
          RuntimeFencedCredentialObservationOwner['captureAgentSdkCredential']
        >
      >['credential']
    | undefined;
  let reopenedCapability: object | undefined;
  let reopenedRequest: Request | undefined;
  let reopenedSnapshot: object | undefined;
  let firstOwnerIdentity: string | undefined;
  app.post('/api/orchestration/session-groups', async (c) => {
    try {
      const requestAuthority = await source.captureRequestAuthority(c);
      if (firstOwnerIdentity === undefined)
        firstOwnerIdentity = requestAuthority.ownerIdentity;
      else assert.equal(requestAuthority.ownerIdentity, firstOwnerIdentity);
      if (!retained) {
        retained = await source.captureSnapshot(c, subject, selection);
        firstRequest = c.req.raw;
        const capability =
          await source.captureStationControlCredentialAuthority(
            c,
            subject,
            retained.capability,
            'reviewer',
          );
        firstCapability = capability;
        readStationControlSourceCredentialAuthority(
          capability,
          c.req.raw,
        ).assertMayCapture();
        const credentials = new RuntimeFencedCredentialObservationOwner(
          h.preparationOwners.runtime,
        );
        const selected = await credentials.captureAgentSdkCredential(
          c.req.raw,
          'reviewer',
          capability,
        );
        firstCredential = selected.credential;
        assert.throws(() =>
          readStationControlSourceCredentialAuthority({}, c.req.raw),
        );
        assert.equal(
          readObservedSdkProviderCredential(
            selected.credential,
            'anthropic',
            c.req.raw,
          ).provider,
          'anthropic',
        );
        await assert.rejects(
          credentials.captureAgentSdkCredential(
            c.req.raw,
            'foreign-agent',
            capability,
          ),
        );
      } else {
        const reopened = await source.readmitSnapshot(
          c,
          subject,
          retained.source,
        );
        const capability =
          await source.captureStationControlCredentialAuthority(
            c,
            subject,
            reopened.capability,
            'reviewer',
          );
        readStationControlSourceCredentialAuthority(
          capability,
          c.req.raw,
        ).assertMayCapture();
        reopenedCapability = capability;
        reopenedRequest = c.req.raw;
        reopenedSnapshot = reopened.capability;
      }
      return c.json({ ok: true });
    } catch (error) {
      return c.json(
        {
          ok: false,
          code:
            error instanceof Error && 'code' in error
              ? String(error.code)
              : 'refused',
        },
        403,
      );
    }
  });
  app.get('/api/orchestration/session-groups', async (c) => {
    try {
      const authority = await source.captureRequestAuthority(c);
      authority.assertCurrent();
      return c.json({ ownerIdentity: authority.ownerIdentity });
    } catch {
      return c.json({ error: 'unavailable' }, 403);
    }
  });
  const send = (token: string) =>
    app.request('http://127.0.0.1:43979/api/orchestration/session-groups', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
        [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
      },
      body: '{}',
    });
  try {
    const first = mintStationControlMcpToken(
      'source-session',
      'sdk-in-process',
    ).token;
    assert.equal((await send(first)).status, 200);
    assert.ok(retained && firstRequest);
    const record = JSON.parse(
      readFileSync(
        join(
          f.store,
          `snapshot-${retained.source.source_admission_receipt.id}.json`,
        ),
        'utf8',
      ),
    );
    assert.equal(record.payload.provenance.schema, 2);
    assert.equal(
      Object.hasOwn(record.payload.provenance, 'principalCredentialHash'),
      false,
    );
    const rotated = mintStationControlMcpToken(
      'source-session',
      'sdk-in-process',
    ).token;
    assert.throws(() =>
      readStationControlSourceCredentialAuthority(
        firstCapability!,
        firstRequest!,
      ),
    );
    assert.throws(() =>
      readObservedSdkProviderCredential(
        firstCredential!,
        'anthropic',
        firstRequest,
      ),
    );
    assert.equal((await send(first)).status, 403);
    assert.equal((await send(rotated)).status, 200);
    assert.ok(reopenedCapability && reopenedRequest);
    assert.doesNotThrow(() =>
      readStationControlSourceCredentialAuthority(
        reopenedCapability!,
        reopenedRequest!,
      ),
    );
    assert.throws(() =>
      readStationControlSourceCredentialAuthority(
        reopenedCapability!,
        new Request(reopenedRequest!),
      ),
    );
    const read = await app.request(
      'http://127.0.0.1:43979/api/orchestration/session-groups',
      {
        headers: {
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [STATION_CONTROL_CALLER_TOKEN_HEADER]: rotated,
        },
      },
    );
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { ownerIdentity: firstOwnerIdentity });
    const foreign = mintStationControlMcpToken(
      'foreign-session',
      'sdk-in-process',
    ).token;
    const foreignResponse = await send(foreign);
    assert.equal(foreignResponse.status, 403);
    assert.deepEqual(await foreignResponse.json(), {
      ok: false,
      code: 'station_control_project_unavailable',
    });
    await f.storage.deleteProject('source');
    await f.storage.createProject({
      id: 'replacement-project',
      name: 'Replacement',
      slug: 'source',
      workingDirectory: f.repo,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    assert.throws(() =>
      readStationControlSourceCredentialAuthority(
        reopenedCapability!,
        reopenedRequest!,
      ),
    );
    assert.equal((await send(rotated)).status, 403);
    const exposed = mintStationControlMcpToken(
      'source-session',
      'url-token',
    ).token;
    assert.equal((await send(exposed)).status, 403);
    revokeStationControlMcpToken('source-session');
    assert.equal((await send(exposed)).status, 403);
  } finally {
    if (reopenedSnapshot) source.releaseSnapshot(reopenedSnapshot);
    if (retained) source.releaseSnapshot(retained.capability);
    await orchestration.shutdown();
    eventStore.close();
    db.close();
  }
}, 60_000);
