import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantExecutionContextFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventBus } from '../../orchestration/event-bus.js';
import { ApprovalRegistry } from '../approval-registry.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('ApprovalRegistry', () => {
  let registry: ApprovalRegistry;

  beforeEach(() => {
    registry = new ApprovalRegistry(mockLogger);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('register and resolve approved', async () => {
    const promise = registry.register('test-1');
    expect(registry.has('test-1')).toBe(true);

    registry.resolve('test-1', true);
    const result = await promise;

    expect(result).toBe(true);
    expect(registry.has('test-1')).toBe(false);
  });

  test('register and resolve denied', async () => {
    const promise = registry.register('test-2');
    registry.resolve('test-2', false);
    expect(await promise).toBe(false);
  });

  test('resolve unknown id returns false', () => {
    expect(registry.resolve('nonexistent', true)).toBe(false);
  });

  test('timeout resolves as denied', async () => {
    const promise = registry.register('test-timeout', 50);
    const result = await promise;
    expect(result).toBe(false);
  });

  // station#3158 — `register()`'s boolean cannot tell "someone said no" from
  // "nobody answered", and its one consumer that has to explain itself to a
  // person was printing both as "denied or timed out". These pin the outcome
  // seam that keeps them apart, each ending asserted as its own value rather
  // than as "not approved".
  test('registerForOutcome reports a denial as denied, not as an unanswered request', async () => {
    const promise = registry.registerForOutcome('outcome-denied');
    registry.resolve('outcome-denied', false);
    expect(await promise).toBe('denied');
  });

  test('registerForOutcome reports an unanswered request as expired, not as a denial', async () => {
    vi.useFakeTimers();
    const promise = registry.registerForOutcome('outcome-expired', {
      timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(await promise).toBe('expired');
  });

  test('registerForOutcome reports an approval as approved', async () => {
    const promise = registry.registerForOutcome('outcome-approved');
    registry.resolve('outcome-approved', true);
    expect(await promise).toBe('approved');
  });

  test('registerForOutcome reports a shutdown sweep as cancelled', async () => {
    const promise = registry.registerForOutcome('outcome-cancelled');
    expect(registry.cancelAll()).toBe(1);
    expect(await promise).toBe('cancelled');
  });

  test('registerForOutcome reports a refused hosted registration as unbound', async () => {
    registry = new ApprovalRegistry(mockLogger, {
      isHosted: () => true,
      resolveSessionTenant: () => undefined,
      canReadSession: () => false,
    });
    await expect(
      registry.registerForOutcome('outcome-unbound', {
        metadata: { source: 'runtime', title: 'unbound' },
      }),
    ).resolves.toBe('unbound');
  });

  test('register still collapses every non-approval to false for its gate callers', async () => {
    const denied = registry.register('collapse-denied');
    registry.resolve('collapse-denied', false);
    expect(await denied).toBe(false);

    const cancelled = registry.register('collapse-cancelled');
    registry.cancelAll();
    expect(await cancelled).toBe(false);

    const approved = registry.register('collapse-approved');
    registry.resolve('collapse-approved', true);
    expect(await approved).toBe(true);
  });

  test('generateId produces unique ids', () => {
    const a = ApprovalRegistry.generateId('test');
    const b = ApprovalRegistry.generateId('test');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^test-/);
  });

  test('multiple concurrent approvals', async () => {
    const p1 = registry.register('a');
    const p2 = registry.register('b');
    const p3 = registry.register('c');

    registry.resolve('b', true);
    registry.resolve('a', false);
    registry.resolve('c', true);

    expect(await p1).toBe(false);
    expect(await p2).toBe(true);
    expect(await p3).toBe(true);
  });

  test('emits approval lifecycle events when configured with an event bus', async () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.subscribe(listener);
    registry = new ApprovalRegistry(mockLogger, { eventBus: bus });

    const promise = registry.register('evt-1', {
      metadata: {
        agentName: 'Workspace Agent',
        source: 'runtime',
        title: 'fs.read',
      },
    });
    registry.resolve('evt-1', true);
    await promise;

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'approval:opened',
        data: expect.objectContaining({
          approvalId: 'evt-1',
          agentName: 'Workspace Agent',
          title: 'fs.read',
        }),
      }),
    );
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'approval:resolved',
        data: expect.objectContaining({
          approvalId: 'evt-1',
          status: 'approved',
        }),
      }),
    );
  });

  test('hosted registration requires a private sound binding and reauthorizes before resolution', async () => {
    const tenants = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [
        { id: 'alpha', authority: 'alpha.example.test' },
        { id: 'bravo', authority: 'bravo.example.test' },
      ],
    });
    const authority = (tenant: 'alpha' | 'bravo') =>
      sessionReadAuthorityFromRequest(
        `${tenant}-user`,
        { tenantId: tenantId(tenant) },
        tenants,
      );
    const bus = new EventBus();
    const emitted: unknown[] = [];
    bus.subscribe((event) => emitted.push(event));
    registry = new ApprovalRegistry(mockLogger, {
      eventBus: bus,
      isHosted: () => true,
      resolveSessionTenant: (sessionId) =>
        sessionId === 'alpha-session'
          ? tenantExecutionContextFromRequest({ tenantId: tenantId('alpha') })
          : undefined,
      canReadSession: (sessionId, requestAuthority) =>
        sessionId === 'alpha-session' &&
        requestAuthority.tenantExecutionContext?.tenantId === tenantId('alpha'),
    });

    await expect(
      registry.register('unbound', {
        metadata: { source: 'runtime', title: 'unbound' },
      }),
    ).resolves.toBe(false);
    expect(registry.has('unbound')).toBe(false);
    await expect(
      registry.register('authority-only', {
        authority: authority('alpha'),
        metadata: { source: 'runtime', title: 'authority-only' },
      }),
    ).resolves.toBe(false);

    const pending = registry.register('alpha-approval', {
      metadata: {
        conversationId: 'alpha-session',
        source: 'runtime',
        title: 'alpha tool',
      },
    });
    expect(
      registry.resolveAuthorized('alpha-approval', true, authority('bravo')),
    ).toBe(false);
    expect(registry.has('alpha-approval')).toBe(true);
    expect(
      registry.resolveAuthorized('alpha-approval', true, authority('alpha')),
    ).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(JSON.stringify(emitted)).not.toContain('tenantExecutionContext');
    expect(JSON.stringify(emitted)).not.toContain('alpha.example.test');
  });

  test('hosted trusted internal settlement and terminal events retain only reauthorizable session metadata', async () => {
    const tenants = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [
        { id: 'alpha', authority: 'alpha.example.test' },
        { id: 'bravo', authority: 'bravo.example.test' },
      ],
    });
    const authority = (tenant: 'alpha' | 'bravo') =>
      sessionReadAuthorityFromRequest(
        `${tenant}-user`,
        { tenantId: tenantId(tenant) },
        tenants,
      );
    const bus = new EventBus();
    const emitted: Array<{ event: string; data?: Record<string, unknown> }> =
      [];
    bus.subscribe((event) => emitted.push(event));
    registry = new ApprovalRegistry(mockLogger, {
      eventBus: bus,
      isHosted: () => true,
      resolveSessionTenant: (sessionId) =>
        sessionId === 'alpha-session'
          ? tenantExecutionContextFromRequest({ tenantId: tenantId('alpha') })
          : undefined,
      canReadSession: (sessionId, requestAuthority) =>
        sessionId === 'alpha-session' &&
        requestAuthority.tenantExecutionContext?.tenantId === tenantId('alpha'),
    });

    const settled = registry.register('internal-settlement', {
      metadata: {
        // The private session binding canonicalizes this field before emit.
        conversationId: 'alpha-session',
        source: 'runtime',
        title: 'tool',
      },
    });
    expect(registry.resolve('internal-settlement', true)).toBe(true);
    await expect(settled).resolves.toBe(true);
    const normal = emitted.find(
      (event) =>
        event.event === 'approval:resolved' &&
        event.data?.approvalId === 'internal-settlement',
    );
    expect(normal?.data).toMatchObject({ conversationId: 'alpha-session' });
    // The pending map is already empty; event authorization must still use
    // session metadata rather than a tombstone or serialized tenant.
    expect(registry.has('internal-settlement')).toBe(false);
    expect(registry.canReadEvent(normal?.data, authority('alpha'))).toBe(true);
    expect(registry.canReadEvent(normal?.data, authority('bravo'))).toBe(false);
    expect(JSON.stringify(normal)).not.toContain('tenantExecutionContext');

    vi.useFakeTimers();
    const expired = registry.register('internal-timeout', {
      metadata: {
        conversationId: 'alpha-session',
        source: 'runtime',
        title: 'tool',
      },
      timeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(expired).resolves.toBe(false);
    const timeout = emitted.find(
      (event) =>
        event.event === 'approval:resolved' &&
        event.data?.approvalId === 'internal-timeout',
    );
    expect(timeout?.data).toMatchObject({
      conversationId: 'alpha-session',
      status: 'expired',
    });
    expect(registry.canReadEvent(timeout?.data, authority('alpha'))).toBe(true);
    expect(registry.canReadEvent(timeout?.data, authority('bravo'))).toBe(
      false,
    );
  });
});
