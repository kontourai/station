import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { type ClientRequest, request as nodeRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts';
import { parseProjectTaskRoomBrowserLiveSnapshot } from '@kontourai/station-contracts/project-task-room-browser';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createProjectTaskRoomRoutes } from '../../routes/orchestration/project-task-rooms.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { ProjectTaskRoomRuntime } from '../../services/orchestration/project-task-room-runtime.js';
import type { Logger } from '../../utils/logger.js';
import { configureRuntimeHttp } from '../bootstrap/runtime-http.js';

const ORIGIN = 'https://station.two-context.test';
const TASK_ID = 'task-two-context';
const PROJECT_ID = 'project-two-context';
const credentials = {
  alpha: 'two-context-alpha-credential',
  bravo: 'two-context-bravo-credential',
} as const;
const directories: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

type DeviceName = keyof typeof credentials;
type SseEvent = { event: string; data: any };

class SseClient {
  readonly events: SseEvent[] = [];
  readonly frames: string[] = [];
  #request: ClientRequest | undefined;
  #error: unknown;
  #responseEnded: Promise<void> | undefined;

  async connect(url: string, credential: string) {
    await new Promise<void>((resolve, reject) => {
      const parsed = new URL(url);
      const timer = setTimeout(
        () => reject(new Error('timed out opening SSE stream')),
        5_000,
      );
      const request = nodeRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: `${parsed.pathname}${parsed.search}`,
          method: 'GET',
          headers: { Authorization: `Bearer ${credential}` },
        },
        (response) => {
          clearTimeout(timer);
          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(`SSE response was ${response.statusCode}`));
            return;
          }
          if (
            !response.headers['content-type']?.includes('text/event-stream')
          ) {
            response.resume();
            reject(new Error('SSE response had the wrong content type'));
            return;
          }
          response.setEncoding('utf8');
          this.#responseEnded = new Promise((resolve) => {
            let ended = false;
            const finish = () => {
              if (ended) return;
              ended = true;
              resolve();
            };
            response.once('end', finish);
            response.once('close', finish);
          });
          let buffer = '';
          response.on('data', (chunk: string) => {
            buffer += chunk;
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              boundary = buffer.indexOf('\n\n');
              const event = frame.match(/^event: (.+)$/m)?.[1];
              const data = frame.match(/^data: ?(.*)$/m)?.[1];
              if (event && data !== undefined) {
                this.frames.push(frame);
                this.events.push({
                  event,
                  data: data ? JSON.parse(data) : undefined,
                });
              }
            }
          });
          response.once('error', (error) => {
            this.#error = error;
          });
          resolve();
        },
      );
      request.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      this.#request = request;
      request.end();
    });
  }

  async waitFor(predicate: (event: SseEvent) => boolean) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (this.#error) throw this.#error;
      const event = this.events.find(predicate);
      if (event) return event;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `timed out waiting for SSE event; observed ${this.events.map((event) => event.event).join(', ')}`,
    );
  }

  close() {
    this.#request?.destroy();
  }

  async waitForEnd() {
    const ended = this.#responseEnded;
    if (!ended) throw new Error('SSE response was never opened');
    await Promise.race([
      ended,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('timed out closing SSE stream')),
          5_000,
        ),
      ),
    ]);
  }
}

function logger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    setLevel: vi.fn(),
    getLevel: vi.fn(() => 'info' as const),
  };
}

function createRuntime(databasePath: string, grants: Map<string, DeviceName>) {
  const store = new EventStore(databasePath);
  const task = {
    id: TASK_ID,
    projectId: PROJECT_ID,
    title: 'Two-context acceptance room',
    description: '',
    priority: 'normal',
    status: 'ready',
    createdBy: 'operator-1',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  } as const;
  const runtime = new ProjectTaskRoomRuntime({
    taskGraph: { readTaskView: (id) => (id === TASK_ID ? task : null) },
    projectForId: (id) =>
      id === PROJECT_ID ? { id, slug: 'two-context' } : undefined,
    history: (authority) =>
      store.createProjectTaskRoomHistory({
        capabilities: authority.capabilities,
        agents: authority.agents,
      }),
    working: store.createProjectTaskRoomWorkingState(),
    requestAuthority: {
      resolve: async (request) => {
        const principal = getRuntimeAuthenticatedRequestPrincipal(request);
        const device = principal ? grants.get(principal.credential) : undefined;
        return device
          ? {
              kind: 'granted' as const,
              operatorId: 'operator-1',
              deviceId: `device-${device}`,
              policyRevision: `pairing-${device}`,
            }
          : { kind: 'revoked' as const };
      },
    },
  });
  return { runtime, store };
}

async function listenRoomApi(
  databasePath: string,
  grants: Map<string, DeviceName>,
) {
  const { runtime, store } = createRuntime(databasePath, grants);
  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: logger(),
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
      verifyCredential: (credential) => grants.has(credential),
      resolveCredentialAuthority: () => 'device-credential',
      resolveGrantedScope: (credential) =>
        grants.has(credential) ? DEFAULT_GRANT_PAIRING_SCOPE : undefined,
      allowedOrigins: [ORIGIN],
    },
  });
  app.route('/api/tasks', createProjectTaskRoomRoutes(runtime));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('room test listener has no port');
  const close = async () => {
    // Long-lived SSE connections are deliberately part of this proof. Close
    // their owned sockets before awaiting the listener so test cleanup cannot
    // depend on an HTTP keep-alive timeout.
    const http1 = server as typeof server & {
      closeAllConnections?: () => void;
    };
    http1.closeAllConnections?.();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.close();
    store.close();
  };
  closers.push(close);
  return { baseUrl: `http://127.0.0.1:${address.port}`, close };
}

function client(baseUrl: string, device: DeviceName) {
  const credential = credentials[device];
  return async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${credential}`);
    if (init.method && init.method !== 'GET') headers.set('Origin', ORIGIN);
    return fetch(`${baseUrl}${path}`, { ...init, headers });
  };
}

function opaqueActorId(device: DeviceName) {
  return `human:${createHash('sha256')
    .update(`operator-1\u0000device-${device}`)
    .digest('hex')}`;
}

async function json(response: Response) {
  expect(response.status).toBe(200);
  return response.json() as Promise<{ success: boolean; data: any }>;
}

describe('Project Task room two-context HTTP acceptance (#2888)', () => {
  test('keeps two paired devices distinct while converging durable room history, live state, document state, revocation, and restart recovery', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-two-context-room-'));
    directories.push(directory);
    const databasePath = join(directory, 'orchestration.sqlite');
    const grants = new Map<string, DeviceName>([
      [credentials.alpha, 'alpha'],
      [credentials.bravo, 'bravo'],
    ]);
    let api = await listenRoomApi(databasePath, grants);
    const alpha = client(api.baseUrl, 'alpha');
    const bravo = client(api.baseUrl, 'bravo');
    const roomPath = `/api/tasks/${TASK_ID}/room`;

    const [alphaRoom, bravoRoom] = await Promise.all([
      json(await alpha(roomPath)),
      json(await bravo(roomPath)),
    ]);
    expect(alphaRoom.data).toMatchObject({
      kind: expect.stringMatching(/opened|existing/),
      scope: { taskId: TASK_ID },
    });
    expect(bravoRoom.data).toMatchObject({
      kind: expect.stringMatching(/opened|existing/),
      scope: { taskId: TASK_ID },
    });

    const alphaEvents = new SseClient();
    const bravoEvents = new SseClient();
    await Promise.all([
      alphaEvents.connect(
        `${api.baseUrl}${roomPath}/events`,
        credentials.alpha,
      ),
      bravoEvents.connect(
        `${api.baseUrl}${roomPath}/events`,
        credentials.bravo,
      ),
    ]);
    await Promise.all([
      alphaEvents.waitFor((event) => event.event === 'snapshot'),
      bravoEvents.waitFor((event) => event.event === 'snapshot'),
    ]);

    expect(
      (
        await json(
          await alpha(`${roomPath}/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              proposalId: 'alpha-message',
              text: 'I am working on this.',
            }),
          }),
        )
      ).data.kind,
    ).toBe('committed');
    for (const stream of [alphaEvents, bravoEvents])
      await stream.waitFor(
        (event) =>
          event.event === 'room' &&
          event.data.type === 'history' &&
          event.data.records.some(
            (record: any) => record.body.text === 'I am working on this.',
          ),
      );
    const durable = await json(await bravo(`${roomPath}/history`));
    expect(durable.data.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: { kind: 'human-message', text: 'I am working on this.' },
        }),
      ]),
    );

    const commandLive = async (
      request: typeof alpha,
      command: Record<string, unknown>,
      outcome: string,
    ) => {
      const data = (
        await json(
          await request(`${roomPath}/live`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(command),
          }),
        )
      ).data;
      expect(data.kind).toBe('available');
      expect(data.result.outcome).toBe(outcome);
      return data;
    };
    await commandLive(
      alpha,
      { command: 'join', requestId: 'alpha-join' },
      'joined',
    );
    await commandLive(
      bravo,
      { command: 'join', requestId: 'bravo-join' },
      'joined',
    );
    await commandLive(
      alpha,
      { command: 'announce', requestId: 'alpha-announce' },
      'updated',
    );
    await commandLive(
      bravo,
      { command: 'announce', requestId: 'bravo-announce' },
      'updated',
    );
    await commandLive(bravo, { command: 'typing', active: true }, 'updated');
    const watching = await commandLive(
      bravo,
      {
        command: 'watch',
        paneId: 'task-pane',
        targetActorId: opaqueActorId('alpha'),
      },
      'updated',
    );
    expect(watching.snapshot.panes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: opaqueActorId('bravo'),
          targetActorId: opaqueActorId('alpha'),
          state: 'watching',
        }),
      ]),
    );
    const following = await commandLive(
      bravo,
      {
        command: 'follow',
        paneId: 'task-pane',
        targetActorId: opaqueActorId('alpha'),
      },
      'updated',
    );
    const preRestartLiveSnapshot = following.snapshot;
    const live = await bravoEvents.waitFor(
      (event) =>
        event.event === 'room' &&
        event.data.type === 'live' &&
        event.data.snapshot?.participants?.length === 2 &&
        event.data.snapshot.panes.some(
          (pane: any) =>
            pane.actorId === opaqueActorId('bravo') &&
            pane.targetActorId === opaqueActorId('alpha') &&
            pane.state === 'following',
        ),
    );
    await alphaEvents.waitFor(
      (event) =>
        event.event === 'room' &&
        event.data.type === 'live' &&
        event.data.snapshot?.participants?.length === 2,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const latestAlphaLive = alphaEvents.events
      .filter((event) => event.event === 'room' && event.data.type === 'live')
      .at(-1);
    expect(latestAlphaLive?.data.snapshot.participants).toHaveLength(2);
    expect(latestAlphaLive?.data.snapshot.panes).toEqual([]);
    const publishedActors = live.data.snapshot.participants.map(
      (participant: any) => participant.actor.actorId,
    );
    const bravoProjection = parseProjectTaskRoomBrowserLiveSnapshot(live.data);
    const alphaProjection = parseProjectTaskRoomBrowserLiveSnapshot(
      latestAlphaLive?.data,
    );
    expect(bravoProjection?.participants).toHaveLength(2);
    expect(alphaProjection?.participants).toHaveLength(2);
    expect(bravoProjection?.viewerActorId).toBe(opaqueActorId('bravo'));
    expect(alphaProjection?.viewerActorId).toBe(opaqueActorId('alpha'));
    // Browser projections intentionally pseudonymize paired-device identities.
    // Distinct opaque actors prove the server did not collapse the two device
    // credentials while keeping raw operator/device values out of the wire.
    expect(new Set(publishedActors).size).toBe(2);
    expect(publishedActors.sort()).toEqual(
      [opaqueActorId('alpha'), opaqueActorId('bravo')].sort(),
    );
    expect(live.data.snapshot.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          publication: 'published',
          actor: expect.objectContaining({
            actorId: opaqueActorId('alpha'),
            kind: 'human',
          }),
        }),
        expect.objectContaining({
          publication: 'published',
          actor: expect.objectContaining({
            actorId: opaqueActorId('bravo'),
            kind: 'human',
          }),
        }),
      ]),
    );
    expect(alphaEvents.frames.join('\n')).not.toContain('device-alpha');
    expect(alphaEvents.frames.join('\n')).not.toContain('device-bravo');
    expect(bravoEvents.frames.join('\n')).not.toContain('device-alpha');
    expect(bravoEvents.frames.join('\n')).not.toContain('device-bravo');
    const announced = await json(await alpha(`${roomPath}/history`));
    const announcedStarts = announced.data.records.filter(
      (record: any) => record.body.kind === 'live-work-started',
    );
    expect(announcedStarts).toHaveLength(2);
    const announcedActorLabels = announcedStarts.map(
      (record: any) => record.actor.label,
    );
    expect(new Set(announcedActorLabels).size).toBe(2);

    const plan = (
      await json(
        await alpha(`${roomPath}/edit-plan`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            intentId: 'client-supplied-but-server-minted',
            desiredText: 'shared document',
            selection: { anchor: 15, focus: 15 },
          }),
        }),
      )
    ).data;
    expect(plan).toMatchObject({
      kind: 'planned',
      operationCount: expect.any(Number),
    });
    expect(plan.intentId).not.toBe('client-supplied-but-server-minted');
    const plannedWire = JSON.stringify(plan);
    expect(plannedWire).not.toMatch(
      /atoms|operations|device-alpha|device-bravo/i,
    );
    expect(plan).not.toHaveProperty('operations');
    const settled = await json(
      await alpha(`${roomPath}/batches`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          intentId: plan.intentId,
          intentDigest: plan.digest,
        }),
      }),
    );
    expect(settled.data).toMatchObject({
      kind: 'committed',
      text: 'shared document',
    });
    const preRestartDocument = settled.data;
    expect(preRestartDocument.revision).toMatch(/^swsr-v1:[0-9a-f]{64}$/);
    const duplicate = await json(
      await alpha(`${roomPath}/batches`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          intentId: plan.intentId,
          intentDigest: plan.digest,
        }),
      }),
    );
    expect(duplicate.data).toMatchObject({
      kind: 'duplicate',
      text: 'shared document',
    });
    expect(duplicate.data).toMatchObject({
      revision: preRestartDocument.revision,
      text: preRestartDocument.text,
    });
    await bravoEvents.waitFor(
      (event) =>
        event.event === 'document' && event.data.text === 'shared document',
    );
    expect(
      (await json(await bravo(`${roomPath}/document`))).data,
    ).toMatchObject({ text: 'shared document' });
    const cursor = await commandLive(
      alpha,
      {
        command: 'cursor',
        generation: following.generation,
        workingRevision: preRestartDocument.revision,
        selection: { anchor: 0, focus: 6 },
      },
      'updated',
    );
    expect(cursor.snapshot.cursors).toEqual([
      {
        actorId: opaqueActorId('alpha'),
        workingRevision: preRestartDocument.revision,
        selection: { anchor: 0, focus: 6 },
        expiresAt: expect.any(Number),
      },
    ]);
    await bravoEvents.waitFor(
      (event) =>
        event.event === 'room' &&
        event.data.type === 'live' &&
        event.data.snapshot?.cursors?.some(
          (item: any) =>
            item.actorId === opaqueActorId('alpha') &&
            item.workingRevision === preRestartDocument.revision &&
            item.selection.anchor === 0 &&
            item.selection.focus === 6,
        ),
    );
    const staleCursor = await commandLive(
      alpha,
      {
        command: 'cursor',
        generation: following.generation,
        workingRevision: 'stale-revision',
        selection: { anchor: 0, focus: 0 },
      },
      'invalid',
    );
    expect(staleCursor.snapshot.cursors).toHaveLength(1);

    // Revocation is evaluated at the canonical middleware/request-authority seam
    // on every operation; an already-open SSE gets a terminal event before it
    // can receive any later content.
    const revocationEventIndex = bravoEvents.events.length;
    grants.delete(credentials.bravo);
    expect((await bravo(`${roomPath}/document`)).status).toBe(401);
    expect(
      (
        await bravo(`${roomPath}/live`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command: 'heartbeat' }),
        })
      ).status,
    ).toBe(401);
    expect((await bravo(`${roomPath}/events`)).status).toBe(401);
    await json(
      await alpha(`${roomPath}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          proposalId: 'after-bravo-revocation',
          text: 'private after revocation',
        }),
      }),
    );
    await alphaEvents.waitFor(
      (event) =>
        event.event === 'room' &&
        event.data.type === 'history' &&
        event.data.records.some(
          (record: any) => record.body.text === 'private after revocation',
        ),
    );
    await bravoEvents.waitFor((event) => event.event === 'terminal');
    await bravoEvents.waitForEnd();
    const afterRevocation = bravoEvents.events.slice(revocationEventIndex);
    const terminalIndex = afterRevocation.findIndex(
      (event) => event.event === 'terminal',
    );
    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(afterRevocation)).not.toContain(
      'private after revocation',
    );
    expect(afterRevocation.slice(terminalIndex + 1)).toEqual([]);
    await json(
      await alpha(`${roomPath}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          proposalId: 'after-terminal',
          text: 'later alpha message',
        }),
      }),
    );
    expect(JSON.stringify(bravoEvents.events)).not.toContain(
      'later alpha message',
    );

    alphaEvents.close();
    bravoEvents.close();
    await api.close();
    closers.splice(closers.indexOf(api.close), 1);

    // A fresh runtime and real listener reopen the same SQLite event and
    // working-state stores. Recovery must publish the durable room exactly
    // once: retained history and the private document converge without a
    // duplicate human message or a duplicate live-work lifecycle record.
    api = await listenRoomApi(databasePath, grants);
    const afterRestart = client(api.baseUrl, 'alpha');
    const restartedHistory = await json(
      await afterRestart(`${roomPath}/history`),
    );
    expect(
      restartedHistory.data.records.filter(
        (record: any) => record.body.text === 'I am working on this.',
      ),
    ).toHaveLength(1);
    expect(
      restartedHistory.data.records.filter(
        (record: any) => record.body.kind === 'live-work-started',
      ),
    ).toHaveLength(2);
    const restartedDocument = (
      await json(await afterRestart(`${roomPath}/document`))
    ).data;
    expect(restartedDocument).toMatchObject({
      text: preRestartDocument.text,
      revision: preRestartDocument.revision,
    });
    const restartedStream = new SseClient();
    await restartedStream.connect(
      `${api.baseUrl}${roomPath}/events`,
      credentials.alpha,
    );
    const restartedSnapshot = await restartedStream.waitFor(
      (event) => event.event === 'snapshot',
    );
    expect(restartedSnapshot.data.document).toMatchObject({
      text: preRestartDocument.text,
      revision: preRestartDocument.revision,
    });
    expect(restartedSnapshot.data.live.generation).not.toBe(
      preRestartLiveSnapshot.generation,
    );
    expect(restartedSnapshot.data.live.participants).toEqual([]);
    const recoveredHistory = await json(
      await afterRestart(`${roomPath}/history`),
    );
    const recoveredStarts = recoveredHistory.data.records.filter(
      (record: any) => record.body.kind === 'live-work-started',
    );
    const recoveredEnds = recoveredHistory.data.records.filter(
      (record: any) => record.body.kind === 'live-work-presence-ended',
    );
    expect(recoveredStarts).toHaveLength(2);
    expect(recoveredEnds).toHaveLength(2);
    expect(
      recoveredStarts.map((record: any) => record.actor.label).sort(),
    ).toEqual([...announcedActorLabels].sort());
    expect(
      recoveredEnds.map((record: any) => record.actor.label).sort(),
    ).toEqual([...announcedActorLabels].sort());

    const restartCommand = async (
      command: Record<string, unknown>,
      expectedOutcome: string,
    ) => {
      const outcome = await json(
        await afterRestart(`${roomPath}/live`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(command),
        }),
      );
      expect(outcome.data.kind).toBe('available');
      expect(outcome.data.result.outcome).toBe(expectedOutcome);
      return outcome.data;
    };
    await restartCommand(
      { command: 'join', requestId: 'restart-alpha-join' },
      'joined',
    );
    const restartedAnnounce = await restartCommand(
      { command: 'announce', requestId: 'restart-alpha-announce' },
      'updated',
    );
    expect(restartedAnnounce.snapshot.participants).toEqual([
      expect.objectContaining({
        publication: 'published',
        actor: expect.objectContaining({ actorId: opaqueActorId('alpha') }),
      }),
    ]);
    const restartedWatch = await restartCommand(
      {
        command: 'watch',
        paneId: 'restart-pane',
        targetActorId: opaqueActorId('alpha'),
      },
      'updated',
    );
    expect(restartedWatch.snapshot.panes).toEqual([
      expect.objectContaining({
        actorId: opaqueActorId('alpha'),
        targetActorId: opaqueActorId('alpha'),
        state: 'watching',
      }),
    ]);
    const restartedFollow = await restartCommand(
      {
        command: 'follow',
        paneId: 'restart-pane',
        targetActorId: opaqueActorId('alpha'),
      },
      'updated',
    );
    expect(restartedFollow.snapshot.panes).toEqual([
      expect.objectContaining({
        actorId: opaqueActorId('alpha'),
        targetActorId: opaqueActorId('alpha'),
        state: 'following',
      }),
    ]);
    const restartedDepart = await restartCommand(
      { command: 'depart', requestId: 'restart-alpha-depart' },
      'updated',
    );
    expect(restartedDepart.snapshot.participants).toEqual([]);
    restartedStream.close();
  }, 30_000);
});
