import {
  SESSION_INVENTORY_GROUP_IDS,
  type SessionInventoryGroupPage,
  type SessionInventoryProjection,
} from '@kontourai/station-contracts/session-inventory';
import { createStationAnswerBinding } from '@kontourai/station-contracts/task-basis';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { composeBasisProjection } from '@kontourai/surface/basis';
import { describe, expect, test, vi } from 'vitest';
import { createSessionInventoryAppReadModule } from '../session-inventory-app-read-module.js';

const authority = () =>
  sessionReadAuthorityFromRequest('fixture-user', undefined, undefined);
const caller = 'caller_'.padEnd(32, 'a');
const pageScope = {
  kind: 'current-answer' as const,
  sessionId: 'page-session',
  turnId: 'page-turn',
};
const pageRow = (key: string) => ({
  kind: 'thread-authored-input' as const,
  key,
  owner: { owner: 'thread', id: 'v1' },
  relations: ['contributed-to'] as const,
  sessionId: pageScope.sessionId,
  eventId: key,
  turnId: pageScope.turnId,
  inputKind: 'message' as const,
  attachmentDescriptors: [],
});
function validProjection(cursor: string): SessionInventoryProjection {
  const binding = createStationAnswerBinding({
    sessionId: pageScope.sessionId,
    turnId: pageScope.turnId,
    messageId: 'answer',
  });
  const basis = composeBasisProjection({
    version: 'surface.basis-projection/v1',
    answer: {
      owner: { authority: '@kontourai/thread' },
      state: 'available',
      observedAt: '2026-01-01T00:00:00.000Z',
      value: {
        ref: binding.answer,
        fact: 'answer-observed',
        observedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    assessment: {
      owner: { authority: '@kontourai/surface' },
      state: 'not-captured',
      observedAt: '2026-01-01T00:00:00.000Z',
    },
    contributions: [],
  });
  return {
    version: 'station.session-inventory/v1',
    scope: pageScope,
    basis,
    basisBinding: binding,
    groups: SESSION_INVENTORY_GROUP_IDS.map((id) =>
      id === 'inputs'
        ? {
            id,
            owner: { owner: 'thread', id: 'v1' },
            state: 'available' as const,
            count: { kind: 'at-least' as const, value: 2 },
            continuation: cursor,
            items: [pageRow('one')],
            gaps: [],
          }
        : {
            id,
            owner: { owner: 'station', id: 'v1' },
            state: 'empty' as const,
            count: { kind: 'exact' as const, value: 0 },
            items: [],
            gaps: [],
          },
    ),
  } as SessionInventoryProjection;
}
function validPage(cursor?: string): SessionInventoryGroupPage {
  const p = validProjection('ignored');
  return {
    version: 'station.session-inventory/v1',
    scope: pageScope,
    basis: p.basis,
    basisBinding: p.basisBinding,
    group: {
      id: 'inputs',
      owner: { owner: 'thread', id: 'v1' },
      state: 'available',
      count: cursor
        ? { kind: 'at-least', value: 2 }
        : { kind: 'exact', value: 2 },
      ...(cursor ? { continuation: cursor } : {}),
      items: [pageRow('two')],
      gaps: [],
    },
  } as SessionInventoryGroupPage;
}
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
  test('accepts differing opaque owner cursors, rotates from the second page read, and removes terminal continuation', async () => {
    let reads = 0;
    let pages = 0;
    const module = make({
      read: async () => ({
        status: 'found' as const,
        projection: validProjection(`open-${++reads}`),
      }),
      page: async () => ({
        status: 'found' as const,
        page: validPage(pages++ === 0 ? 'page-a' : 'page-b'),
      }),
      authorize: () => true,
      isEnabled: () => true,
    });
    const opened = await module.open({
      scope: pageScope,
      routeFamily: 'orchestration',
      callerBinding: caller,
      authority: authority(),
    });
    if (opened.status !== 'available') throw new Error('expected valid open');
    const first = opened.continuations[0]!.continuationToken;
    const paged = await module.page({
      scope: pageScope,
      routeFamily: 'orchestration',
      callerBinding: caller,
      authority: authority(),
      occurrenceId: opened.occurrenceId,
      groupId: 'inputs',
      continuationToken: first,
    });
    expect(paged).toMatchObject({ status: 'available' });
    if (paged.status !== 'available') return;
    expect(paged.continuations[0]!.continuationToken).not.toBe(first);
  });
  test('terminal pages remove the continuation and deny old-token replay, caller, authority, TTL, and page-cap reuse', async () => {
    let at = 0;
    const module = make({
      read: async () => ({
        status: 'found' as const,
        projection: validProjection('open'),
      }),
      page: async () => ({ status: 'found' as const, page: validPage() }),
      authorize: () => true,
      isEnabled: () => true,
      now: () => at,
    });
    const opened = await module.open({
      scope: pageScope,
      routeFamily: 'orchestration',
      callerBinding: caller,
      authority: authority(),
    });
    if (opened.status !== 'available') throw new Error('expected valid open');
    const token = opened.continuations[0]!.continuationToken;
    await expect(
      module.page({
        scope: pageScope,
        routeFamily: 'orchestration',
        callerBinding: 'other_'.padEnd(32, 'b'),
        authority: authority(),
        occurrenceId: opened.occurrenceId,
        groupId: 'inputs',
        continuationToken: token,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    await expect(
      module.page({
        scope: pageScope,
        routeFamily: 'orchestration',
        callerBinding: caller,
        authority: sessionReadAuthorityFromRequest(
          'other',
          undefined,
          undefined,
        ),
        occurrenceId: opened.occurrenceId,
        groupId: 'inputs',
        continuationToken: token,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    const terminal = await module.page({
      scope: pageScope,
      routeFamily: 'orchestration',
      callerBinding: caller,
      authority: authority(),
      occurrenceId: opened.occurrenceId,
      groupId: 'inputs',
      continuationToken: token,
    });
    expect(terminal).toMatchObject({ status: 'available', continuations: [] });
    await expect(
      module.page({
        scope: pageScope,
        routeFamily: 'orchestration',
        callerBinding: caller,
        authority: authority(),
        occurrenceId: opened.occurrenceId,
        groupId: 'inputs',
        continuationToken: token,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    at = 5 * 60_000 + 1;
    await expect(
      module.page({
        scope: pageScope,
        routeFamily: 'orchestration',
        callerBinding: caller,
        authority: authority(),
        occurrenceId: opened.occurrenceId,
        groupId: 'inputs',
        continuationToken: token,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
  });
  test('rejects semantic projection drift and bounded caller rates', async () => {
    let reads = 0;
    const drift = make({
      read: async () => ({
        status: 'found' as const,
        projection: reads++
          ? {
              ...validProjection('second'),
              groups: validProjection('second').groups.map((group) =>
                group.id === 'inputs'
                  ? { ...group, items: [pageRow('changed')] }
                  : group,
              ),
            }
          : validProjection('first'),
      }),
      page: async () => ({ status: 'unavailable' as const }),
      authorize: () => true,
      isEnabled: () => true,
    });
    await expect(
      drift.open({
        scope: pageScope,
        routeFamily: 'orchestration',
        callerBinding: caller,
        authority: authority(),
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    const rate = make({
      read: async () => ({ status: 'found' as const, projection }),
      page: async () => ({ status: 'unavailable' as const }),
      authorize: () => true,
      isEnabled: () => true,
      limits: { readsPerWindow: 1 },
    });
    expect(
      (
        await rate.open({
          scope: projection.scope,
          routeFamily: 'orchestration',
          callerBinding: caller,
          authority: authority(),
        })
      ).status,
    ).toBe('available');
    await expect(
      rate.open({
        scope: projection.scope,
        routeFamily: 'orchestration',
        callerBinding: caller,
        authority: authority(),
      }),
    ).resolves.toEqual({ status: 'unavailable' });
  });
  test('rejects semantic page drift and refuses a page once the configured page bound is spent', async () => {
    let calls = 0;
    const drift = make({
      read: async () => ({
        status: 'found' as const,
        projection: validProjection('open'),
      }),
      page: async () => ({
        status: 'found' as const,
        page: calls++
          ? {
              ...validPage('next'),
              group: {
                ...validPage('next').group,
                items: [pageRow('changed')],
              },
            }
          : validPage('next'),
      }),
      authorize: () => true,
      isEnabled: () => true,
    });
    const opened = await drift.open({
      scope: pageScope,
      routeFamily: 'orchestration',
      callerBinding: caller,
      authority: authority(),
    });
    if (opened.status !== 'available') throw new Error('expected valid open');
    await expect(
      drift.page({
        scope: pageScope,
        routeFamily: 'orchestration',
        callerBinding: caller,
        authority: authority(),
        occurrenceId: opened.occurrenceId,
        groupId: 'inputs',
        continuationToken: opened.continuations[0]!.continuationToken,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    const capped = make({
      read: async () => ({
        status: 'found' as const,
        projection: validProjection('open'),
      }),
      page: async () => ({ status: 'found' as const, page: validPage() }),
      authorize: () => true,
      isEnabled: () => true,
      limits: { pages: 1 },
    });
    const cappedOpen = await capped.open({
      scope: pageScope,
      routeFamily: 'orchestration',
      callerBinding: caller,
      authority: authority(),
    });
    if (cappedOpen.status !== 'available')
      throw new Error('expected capped open');
    await expect(
      capped.page({
        scope: pageScope,
        routeFamily: 'orchestration',
        callerBinding: caller,
        authority: authority(),
        occurrenceId: cappedOpen.occurrenceId,
        groupId: 'inputs',
        continuationToken: cappedOpen.continuations[0]!.continuationToken,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
  });
  test('rejects a concurrent page while the first owner page is in flight', async () => {
    let resolve!: () => void;
    let calls = 0;
    const module = make({
      read: async () => ({
        status: 'found' as const,
        projection: validProjection('open'),
      }),
      page: async () => {
        if (calls++ === 0)
          return new Promise<any>((done) => {
            resolve = () => done({ status: 'found', page: validPage('next') });
          });
        return { status: 'found' as const, page: validPage('next') };
      },
      authorize: () => true,
      isEnabled: () => true,
    });
    const opened = await module.open({
      scope: pageScope,
      routeFamily: 'orchestration',
      callerBinding: caller,
      authority: authority(),
    });
    if (opened.status !== 'available') throw new Error('expected valid open');
    const input = {
      scope: pageScope,
      routeFamily: 'orchestration' as const,
      callerBinding: caller,
      authority: authority(),
      occurrenceId: opened.occurrenceId,
      groupId: 'inputs' as const,
      continuationToken: opened.continuations[0]!.continuationToken,
    };
    const first = module.page(input);
    await vi.waitFor(() => expect(calls).toBe(1));
    await expect(module.page(input)).resolves.toEqual({
      status: 'unavailable',
    });
    resolve();
    await expect(first).resolves.toMatchObject({ status: 'available' });
  });
  test('purges an unconsumed valid continuation after TTL expiry', async () => {
    let at = 0;
    const module = make({
      read: async () => ({
        status: 'found' as const,
        projection: validProjection('open'),
      }),
      page: async () => ({ status: 'found' as const, page: validPage() }),
      authorize: () => true,
      isEnabled: () => true,
      now: () => at,
    });
    const opened = await module.open({
      scope: pageScope,
      routeFamily: 'orchestration',
      callerBinding: caller,
      authority: authority(),
    });
    if (opened.status !== 'available')
      throw new Error('expected live occurrence');
    at = 5 * 60_000 + 1;
    await expect(
      module.page({
        scope: pageScope,
        routeFamily: 'orchestration',
        callerBinding: caller,
        authority: authority(),
        occurrenceId: opened.occurrenceId,
        groupId: 'inputs',
        continuationToken: opened.continuations[0]!.continuationToken,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
  });
});
