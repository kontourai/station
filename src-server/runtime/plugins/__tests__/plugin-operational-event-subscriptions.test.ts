import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationalEventEnvelope } from '@kontourai/station-contracts/operational-event';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import {
  getPluginGrants,
  grantPermissions,
  revokeAllGrants,
} from '../../../services/plugins/plugin-permissions.js';
import { createPluginOperationalEventSubscriptionService } from '../plugin-operational-event-subscriptions.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function event(id: string): OperationalEventEnvelope {
  return {
    schemaVersion: 'station.operational-event/v1',
    id,
    type: 'station.runtime.lifecycle/v1',
    producer: { id: 'station-server', version: '1' },
    occurredAt: '2026-08-17T00:00:00.000Z',
    scopes: [{ kind: 'project', projectId: 'project-1' }],
    payload: {
      schema: 'station.runtime.lifecycle/v1',
      data: { phase: 'ready', secret: 'projected-only-with-grant' },
    },
    privacy: 'private',
    delivery: 'durable',
  };
}

function manifest(
  subscriptions: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    name: 'event-plugin',
    version: '1.0.0',
    serverModule: 'server.mjs',
    operationalEventSubscriptions: subscriptions,
  };
}

function setup(input?: {
  subscriptions?: Array<Record<string, unknown>>;
  observe?: ReturnType<typeof vi.fn>;
}) {
  const projectHomeDir = mkdtempSync(
    join(tmpdir(), 'station-plugin-event-subscriptions-'),
  );
  roots.push(projectHomeDir);
  const pluginDir = join(projectHomeDir, 'plugins', 'event-plugin');
  mkdirSync(pluginDir, { recursive: true });
  const subscriptions = input?.subscriptions ?? [
    {
      id: 'runtime-ready',
      version: '1.0.0',
      eventTypes: ['station.runtime.lifecycle/v1'],
      requiredScopes: [{ kind: 'project', projectId: 'project-1' }],
      projection: 'metadata',
    },
  ];
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify(manifest(subscriptions)),
  );
  writeFileSync(join(pluginDir, 'server.mjs'), 'export function register() {}');
  const eventBus = new EventBus();
  const store = new EventStore(join(projectHomeDir, 'events.sqlite'));
  const publisher = store.createOperationalEventPublisher({
    appended: ({ journalSequence, event: appended }) =>
      eventBus.emit(SERVER_EVENTS.OPERATIONAL_EVENT, {
        journalSequence,
        event: appended,
      }),
  });
  const observe =
    input?.observe ?? vi.fn(async () => ({ kind: 'accepted' as const }));
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  const acquireModule = vi.fn(async () => {
    const release = vi.fn();
    releases.push(release);
    return {
      loaded: {
        register: vi.fn(),
        operationalEvents: { observe },
      },
      release,
    };
  });
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const readGrants = vi.fn((home: string, plugin: string) =>
    getPluginGrants(home, plugin),
  );
  const service = createPluginOperationalEventSubscriptionService({
    acquireModule: acquireModule as never,
    eventBus,
    eventStore: store,
    logger,
    projectHomeDir,
    readGrants,
  });
  return {
    acquireModule,
    eventBus,
    logger,
    observe,
    projectHomeDir,
    publisher,
    readGrants,
    releases,
    service,
    store,
  };
}

describe('PluginOperationalEventSubscriptionService', () => {
  it('delivers only the host-authorized metadata projection', async () => {
    const fixture = setup();
    await grantPermissions(fixture.projectHomeDir, 'event-plugin', [
      'plugin.server',
      'events.subscribe',
    ]);
    await expect(fixture.service.start()).resolves.toEqual({
      kind: 'applied',
      active: 1,
    });

    expect(fixture.publisher.append(event('event-1'))).toMatchObject({
      kind: 'appended',
    });
    await vi.waitFor(() => expect(fixture.observe).toHaveBeenCalledOnce());
    expect(fixture.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'runtime-ready',
        projection: expect.objectContaining({
          kind: 'metadata',
          event: expect.not.objectContaining({ payload: expect.anything() }),
        }),
        signal: expect.any(AbortSignal),
      }),
    );

    await expect(fixture.service.close()).resolves.toEqual({ kind: 'closed' });
    expect(fixture.releases[0]).toHaveBeenCalledOnce();
    expect(fixture.store.close()).toEqual({ kind: 'closed' });
  });

  it('requires the separate payload grant for envelope projection', async () => {
    const fixture = setup({
      subscriptions: [
        {
          id: 'runtime-ready',
          version: '1.0.0',
          eventTypes: ['station.runtime.lifecycle/v1'],
          projection: 'envelope',
        },
      ],
    });
    await grantPermissions(fixture.projectHomeDir, 'event-plugin', [
      'plugin.server',
      'events.subscribe',
    ]);
    await expect(fixture.service.start()).resolves.toEqual({
      kind: 'applied',
      active: 0,
    });
    expect(fixture.acquireModule).not.toHaveBeenCalled();

    await grantPermissions(fixture.projectHomeDir, 'event-plugin', [
      'events.read-payload',
    ]);
    fixture.eventBus.emit(SERVER_EVENTS.PLUGINS_GRANTS_CHANGED, {
      name: 'event-plugin',
    });
    await vi.waitFor(() =>
      expect(fixture.acquireModule).toHaveBeenCalledOnce(),
    );
    expect(fixture.publisher.append(event('event-1'))).toMatchObject({
      kind: 'appended',
    });
    await vi.waitFor(() => expect(fixture.observe).toHaveBeenCalledOnce());
    expect(fixture.observe.mock.calls[0][0].projection).toMatchObject({
      kind: 'envelope',
      event: { payload: { data: { phase: 'ready' } } },
    });
    await fixture.service.close();
    fixture.store.close();
  });

  it('rechecks grants on delivery and stops a revoked observer', async () => {
    const fixture = setup();
    await grantPermissions(fixture.projectHomeDir, 'event-plugin', [
      'plugin.server',
      'events.subscribe',
    ]);
    await fixture.service.start();
    expect(fixture.publisher.append(event('event-1'))).toMatchObject({
      kind: 'appended',
    });
    await vi.waitFor(() => expect(fixture.observe).toHaveBeenCalledOnce());

    await revokeAllGrants(fixture.projectHomeDir, 'event-plugin');
    expect(fixture.publisher.append(event('event-2'))).toMatchObject({
      kind: 'appended',
    });
    await vi.waitFor(() => expect(fixture.releases[0]).toHaveBeenCalledOnce());
    expect(fixture.observe).toHaveBeenCalledOnce();

    await fixture.service.close();
    fixture.store.close();
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a manifest replaced by a symlink after admission',
    async () => {
      const fixture = setup();
      await grantPermissions(fixture.projectHomeDir, 'event-plugin', [
        'plugin.server',
        'events.subscribe',
      ]);
      await fixture.service.start();
      const manifestPath = join(
        fixture.projectHomeDir,
        'plugins',
        'event-plugin',
        'plugin.json',
      );
      const outside = join(fixture.projectHomeDir, 'outside-manifest.json');
      writeFileSync(outside, readFileSync(manifestPath));
      rmSync(manifestPath);
      symlinkSync(outside, manifestPath);

      fixture.publisher.append(event('event-1'));
      await vi.waitFor(() =>
        expect(fixture.releases[0]).toHaveBeenCalledOnce(),
      );
      expect(fixture.observe).not.toHaveBeenCalled();
      await fixture.service.close();
      fixture.store.close();
    },
  );

  it('fails closed while the grants store is corrupt and resumes after recovery', async () => {
    const fixture = setup();
    await grantPermissions(fixture.projectHomeDir, 'event-plugin', [
      'plugin.server',
      'events.subscribe',
    ]);
    const grantsPath = join(fixture.projectHomeDir, 'plugin-grants.json');
    const validGrants = readFileSync(grantsPath);
    await fixture.service.start();
    const readsBeforeCorruption = fixture.readGrants.mock.calls.length;
    writeFileSync(grantsPath, 'not json');
    fixture.publisher.append(event('event-1'));
    await vi.waitFor(() =>
      expect(fixture.readGrants.mock.calls.length).toBeGreaterThan(
        readsBeforeCorruption,
      ),
    );
    expect(fixture.observe).not.toHaveBeenCalled();
    expect(fixture.releases[0]).not.toHaveBeenCalled();

    writeFileSync(grantsPath, validGrants);
    fixture.eventBus.emit(SERVER_EVENTS.OPERATIONAL_EVENT, {});
    await vi.waitFor(() => expect(fixture.observe).toHaveBeenCalledOnce());
    await fixture.service.close();
    fixture.store.close();
  });

  it('reconciles a later grant without restarting Station', async () => {
    const fixture = setup();
    await expect(fixture.service.start()).resolves.toEqual({
      kind: 'applied',
      active: 0,
    });
    expect(fixture.publisher.append(event('event-before-grant'))).toMatchObject(
      {
        kind: 'appended',
      },
    );
    await grantPermissions(fixture.projectHomeDir, 'event-plugin', [
      'plugin.server',
      'events.subscribe',
    ]);
    fixture.eventBus.emit(SERVER_EVENTS.PLUGINS_GRANTS_CHANGED, {
      name: 'event-plugin',
    });

    await vi.waitFor(() => expect(fixture.observe).toHaveBeenCalledOnce());
    expect(fixture.observe.mock.calls[0][0].projection.event.id).toBe(
      'event-before-grant',
    );
    await fixture.service.close();
    fixture.store.close();
  });

  it('quiesces before plugin mutation and reopens only after release', async () => {
    const fixture = setup();
    await grantPermissions(fixture.projectHomeDir, 'event-plugin', [
      'plugin.server',
      'events.subscribe',
    ]);
    await fixture.service.start();

    const guard = await fixture.service.quiesce('event-plugin');
    expect(fixture.releases[0]).toHaveBeenCalledOnce();
    fixture.publisher.append(event('event-during-mutation'));
    await fixture.service.reconcile();
    expect(fixture.acquireModule).toHaveBeenCalledOnce();
    expect(fixture.observe).not.toHaveBeenCalled();

    guard.release();
    await vi.waitFor(() =>
      expect(fixture.acquireModule).toHaveBeenCalledTimes(2),
    );
    await vi.waitFor(() => expect(fixture.observe).toHaveBeenCalledOnce());
    expect(fixture.observe.mock.calls[0][0].projection.event.id).toBe(
      'event-during-mutation',
    );
    await fixture.service.close();
    fixture.store.close();
  });

  it('isolates independently queued subscriptions and drains a hung one', async () => {
    let finishSlow!: (value: { kind: 'accepted' }) => void;
    const observe = vi.fn(({ subscriptionId }: { subscriptionId: string }) =>
      subscriptionId === 'slow'
        ? new Promise<{ kind: 'accepted' }>((resolve) => {
            finishSlow = resolve;
          })
        : Promise.resolve({ kind: 'accepted' as const }),
    );
    const fixture = setup({
      subscriptions: [
        {
          id: 'slow',
          version: '1.0.0',
          eventTypes: ['station.runtime.lifecycle/v1'],
        },
        {
          id: 'fast',
          version: '1.0.0',
          eventTypes: ['station.runtime.lifecycle/v1'],
        },
      ],
      observe,
    });
    await grantPermissions(fixture.projectHomeDir, 'event-plugin', [
      'plugin.server',
      'events.subscribe',
    ]);
    await expect(fixture.service.start()).resolves.toEqual({
      kind: 'applied',
      active: 2,
    });
    fixture.publisher.append(event('event-1'));
    await vi.waitFor(() =>
      expect(
        observe.mock.calls.some(([input]) => input.subscriptionId === 'fast'),
      ).toBe(true),
    );

    await expect(fixture.service.close()).resolves.toEqual({ kind: 'pending' });
    expect(
      fixture.releases.some((release) => release.mock.calls.length === 0),
    ).toBe(true);
    finishSlow({ kind: 'accepted' });
    await vi.waitFor(async () =>
      expect(await fixture.service.close()).toEqual({ kind: 'closed' }),
    );
    expect(fixture.releases).toHaveLength(2);
    expect(
      fixture.releases.every((release) => release.mock.calls.length === 1),
    ).toBe(true);
    expect(fixture.store.close()).toEqual({ kind: 'closed' });
  });

  it('isolates an invalid plugin manifest from valid subscriptions', async () => {
    const fixture = setup();
    const invalidDir = join(
      fixture.projectHomeDir,
      'plugins',
      'invalid-plugin',
    );
    mkdirSync(invalidDir, { recursive: true });
    writeFileSync(join(invalidDir, 'plugin.json'), '{"name":"invalid-plugin"}');
    await grantPermissions(fixture.projectHomeDir, 'event-plugin', [
      'plugin.server',
      'events.subscribe',
    ]);

    await expect(fixture.service.start()).resolves.toEqual({
      kind: 'applied',
      active: 1,
    });
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      'Skipped invalid plugin event subscription manifest',
      expect.objectContaining({ plugin: 'invalid-plugin' }),
    );
    await fixture.service.close();
    fixture.store.close();
  });
});
