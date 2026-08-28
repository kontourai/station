import type { SessionInventoryProjection } from '@kontourai/station-contracts/session-inventory';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { createSessionInventoryAppReadModule } from '../session-inventory-app-read-module.js';

const authority = () =>
  sessionReadAuthorityFromRequest('fixture-user', undefined, undefined);
const caller = 'caller_'.padEnd(32, 'a');
const projection = {
  version: 'station.session-inventory/v1',
  scope: { kind: 'whole-session', sessionId: 'fixture-session' },
  groups: [
    'inputs',
    'sources',
    'execution',
    'decisions',
    'outputs',
    'verification-delivery',
    'live-now',
    'kept',
    'attention',
    'resources',
  ].map((id) => ({
    id,
    owner: { owner: 'fixture', id: 'v1' },
    state: 'empty',
    count: { kind: 'exact', value: 0 },
    items: [],
    gaps: [],
  })),
} as unknown as SessionInventoryProjection;

describe('SessionInventoryAppReadModule', () => {
  const make = (
    options: Parameters<typeof createSessionInventoryAppReadModule>[0] = {
      read: async () => ({ status: 'found' as const, projection }),
      page: async () => ({ status: 'unavailable' as const }),
      authorize: () => true,
      isEnabled: () => true,
    },
  ) => createSessionInventoryAppReadModule(options);
  test('reserves before owner I/O and binds a completed occurrence to exact scope, caller, authority, and route family', async () => {
    const read = vi.fn(async () => ({ status: 'found' as const, projection }));
    const module = createSessionInventoryAppReadModule({
      read,
      page: vi.fn(),
      authorize: () => true,
      isEnabled: () => true,
    });
    const opened = await module.open({
      scope: projection.scope,
      routeFamily: 'orchestration',
      callerBinding: caller,
      authority: authority(),
    });
    expect(opened.status).toBe('available');
    expect(read).toHaveBeenCalledTimes(2);
    if (opened.status !== 'available') return;
    await expect(
      module.page({
        scope: projection.scope,
        routeFamily: 'task',
        occurrenceId: opened.occurrenceId,
        groupId: 'inputs',
        continuationToken: 'token_'.padEnd(24, 'b'),
        callerBinding: caller,
        authority: authority(),
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  test('terminates a reserved occurrence when authorization drifts across owner reads', async () => {
    let current = true;
    const module = createSessionInventoryAppReadModule({
      read: vi.fn(async () => {
        current = false;
        return { status: 'found' as const, projection };
      }),
      page: vi.fn(),
      authorize: () => current,
      isEnabled: () => true,
    });
    await expect(
      module.open({
        scope: projection.scope,
        routeFamily: 'orchestration',
        callerBinding: caller,
        authority: authority(),
      }),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  test('terminates cross-scope owner projections while allowing a tenant-aware hosted authority', async () => {
    const crossScope = {
      ...projection,
      scope: { kind: 'whole-session' as const, sessionId: 'other-session' },
    } as SessionInventoryProjection;
    const module = createSessionInventoryAppReadModule({
      read: vi.fn(async () => ({
        status: 'found' as const,
        projection: crossScope,
      })),
      page: vi.fn(),
      authorize: () => true,
      isEnabled: () => true,
    });
    await expect(
      module.open({
        scope: projection.scope,
        routeFamily: 'orchestration',
        callerBinding: caller,
        authority: authority(),
      }),
    ).resolves.toEqual({ status: 'unavailable' });

    const hosted = createSessionInventoryAppReadModule({
      read: vi.fn(async () => ({ status: 'found' as const, projection })),
      page: vi.fn(),
      authorize: () => true,
      isEnabled: () => true,
    });
    await expect(
      hosted.open({
        scope: projection.scope,
        routeFamily: 'orchestration',
        callerBinding: caller,
        authority: { mode: 'hosted' } as never,
      }),
    ).resolves.toMatchObject({ status: 'available' });
  });

  test('enforces bounded global, per-caller, and rate admissions without large loops', async () => {
    const module = make({
      read: async () => ({ status: 'found' as const, projection }),
      page: async () => ({ status: 'unavailable' as const }),
      authorize: () => true,
      isEnabled: () => true,
      limits: { sessions: 2, perCaller: 1, rateCallers: 1, readsPerWindow: 2 },
    });
    const open = (callerBinding = caller) =>
      module.open({
        scope: projection.scope,
        routeFamily: 'orchestration',
        callerBinding,
        authority: authority(),
      });
    expect((await open()).status).toBe('available');
    await expect(open()).resolves.toEqual({ status: 'unavailable' });
    expect((await open('other_'.padEnd(32, 'b'))).status).toBe('available');
    await expect(open('third_'.padEnd(32, 'c'))).resolves.toEqual({
      status: 'unavailable',
    });
  });

  test('revoke and TTL purge make a live occurrence unreplayable', async () => {
    let at = 0;
    const module = make({
      read: async () => ({ status: 'found' as const, projection }),
      page: async () => ({ status: 'unavailable' as const }),
      authorize: () => true,
      isEnabled: () => true,
      now: () => at,
    });
    const opened = await module.open({
      scope: projection.scope,
      routeFamily: 'orchestration',
      callerBinding: caller,
      authority: authority(),
    });
    if (opened.status !== 'available') throw new Error('expected occurrence');
    module.revoke({
      routeFamily: 'orchestration',
      callerBinding: caller,
      occurrenceId: opened.occurrenceId,
    });
    await expect(
      module.page({
        scope: projection.scope,
        routeFamily: 'orchestration',
        callerBinding: caller,
        authority: authority(),
        occurrenceId: opened.occurrenceId,
        groupId: 'inputs',
        continuationToken: 'token_'.padEnd(24, 'a'),
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    at = 5 * 60_000 + 1;
    await expect(
      module.open({
        scope: projection.scope,
        routeFamily: 'orchestration',
        callerBinding: caller,
        authority: authority(),
      }),
    ).resolves.toMatchObject({ status: 'available' });
  });
});
