import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NotificationService } from '../../notifications/notification-service.js';
import { EventBus } from '../../orchestration/event-bus.js';
import type { OrchestrationService } from '../../orchestration/orchestration-service.js';
import { AttentionProjectionService } from '../../projects/attention-projection.js';
import {
  ApprovalInboxNotificationProvider,
  wireApprovalInboxNotifications,
} from '../approval-inbox.js';
import { ApprovalRegistry } from '../approval-registry.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  approvalDuration: { record: vi.fn() },
  approvalInboxOps: { add: vi.fn() },
  approvalOps: { add: vi.fn() },
  attentionGateScanDuration: { record: vi.fn() },
  attentionProjectionLoads: { add: vi.fn() },
  attentionProjectionResults: { record: vi.fn() },
  notificationOps: { add: vi.fn() },
}));

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

/**
 * Approval-inbox observations exercise the provider's ordering and action
 * contract. They retain the real durable notification document, but not the
 * process-birth-aware cross-process lock: that infrastructure is covered by
 * NotificationService's lock tests and can transiently be unavailable to a
 * sandboxed Windows test worker. A lock-probe failure is deliberately caught
 * by `NotificationService.dispatch`; using it here turns an approval-law
 * observation into a silent, platform-dependent empty inbox.
 */
const acquireTestMutationLock = async () => async () => {};

describe('approval inbox notifications', () => {
  let bus: EventBus;
  let dir: string;
  let notificationService: NotificationService;

  async function emit(
    event: Parameters<EventBus['emit']>[0],
    data?: Parameters<EventBus['emit']>[1],
  ): Promise<void> {
    bus.emit(event, data);
    await notificationService.drainAsyncDispatch();
  }
  let approvalRegistry: ApprovalRegistry;
  let orchestrationService: Pick<
    OrchestrationService,
    'dispatch' | 'readRequestOutcome' | 'resolveSessionProjectSlug'
  >;
  let provider: ApprovalInboxNotificationProvider;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'approval-inbox-'));
    bus = new EventBus();
    notificationService = new NotificationService(bus, dir, 999_999, {
      acquireMutationLock: acquireTestMutationLock,
    });
    approvalRegistry = new ApprovalRegistry(logger, { eventBus: bus });
    orchestrationService = {
      dispatch: vi
        .fn<OrchestrationService['dispatch']>()
        .mockResolvedValue(undefined),
      // These tests exercise the LIVE bus path; the persisted log is not
      // what they are about, so the convergence sweep reads every request
      // as still open and leaves everything alone.
      readRequestOutcome: vi
        .fn<OrchestrationService['readRequestOutcome']>()
        .mockReturnValue({ state: 'undetermined' }),
      resolveSessionProjectSlug: vi
        .fn<OrchestrationService['resolveSessionProjectSlug']>()
        .mockReturnValue(undefined),
    };
    provider = new ApprovalInboxNotificationProvider({
      approvalRegistry,
      orchestrationService,
    });
    notificationService.addProvider(provider);
    wireApprovalInboxNotifications(bus, provider, notificationService, logger);
    await notificationService.start();
  });

  afterEach(async () => {
    await notificationService.shutdown();
    rmSync(dir, { force: true, recursive: true });
  });

  test('creates actionable notifications for orchestration approvals', async () => {
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'request.opened',
        payload: { toolName: 'bash.exec' },
        provider: 'codex',
        requestId: 'req-1',
        requestType: 'approval',
        threadId: 'thread-1',
        title: 'Needs approval',
      },
    });

    const notifications = await notificationService.list();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual(
      expect.objectContaining({
        category: 'approval-request',
        title: 'Needs approval',
        metadata: expect.objectContaining({
          sessionId: 'thread-1',
          sessionKind: 'runtime',
        }),
        actions: expect.arrayContaining([
          expect.objectContaining({ id: 'acceptForSession' }),
        ]),
      }),
    );

    await notificationService.action(notifications[0].id, 'acceptForSession');

    expect(orchestrationService.dispatch).toHaveBeenCalledWith({
      type: 'respondToRequest',
      threadId: 'thread-1',
      requestId: 'req-1',
      decision: 'acceptForSession',
    });
  });

  test('hydrates a legacy persisted approval through production wiring before start', async () => {
    const legacyNotification = await notificationService.schedule(
      'approval-inbox',
      {
        category: 'approval-request',
        title: 'Persisted approval',
        priority: 'high',
        actions: [
          { id: 'accept', label: 'Allow Once', variant: 'primary' },
          { id: 'decline', label: 'Deny', variant: 'danger' },
        ],
        metadata: {
          provider: 'codex',
          requestId: 'request-legacy',
          requestKey: 'orchestration:thread-legacy:request-legacy',
          requestKind: 'orchestration',
          requestType: 'approval',
          sessionId: 'thread-legacy',
          sessionKind: 'runtime',
          threadId: 'thread-legacy',
        },
      },
    );
    await notificationService.shutdown();
    const storePath = join(dir, 'notifications.json');
    const legacyDocument = JSON.parse(readFileSync(storePath, 'utf8')) as Array<
      Record<string, unknown>
    >;
    for (const notification of legacyDocument) delete notification.revision;
    writeFileSync(storePath, JSON.stringify(legacyDocument), 'utf8');

    notificationService = new NotificationService(bus, dir, 999_999, {
      acquireMutationLock: acquireTestMutationLock,
    });
    provider = new ApprovalInboxNotificationProvider({
      approvalRegistry,
      orchestrationService,
    });
    notificationService.addProvider(provider);

    expect(() =>
      wireApprovalInboxNotifications(
        bus,
        provider,
        notificationService,
        logger,
      ),
    ).not.toThrow();

    expect(await notificationService.list()).toEqual([
      expect.objectContaining({
        id: legacyNotification.id,
        status: 'delivered',
        title: 'Persisted approval',
      }),
    ]);
    expect(JSON.parse(readFileSync(storePath, 'utf8'))).toEqual(
      legacyDocument.map((notification) => ({ ...notification, revision: 1 })),
    );
  });

  test('stamps metadata.projectSlug on an orchestration approval notification when the session has a project (station#1284 AC4)', async () => {
    (
      orchestrationService.resolveSessionProjectSlug as ReturnType<typeof vi.fn>
    ).mockReturnValue('my-project');

    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'request.opened',
        payload: { toolName: 'bash.exec' },
        provider: 'codex',
        requestId: 'req-project',
        requestType: 'approval',
        threadId: 'thread-project',
        title: 'Needs approval',
      },
    });

    const notifications = await notificationService.list();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].metadata).toEqual(
      expect.objectContaining({ projectSlug: 'my-project' }),
    );
    expect(orchestrationService.resolveSessionProjectSlug).toHaveBeenCalledWith(
      'thread-project',
    );
  });

  /**
   * archive#1284 (HIGH 3, call-site half). `resolveSessionProjectSlug`
   * replays a session's whole event log to decorate a deep link, and it
   * runs inside `EventBus.emit`. A throw there used to take the entire
   * approval-inbox listener off the bus permanently; even with the bus
   * fixed, an escaping throw would abort this handler mid-flight and the
   * approval notification would never be created at all. Decoration must
   * never gate the notification.
   */
  test('a throwing resolveSessionProjectSlug still yields a notification (without projectSlug), and a later request.resolved still clears it', async () => {
    (
      orchestrationService.resolveSessionProjectSlug as ReturnType<typeof vi.fn>
    ).mockImplementation(() => {
      throw new Error('event replay blew up');
    });

    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'request.opened',
        provider: 'codex',
        requestId: 'req-slug-throws',
        requestType: 'approval',
        threadId: 'thread-slug-throws',
        title: 'Needs approval',
      },
    });

    const notifications = await notificationService.list();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].metadata).not.toHaveProperty('projectSlug');

    // And the listener is still wired: the resolution clears the card.
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'request.resolved',
        provider: 'codex',
        requestId: 'req-slug-throws',
        status: 'approved',
        threadId: 'thread-slug-throws',
      },
    });
    await notificationService.drainAsyncDispatch();
    expect((await notificationService.list())[0].status).toBe('actioned');
  });

  test('omits metadata.projectSlug for a session with no project binding', async () => {
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'request.opened',
        provider: 'codex',
        requestId: 'req-no-project',
        requestType: 'approval',
        threadId: 'thread-no-project',
        title: 'Needs approval',
      },
    });

    const notifications = await notificationService.list();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].metadata).not.toHaveProperty('projectSlug');
  });

  test('marks orchestration notifications actioned when the request resolves', async () => {
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'request.opened',
        provider: 'claude',
        requestId: 'req-2',
        requestType: 'approval',
        threadId: 'thread-2',
        title: 'Needs approval',
      },
    });
    const [notification] = await notificationService.list();

    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'request.resolved',
        provider: 'claude',
        requestId: 'req-2',
        status: 'approved',
        threadId: 'thread-2',
      },
    });

    await notificationService.drainAsyncDispatch();
    expect((await notificationService.list())[0]).toEqual(
      expect.objectContaining({
        id: notification.id,
        status: 'actioned',
      }),
    );
    expect(orchestrationService.dispatch).not.toHaveBeenCalled();
  });

  test('creates notifications for approval registry requests and actions them through the registry', async () => {
    const approvalPromise = approvalRegistry.register('approval-1', {
      metadata: {
        agentName: 'Workspace Agent',
        source: 'runtime',
        title: 'fs.read',
        toolName: 'fs.read',
      },
    });
    await notificationService.drainAsyncDispatch();

    const [notification] = await notificationService.list();
    expect(notification.body).toContain('Workspace Agent wants to use fs.read');
    expect(notification.metadata).toEqual(
      expect.objectContaining({
        sessionKind: 'managed',
      }),
    );

    await notificationService.action(notification.id, 'accept');

    await expect(approvalPromise).resolves.toBe(true);
  });

  test('does not action or forget a registry notification when trusted settlement reports stale', async () => {
    const approvalPromise = approvalRegistry.register('approval-stale', {
      metadata: {
        agentName: 'Workspace Agent',
        source: 'runtime',
        title: 'fs.read',
        toolName: 'fs.read',
      },
    });
    await notificationService.drainAsyncDispatch();
    const [notification] = await notificationService.list();
    const resolve = vi
      .spyOn(approvalRegistry, 'resolve')
      .mockReturnValueOnce(false);

    await expect(
      notificationService.action(notification.id, 'accept'),
    ).rejects.toThrow('Approval request is no longer pending');
    expect((await notificationService.list())[0]).toMatchObject({
      id: notification.id,
      status: 'delivered',
    });

    // The target remains available for a genuine later settlement rather
    // than silently turning the failed attempt into an actioned card.
    resolve.mockRestore();
    await notificationService.action(notification.id, 'accept');
    await expect(approvalPromise).resolves.toBe(true);
  });

  /**
   * Slice 2 (open-session-728): the "Open session" button on an
   * approval-request card is real only when AttentionProjectionService can
   * resolve a session target from the notification's metadata. This proves
   * both live approval-request creation paths — the registry path (mirrors
   * stream-orchestrator.ts's elicitation callback, which always supplies
   * `conversationId` from the active chat's `operationContext`) and the
   * orchestration path (mirrors station-agent-adapter/acp-adapter's
   * `request.opened` events, which always carry `threadId`) — pin the
   * session metadata the button needs, end to end through the real
   * projection service (not just field presence).
   */
  test('registry and orchestration approval notifications both resolve a real "Open session" target', async () => {
    const projection = new AttentionProjectionService(
      notificationService,
      {
        listSessionReadModel: async () => [],
        readSessionFlowRun: async () => null,
        readSession: async () => ({ session: {} as never, events: [] }),
      },
      { getRunConsole: async () => ({ gates: [] }) } as never,
    );

    // Registry path: mirrors createElicitationCallback's real call, which
    // always passes `conversationId: getConversationId()` for an active chat.
    void approvalRegistry.register('approval-registry-1', {
      metadata: {
        agentName: 'Workspace Agent',
        conversationId: 'conversation-42',
        source: 'runtime',
        title: 'fs.read',
        toolName: 'fs.read',
      },
    });

    // Orchestration path: mirrors a canonical `request.opened` event, which
    // always carries `threadId`.
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'request.opened',
        provider: 'codex',
        requestId: 'req-target',
        requestType: 'approval',
        threadId: 'thread-target',
        title: 'Needs approval',
      },
    });

    const { items } = await projection.list();
    const approvals = items.filter((item) => item.kind === 'approval');
    expect(approvals).toHaveLength(2);
    for (const item of approvals) {
      expect(item.openHref).toBeTruthy();
      expect(item.openHref).not.toBe('/notifications');
    }
  });

  /**
   * Seeds a hydrated orchestration approval card the way a previous boot
   * would have left one behind: still `delivered`, with the metadata the
   * convergence sweep parses.
   */
  async function seedHydratedOrchestrationApproval(
    threadId: string,
    requestId: string,
  ) {
    return await notificationService.schedule('approval-inbox', {
      category: 'approval-request',
      title: 'Tool call awaiting approval: shell.exec',
      priority: 'high',
      actions: [
        { id: 'accept', label: 'Allow Once', variant: 'primary' },
        { id: 'decline', label: 'Deny', variant: 'danger' },
      ],
      dedupeTag: `orchestration:${threadId}:${requestId}`,
      metadata: {
        provider: 'codex',
        requestId,
        requestKey: `orchestration:${threadId}:${requestId}`,
        requestKind: 'orchestration',
        requestType: 'approval',
        sessionId: threadId,
        sessionKind: 'runtime',
        threadId,
      },
    });
  }

  /**
   * THE `undetermined` SKIP ARM (round-3 verification: injection 2).
   *
   * Half of this change's headline claim is that "I could not look" and
   * "the log has never heard of this request" are different facts a
   * consumer must act on differently. Nothing proved it: the
   * `{ state: 'undetermined' }` in this file's `beforeEach` is an inert
   * setup default (its own comment says so — it exists to keep the LIVE-bus
   * tests from being disturbed by the sweep), not an assertion. Removing
   * `outcome.state === 'undetermined'` from the sweep's skip condition left
   * all 133 tests green while a live, genuinely-open approval was silently
   * marked `actioned` — a decision claimed on a card nobody answered.
   */
  test('an undetermined replay leaves a live approval card exactly as it was (station#1284 HIGH 2)', async () => {
    const notification = await seedHydratedOrchestrationApproval(
      'thread-undetermined',
      'req-undetermined',
    );
    expect(notification.status).toBe('delivered');
    (
      orchestrationService.readRequestOutcome as ReturnType<typeof vi.fn>
    ).mockReturnValue({ state: 'undetermined' });

    // Re-wiring re-runs hydration + the convergence sweep; the sweep is
    // idempotent and this is the only way to sweep an already-seeded card.
    wireApprovalInboxNotifications(bus, provider, notificationService, logger);
    await notificationService.drainAsyncDispatch();

    const swept = (await notificationService.list()).find(
      (item) => item.id === notification.id,
    );
    expect(swept?.status).toBe('delivered');
    expect(orchestrationService.readRequestOutcome).toHaveBeenCalledWith(
      'thread-undetermined',
      'req-undetermined',
    );
  });

  /**
   * Same arm, opposite direction — without this, the assertion above could
   * be satisfied by a sweep that never resolves anything at all.
   */
  test('an unrecorded replay DOES expire the same card, so the undetermined skip is a decision and not inaction', async () => {
    const notification = await seedHydratedOrchestrationApproval(
      'thread-unrecorded',
      'req-unrecorded',
    );
    (
      orchestrationService.readRequestOutcome as ReturnType<typeof vi.fn>
    ).mockReturnValue({ state: 'unrecorded' });

    wireApprovalInboxNotifications(bus, provider, notificationService, logger);
    await notificationService.drainAsyncDispatch();

    const swept = (await notificationService.list()).find(
      (item) => item.id === notification.id,
    );
    expect(swept?.status).toBe('expired');
  });

  /**
   * THE SWEEP'S READ-ERROR ISOLATION (round-3 verification: injection 3).
   *
   * `convergeHydratedOrchestrationApprovals` wraps its per-thread replay in
   * a try/catch because a read failure is not evidence the request ended.
   * Deleting that catch left every test green — while a single failing
   * replay would throw straight out of `wireApprovalInboxNotifications`,
   * i.e. out of the boot path that wires the inbox, taking the healthy
   * cards' convergence with it.
   */
  test('a throwing readRequestOutcome leaves the card untouched and does not escape wiring', async () => {
    const notification = await seedHydratedOrchestrationApproval(
      'thread-read-throws',
      'req-read-throws',
    );
    (
      orchestrationService.readRequestOutcome as ReturnType<typeof vi.fn>
    ).mockImplementation(() => {
      throw new Error('SQLITE_IOERR: disk read failure');
    });

    expect(() =>
      wireApprovalInboxNotifications(
        bus,
        provider,
        notificationService,
        logger,
      ),
    ).not.toThrow();
    await notificationService.drainAsyncDispatch();

    const swept = (await notificationService.list()).find(
      (item) => item.id === notification.id,
    );
    expect(swept?.status).toBe('delivered');
    expect(logger.warn).toHaveBeenCalledWith(
      'Could not replay an approval request during convergence',
      expect.objectContaining({ threadId: 'thread-read-throws' }),
    );
  });

  test('observes persisted approval state without exposing its private target', async () => {
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'request.opened',
        provider: 'codex',
        requestId: 'req-observe',
        requestType: 'approval',
        threadId: 'thread-observe',
        title: 'Observe approval',
      },
    });
    const [notification] = await notificationService.list();
    if (!notification) throw new Error('Expected approval notification');
    (
      orchestrationService.readRequestOutcome as ReturnType<typeof vi.fn>
    ).mockReturnValue({
      state: 'open',
      request: {
        createdAt: notification.createdAt,
        method: 'request.opened',
        provider: 'codex',
        requestId: 'req-observe',
        requestType: 'approval',
        threadId: 'thread-observe',
        title: 'Observe approval',
      },
    });
    expect(provider.observe(notification)).toEqual({ state: 'open' });
    expect(
      provider.observe({ ...notification, source: 'generic-api' }),
    ).toEqual({ state: 'stale' });
    (
      orchestrationService.readRequestOutcome as ReturnType<typeof vi.fn>
    ).mockReturnValue({ state: 'resolved', status: 'approved' });
    expect(provider.observe(notification)).toEqual({ state: 'resolved' });
    expect(JSON.stringify(provider.observe(notification))).not.toContain(
      'req-observe',
    );
  });

  test('rejects unknown approval actions instead of failing open', async () => {
    await emit('orchestration:event', {
      event: {
        createdAt: new Date().toISOString(),
        method: 'request.opened',
        provider: 'codex',
        requestId: 'req-3',
        requestType: 'approval',
        threadId: 'thread-3',
        title: 'Needs approval',
      },
    });

    const [orchestrationNotification] = await notificationService.list();
    await expect(
      notificationService.action(orchestrationNotification.id, 'allow-all'),
    ).rejects.toThrow('Unsupported orchestration approval action');

    const registryApprovalPromise = approvalRegistry.register('approval-2', {
      metadata: {
        agentName: 'Workspace Agent',
        source: 'runtime',
        title: 'fs.write',
        toolName: 'fs.write',
      },
    });
    await notificationService.drainAsyncDispatch();
    const notifications = await notificationService.list();
    const registryNotification = notifications.find(
      (item) => item.metadata?.approvalId === 'approval-2',
    );
    if (!registryNotification) {
      throw new Error('Expected registry notification');
    }

    await expect(
      notificationService.action(registryNotification.id, 'allow-all'),
    ).rejects.toThrow('Unsupported registry approval action');

    approvalRegistry.resolve('approval-2', false);
    await expect(registryApprovalPromise).resolves.toBe(false);
  });
});
