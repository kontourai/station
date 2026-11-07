import { agentId } from '@kontourai/station-contracts/agent-identity';
import { pairingScopePresetString } from '@kontourai/station-contracts/environment-security';
import {
  STATION_ENVELOPE_HEADER,
  STATION_ENVELOPE_HEADER_VALUE,
} from '@kontourai/station-contracts/http';
import {
  PEER_CHAT_UPLOAD_GRANT_HEADER,
  parsePeerChatConnection,
} from '@kontourai/station-contracts/peer-chat';
import {
  sendExecutionMessageWithInventory,
  setClientCredentialResolver,
} from '@kontourai/station-sdk/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { peerChatRuntime } from '../../__test-utils__/peer-chat-runtime.js';
import { createPeerChatRoutes } from '../../routes/environments/peer-chat-routes.js';
import { createAttachmentStagingRoutes } from '../../routes/orchestration/attachment-staging.js';
import { createOrchestrationRoutes } from '../../routes/orchestration/orchestration.js';
import {
  isBoundRuntimeOwner,
  isRuntimeRequestPrincipalCurrent,
  resolveInboundDeviceKindForRequest,
} from '../../security/runtime-request-security.js';
import { AttachmentStagingService } from '../../services/orchestration/attachment-staging-service.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { PeerCredentialStore } from '../../services/peers/peer-credential-store.js';
import { createRemoteStationForwarder } from '../../services/remote-stations/remote-station-forwarder.js';
import { pairedDevicePrincipal } from '../bootstrap/orchestration-request-principal.js';

const services = new Set<AttachmentStagingService>();
afterEach(() => {
  setClientCredentialResolver(undefined);
  for (const service of services) service.dispose();
  services.clear();
});

async function fixture() {
  const source = await peerChatRuntime();
  const receiver = await peerChatRuntime();
  const peerGrant = receiver.pair(
    pairingScopePresetString('delegation'),
    'delegation',
  );
  const receiverBase = await receiver.listen();
  const id = receiver.security.devicePairing.environmentId();
  const peers = new PeerCredentialStore(source.homeDir);
  await peers.upsert({
    environmentId: id,
    apiBase: receiverBase,
    credential: peerGrant.credential,
    scope: peerGrant.device.scope,
    label: 'Receiver',
  });
  const state = { enabled: true, generation: 0 };
  source.app.route(
    '/api/environments/peers',
    createPeerChatRoutes({
      peers,
      remote: createRemoteStationForwarder({
        peers,
        ssh: { list: () => [], connect: vi.fn() },
      }),
      current: (request) =>
        isRuntimeRequestPrincipalCurrent(request, source.security),
      owner: isBoundRuntimeOwner,
      preview: {
        select: (branches) =>
          state.enabled ? branches.enabled() : branches.disabled(),
      },
      previewGeneration: () => state.generation,
    }),
  );
  const owner = source.pair(pairingScopePresetString('standard'));
  const sourceBase = await source.listen();
  source.call = (path, credential, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${credential}`);
    return fetch(`${sourceBase}${path}`, {
      ...init,
      headers,
      credentials: 'omit',
      redirect: 'error',
    });
  };
  const prefix = `/api/environments/peers/${id}/chat-api`;
  return {
    source,
    receiver,
    peerGrant,
    receiverBase,
    id,
    peers,
    state,
    owner,
    prefix,
    sourceBase,
  };
}

async function readDescriptor(response: Response) {
  const body: unknown = await response.json();
  const descriptor =
    body && typeof body === 'object' && 'data' in body
      ? parsePeerChatConnection(body.data)
      : null;
  if (!descriptor)
    throw new Error('Receiver descriptor did not satisfy the public contract');
  return descriptor;
}

describe('peer tunnel through two real runtime admission boundaries', () => {
  test('the public SDK receives a real source-authored R401 observation without retiring S', async () => {
    const world = await fixture();
    const requestScope = {
      apiBase: world.sourceBase,
      authorityKey: 'source-http-lease',
    };
    const unauthorized = vi.fn();
    setClientCredentialResolver(() => ({
      origin: world.sourceBase,
      credential: world.owner.credential,
      requestAuthority: {
        ...requestScope,
        isCurrent: () =>
          world.source.security.verifyCredential(world.owner.credential),
      },
      onUnauthorized: unauthorized,
    }));
    world.receiver.security.devicePairing.revokeDevice(
      world.peerGrant.device.id,
      'operator-credential',
    );
    await expect(
      sendExecutionMessageWithInventory(
        `${world.sourceBase}${world.prefix}`,
        {
          target: { environment: { kind: 'current' }, agent: agentId('codex') },
          message: 'Hello',
          clientTurnId: 'http-key',
        },
        vi.fn(),
        { requestScope },
      ),
    ).rejects.toMatchObject({
      status: 424,
      stationEnvelope: true,
      details: {
        environmentId: world.id,
        remoteStatus: 401,
        mutationKey: 'http-key',
      },
    });
    expect(unauthorized).not.toHaveBeenCalled();
  });
  test('the descriptor binds receiver authority, survives source route replacement, and changes for a new receiver principal', async () => {
    const world = await fixture();
    const path = `/api/environments/peers/${world.id}/chat-connection`;
    const first = await world.source.call(path, world.owner.credential);
    expect(first.status).toBe(200);
    const before = await readDescriptor(first);
    expect(JSON.parse(before.principalNamespace)[2]).toBe(
      pairedDevicePrincipal(world.peerGrant.device, undefined).id,
    );
    expect(JSON.stringify(before)).not.toContain(world.peerGrant.credential);
    const restartedSource = await peerChatRuntime(world.source.homeDir);
    restartedSource.app.route(
      '/api/environments/peers',
      createPeerChatRoutes({
        peers: world.peers,
        remote: createRemoteStationForwarder({
          peers: world.peers,
          ssh: { list: () => [], connect: vi.fn() },
        }),
        current: (request) =>
          isRuntimeRequestPrincipalCurrent(request, restartedSource.security),
        owner: isBoundRuntimeOwner,
        preview: { select: (branches) => branches.enabled() },
      }),
    );
    expect(
      (
        await readDescriptor(
          await restartedSource.call(path, world.owner.credential),
        )
      ).principalNamespace,
    ).toBe(before.principalNamespace);
    const replacement = world.receiver.pair(
      pairingScopePresetString('delegation'),
      'delegation',
    );
    await world.peers.upsert({
      environmentId: world.id,
      apiBase: world.receiverBase,
      credential: replacement.credential,
      scope: replacement.device.scope,
    });
    expect(
      (
        await readDescriptor(
          await world.source.call(path, world.owner.credential),
        )
      ).principalNamespace,
    ).not.toBe(before.principalNamespace);
  });
  test('person-bound devices, personal tokens, and agent-origin owners cannot borrow source standing', async () => {
    const world = await fixture();
    const person = world.source.pair(
      pairingScopePresetString('standard'),
      'device',
      'casey',
    );
    const token = await world.source.security.devicePairing.mintPersonalToken({
      name: 'Casey script',
      binding: person.device.principalBinding!,
      ownerPrincipalId: 'human:tailscale-serve:casey',
      scope: 'orchestration:read orchestration:operate',
      expiresAt: null,
    });
    const reached = vi.fn();
    world.receiver.app.get('/api/projects', (c) => {
      reached();
      return c.json([]);
    });
    for (const credential of [person.credential, token.secret])
      expect(
        (await world.source.call(`${world.prefix}/api/projects`, credential))
          .status,
      ).toBe(403);
    expect(
      (
        await world.source.call(
          `${world.prefix}/api/projects`,
          world.owner.credential,
          { headers: { 'x-station-control-origin': 'agent-tool' } },
        )
      ).status,
    ).toBe(403);
    expect(reached).not.toHaveBeenCalled();
  });

  test('a receiver scope refusal becomes target 424 before dispatch', async () => {
    const world = await fixture();
    const narrow = world.receiver.pair(
      pairingScopePresetString('read-only'),
      'delegation',
    );
    await world.peers.upsert({
      environmentId: world.id,
      apiBase: world.receiverBase,
      credential: narrow.credential,
      scope: narrow.device.scope,
    });
    const response = await world.source.call(
      `${world.prefix}/api/orchestration/chat`,
      world.owner.credential,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: { environment: { kind: 'current' }, agent: 'codex' },
          clientTurnId: 'scope-one',
          message: 'Hello',
        }),
      },
    );
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      details: {
        remoteStatus: 403,
        failureAuthority: 'target',
        environmentId: world.id,
        mutationKey: 'scope-one',
      },
    });
  });
  test('an owner Device reaches receiver dispatch as its delegation Device; current overrides a remote Project default', async () => {
    const world = await fixture();
    const dispatch = vi.fn(async (_input: unknown) => {
      throw new Error('Scripted dispatch reached');
    });
    world.receiver.app.route(
      '/api/orchestration',
      createOrchestrationRoutes(
        { hasSessionStartRecord: async () => false } as never,
        {
          eventBus: new EventBus(),
          logger: { debug() {} },
          getUserId: () => 'unresolved',
          resolvePrincipal: world.receiver.principal,
          isRequestPrincipalCurrent: (request) =>
            isRuntimeRequestPrincipalCurrent(request, world.receiver.security),
          resolveInboundDeviceKind: (c) =>
            resolveInboundDeviceKindForRequest(c.req.raw, (credential) =>
              world.receiver.security.identifyDevice(credential),
            ),
          projectDefaultEnvironment: () => ({
            kind: 'saved',
            id: 'third-station' as never,
          }),
          executeForegroundMessage: dispatch,
        },
      ),
    );
    const response = await world.source.call(
      `${world.prefix}/api/orchestration/chat`,
      world.owner.credential,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: {
            environment: { kind: 'current' },
            agent: 'codex',
            workspace: { kind: 'project', projectSlug: 'remote-default' },
          },
          conversationId: 'conversation:one',
          clientTurnId: 'one',
          message: 'Hello',
          whenBusy: 'queue',
        }),
      },
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    const answer = await response.json();
    expect({ answer, calls: dispatch.mock.calls.length }).toMatchObject({
      answer: { error: 'Scripted dispatch reached' },
      calls: 1,
    });
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      target: { environment: { kind: 'current' } },
      principal: {
        id: pairedDevicePrincipal(world.peerGrant.device, undefined).id,
      },
    });
  });

  test.each(['read-only', 'delegation'] as const)(
    '%s cannot borrow source owner standing',
    async (kind) => {
      const world = await fixture();
      const caller = world.source.pair(
        pairingScopePresetString(kind),
        kind === 'delegation' ? 'delegation' : 'device',
      );
      const reached = vi.fn();
      world.receiver.app.get('/api/projects', (c) => {
        reached();
        return c.json([]);
      });
      const response = await world.source.call(
        `${world.prefix}/api/projects`,
        caller.credential,
      );
      expect(response.status).toBe(403);
      expect(reached).not.toHaveBeenCalled();
    },
  );

  test('source revocation is S401; receiver revocation is a source-marked target 424 without the relay marker', async () => {
    const world = await fixture();
    world.receiver.app.get('/api/projects', (c) => c.json([]));
    world.receiver.security.devicePairing.revokeDevice(
      world.peerGrant.device.id,
      'operator-credential',
    );
    const response = await world.source.call(
      `${world.prefix}/api/projects`,
      world.owner.credential,
    );
    expect(response.status).toBe(424);
    expect(response.headers.get(STATION_ENVELOPE_HEADER)).toBe(
      STATION_ENVELOPE_HEADER_VALUE,
    );
    expect(await response.json()).toMatchObject({
      details: {
        failureAuthority: 'target',
        environmentId: world.id,
        remoteStatus: 401,
      },
    });
    world.source.security.devicePairing.revokeDevice(
      world.owner.device.id,
      'operator-credential',
    );
    expect(
      (
        await world.source.call(
          `${world.prefix}/api/projects`,
          world.owner.credential,
        )
      ).status,
    ).toBe(401);
  });

  test.each(['continue', 'inbox'] as const)(
    '%s refuses a persisted onward target at the receiver dispatch seam',
    async (leaf) => {
      const world = await fixture();
      let storedEnvironment = 'third-station';
      const continued = vi.fn(async () => {
        throw new Error('Local dispatch reached');
      });
      const submitted = vi.fn(() => ({ outcome: 'queued', entry: {} }));
      world.receiver.app.route(
        '/api/orchestration',
        createOrchestrationRoutes(
          {
            hasReadableSession: async () => true,
            readCurrentConversationSession: async () => ({
              events: [
                {
                  method: 'session.started',
                  metadata: { environmentId: storedEnvironment },
                },
              ],
            }),
          } as never,
          {
            eventBus: new EventBus(),
            logger: { debug() {} },
            resolvePrincipal: world.receiver.principal,
            isRequestPrincipalCurrent: (request) =>
              isRuntimeRequestPrincipalCurrent(
                request,
                world.receiver.security,
              ),
            resolveInboundDeviceKind: (c) =>
              resolveInboundDeviceKindForRequest(c.req.raw, (credential) =>
                world.receiver.security.identifyDevice(credential),
              ),
            receiverEnvironmentId: () => world.id,
            continueForegroundMessage: continued,
            threadInbox: {
              submit: submitted,
              heldByOther: () => false,
              inFlight: () => false,
            } as never,
          },
        ),
      );
      const path =
        leaf === 'continue'
          ? '/api/orchestration/chat/one/continue'
          : '/api/orchestration/conversations/one/inbox';
      const body =
        leaf === 'continue'
          ? {
              environment: { kind: 'current' },
              message: 'Hello',
              clientTurnId: 'turn-one',
            }
          : { kind: 'follow-up', key: 'turn-one', message: 'Hello' };
      const call = () =>
        world.source.call(`${world.prefix}${path}`, world.owner.credential, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      expect((await call()).status).toBe(424);
      expect(continued).not.toHaveBeenCalled();
      expect(submitted).not.toHaveBeenCalled();
      storedEnvironment = world.id;
      await call();
      expect(
        leaf === 'continue' ? continued : submitted,
      ).toHaveBeenCalledOnce();
    },
  );

  test('live bytes arrive before upstream end; source preview loss cuts idle streams', async () => {
    const world = await fixture();
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cancelled = vi.fn();
    world.receiver.app.get('/api/orchestration/events', (c) => {
      expect(c.req.header('Last-Event-ID')).toBe('42');
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            upstream = controller;
            controller.enqueue(
              new TextEncoder().encode('id: 43\ndata: first\n\n'),
            );
          },
          cancel: cancelled,
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    const abort = new AbortController();
    const response = await world.source.call(
      `${world.prefix}/api/orchestration/events`,
      world.owner.credential,
      { headers: { 'Last-Event-ID': '42' }, signal: abort.signal },
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      'data: first',
    );
    world.state.enabled = false;
    world.state.generation++;
    await expect(reader.read()).rejects.toThrow();
    await expect.poll(() => cancelled.mock.calls.length).toBe(1);
    expect(() =>
      upstream!.enqueue(new TextEncoder().encode('data: leaked\n\n')),
    ).toThrow();
    abort.abort();
  });

  test('receiver grant revocation cuts its idle orchestration stream and the next read identifies target auth', async () => {
    const world = await fixture();
    world.receiver.app.route(
      '/api/orchestration',
      createOrchestrationRoutes(
        {
          listSessionReadModel: async () => [],
          readEventStreamHead: () => 0,
          retainSessionDeletionReader: () => () => {},
          conversationStreamBinding: () => undefined,
        } as never,
        {
          eventBus: new EventBus(),
          logger: { debug() {} },
          resolvePrincipal: world.receiver.principal,
          isRequestPrincipalCurrent: (request) =>
            isRuntimeRequestPrincipalCurrent(request, world.receiver.security),
          resolveInboundDeviceKind: (c) =>
            resolveInboundDeviceKindForRequest(c.req.raw, (credential) =>
              world.receiver.security.identifyDevice(credential),
            ),
        },
      ),
    );
    const response = await world.source.call(
      `${world.prefix}/api/orchestration/events`,
      world.owner.credential,
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let text = '';
    while (!text.includes('orchestration:caughtUp')) {
      const next = await reader.read();
      expect(next.done).toBe(false);
      text += new TextDecoder().decode(next.value);
    }
    world.receiver.security.devicePairing.revokeDevice(
      world.peerGrant.device.id,
      'operator-credential',
    );
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(
      (
        await world.source.call(
          `${world.prefix}/api/orchestration/events`,
          world.owner.credential,
        )
      ).status,
    ).toBe(424);
  });

  test.each(['source', 'peer', 'disconnect'] as const)(
    '%s currency loss cuts idle forwarding and cancels upstream',
    async (change) => {
      const world = await fixture();
      const cancelled = vi.fn();
      world.receiver.app.get(
        '/api/orchestration/events',
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('data: first\n\n'));
              },
              cancel: cancelled,
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      );
      const abort = new AbortController();
      const response = await world.source.call(
        `${world.prefix}/api/orchestration/events`,
        world.owner.credential,
        { signal: abort.signal },
      );
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        'first',
      );
      if (change === 'source')
        world.source.security.devicePairing.revokeDevice(
          world.owner.device.id,
          'operator-credential',
        );
      else if (change === 'peer')
        await world.peers.upsert({
          environmentId: world.id,
          apiBase: world.receiverBase,
          credential: world.receiver.pair(
            pairingScopePresetString('delegation'),
            'delegation',
          ).credential,
          scope: world.peerGrant.device.scope,
        });
      else abort.abort();
      await expect(reader.read()).rejects.toThrow();
      await expect.poll(() => cancelled.mock.calls.length).toBe(1);
    },
  );

  test('upload uses source Device authorization and a distinct stage grant only at receiver PUT', async () => {
    const world = await fixture();
    let now = Date.UTC(2026, 10, 4);
    const service = new AttachmentStagingService(() => now, 1000);
    services.add(service);
    world.receiver.app.route(
      '/api/orchestration/attachment-staging',
      createAttachmentStagingRoutes({
        service,
        currentOwner: (c) => ({
          principalId: world.receiver.principal(c as never).id,
        }),
      }),
    );
    const prepared = await world.source.call(
      `${world.prefix}/api/orchestration/attachment-staging/prepare`,
      world.owner.credential,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientAttachmentId: 'file',
          kind: 'file',
          name: 'a.txt',
          mimeType: 'text/plain',
          size: 5,
        }),
      },
    );
    expect(prepared.status).toBe(200);
    const stage = (await prepared.json()) as {
      stageId: string;
      uploadGrant: string;
    };
    const upload = (grant: string) =>
      world.source.call(
        `${world.prefix}/api/orchestration/attachment-staging/${stage.stageId}`,
        world.owner.credential,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'text/plain;charset=utf-8',
            [PEER_CHAT_UPLOAD_GRANT_HEADER]: grant,
          },
          body: 'data:text/plain;base64,aGVsbG8=',
        },
      );
    const foreign = service.prepare(
      { principalId: 'other-person' },
      {
        clientAttachmentId: 'other-file',
        kind: 'file',
        name: 'other.txt',
        mimeType: 'text/plain',
        size: 5,
      },
    );
    expect((await upload(world.owner.credential)).status).toBe(424);
    expect((await upload(foreign.uploadGrant)).status).toBe(424);
    expect((await upload(stage.uploadGrant)).status).toBe(200);
    const cancelled = await world.source.call(
      `${world.prefix}/api/orchestration/attachment-staging/${stage.stageId}`,
      world.owner.credential,
      { method: 'DELETE' },
    );
    expect(cancelled.status).toBe(204);
    expect((await upload(stage.uploadGrant)).status).toBeGreaterThanOrEqual(
      400,
    );
    now += 1001;
    expect((await upload(stage.uploadGrant)).status).toBe(409);
  });
});
