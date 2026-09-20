/**
 * #484 phase A — the receiver-side portable-execution slice, unit-bounded:
 *
 * 1. The ORCHESTRATION ROUTE composes the offer admission for a
 *    `project-portable` workspace intent, refuses 403 with the contribution
 *    diagnostic vocabulary when the offer is absent/withdrawn, threads the
 *    admission into `delegateTask`, and leaves non-portable delegations
 *    byte-unchanged.
 * 2. The TOOL rechecks the admission immediately before the irreversible
 *    session start and again before the turn dispatch, AND threads the
 *    admission into the service internal options so the provider-effect
 *    path rechecks it adjacent to the actual adapter invocation — an offer
 *    that dies between the two refuses the turn BEFORE any provider
 *    effect — and the admitted receiver-local workingDirectory (the
 *    execution root) is what the session is started in, never a
 *    caller-named slug/path. A forwarding sender never holds the
 *    receiver-owned admission: the sender-side guard lives ONLY on the
 *    receiver-local path, after the remote-forwarding branch.
 *
 * The route diagnostic stubs the peer HTTP surface (handshake / agent /
 * project) with `fetch`; the actual two-runtime proof lives in
 * `portable-receiver-two-runtimes.e2e.test.ts`.
 */
import { afterEach, beforeAll, afterAll, describe, expect, test, vi } from 'vitest';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import type { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import {
  type ReceiverExecutionAdmission,
  ReceiverExecutionRefusal,
} from '../../../services/projects/project-contribution-service.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    eventBus: new EventBus(),
    logger,
    getUserId: () => 'bound-user',
    ...overrides,
  };
}

const PORTABLE_TARGET = {
  environment: { kind: 'current' as const },
  agent: 'planner',
  workspace: {
    kind: 'project-portable' as const,
    portableProjectId: 'prj_shared',
    resourceId: 'git.example/acme/repo',
  },
};

function admissionStub(
  recheck: () => Promise<void> = async () => {},
  ids: { portableProjectId: string; resourceId: string } = {
    portableProjectId: 'prj_shared',
    resourceId: 'git.example/acme/repo',
  },
): ReceiverExecutionAdmission {
  return {
    ...ids,
    admittedProject: {
      slug: 'local',
      workingDirectory: '/fixture/checkout',
    },
    recheck,
  };
}

describe('POST /delegations — portable execution admission (#484 phase A)', () => {
  test('a portable intent is admitted and the admission reaches delegateTask', async () => {
    const delegateTask = vi.fn().mockResolvedValue({
      taskId: 'task:1',
      sessionId: 'task:1',
      status: 'dispatched',
      resumable: true,
    });
    const authorizeReceiverExecution = vi
      .fn()
      .mockResolvedValue(admissionStub());
    const isRequestPrincipalCurrent = vi.fn(() => true);
    const app = createOrchestrationRoutes({} as never, baseDeps({
      delegateTask,
      authorizeReceiverExecution,
      isRequestPrincipalCurrent,
    }));
    const res = await app.request('/delegations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Ship it', target: PORTABLE_TARGET }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(authorizeReceiverExecution).toHaveBeenCalledWith(
      PORTABLE_TARGET.workspace,
      expect.any(Function),
    );
    const input = delegateTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.receiverAdmission).toMatchObject({
      admittedProject: { slug: 'local' },
    });
  });

  test('an unoffered portable intent refuses 403 before delegateTask', async () => {
    const delegateTask = vi.fn();
    const app = createOrchestrationRoutes({} as never, baseDeps({
      delegateTask,
      authorizeReceiverExecution: vi.fn().mockRejectedValue(
        new ReceiverExecutionRefusal(
          'receiver_execution_not_offered',
          'This Station does not currently offer execution for the requested Project resource.',
        ),
      ),
      isRequestPrincipalCurrent: () => true,
    }));
    const res = await app.request('/delegations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Ship it', target: PORTABLE_TARGET }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      success: false,
      error: /does not currently offer execution/,
    });
    expect(delegateTask).not.toHaveBeenCalled();
  });

  test('a portable intent without a wired admission owner refuses 403 (no composition hole)', async () => {
    const delegateTask = vi.fn();
    const app = createOrchestrationRoutes({} as never, baseDeps({
      delegateTask,
      isRequestPrincipalCurrent: () => true,
    }));
    const res = await app.request('/delegations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Ship it', target: PORTABLE_TARGET }),
    });
    expect(res.status).toBe(403);
    expect(delegateTask).not.toHaveBeenCalled();
  });

  test('a non-portable delegation is byte-unchanged (no admission composed)', async () => {
    const delegateTask = vi.fn().mockResolvedValue({ taskId: 'task:2' });
    const authorizeReceiverExecution = vi.fn();
    const app = createOrchestrationRoutes({} as never, baseDeps({
      delegateTask,
      authorizeReceiverExecution,
      isRequestPrincipalCurrent: () => true,
    }));
    const res = await app.request('/delegations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Ship it',
        target: {
          environment: { kind: 'current' },
          agent: 'planner',
          workspace: { kind: 'project', projectSlug: 'local' },
        },
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(authorizeReceiverExecution).not.toHaveBeenCalled();
    expect(
      (delegateTask.mock.calls[0]![0] as Record<string, unknown>)
        .receiverAdmission,
    ).toBeUndefined();
  });
});

describe('delegateTask receiver-local portable path (#484 phase A)', () => {
  const fetchCalls: string[] = [];
  const routes: Array<{ match: (url: string) => boolean; reply: () => unknown }> = [];
  beforeAll(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: unknown) => {
        const url = String(input);
        for (const route of routes) {
          if (route.match(url)) {
            fetchCalls.push(`${init && (init as any).method ? (init as any).method : 'GET'} ${url}`);
            return new Response(JSON.stringify(route.reply()), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
        }
        return new Response(JSON.stringify({ success: false }), { status: 404 });
      }) as never,
    );
  });
  afterEach(() => {
    routes.length = 0;
    fetchCalls.length = 0;
  });
  afterAll(() => vi.unstubAllGlobals());

  function orchestrationStub(options: {
    startSessionInternal?: ReturnType<typeof vi.fn>;
    dispatchWithReceipt?: ReturnType<typeof vi.fn>;
  }): OrchestrationService {
    return {
      readSession: vi.fn(async () => null),
      getProviderAdapter: vi.fn(() => undefined),
      resolveStationDefaultWorkspaceIsolation: vi.fn(async () => undefined),
      startSessionInternal:
        options.startSessionInternal ??
        vi.fn(async () => ({ status: 'accepted' as const })),
      dispatchWithReceipt:
        options.dispatchWithReceipt ?? vi.fn(async () => ({ events: [] })),
    } as unknown as OrchestrationService;
  }

  function primePeerHttp() {
    // `resolveTarget({environmentId: undefined})` asks the CURRENT
    // handshake; the delegation resolver then reads agent/project over the
    // same apiBase. The station-agent engine path (no connection binding)
    // avoids a connection read entirely.
    routes.push(
      {
        match: (url) => url.endsWith('/.well-known/station/v1'),
        reply: () => ({
          environmentId: 'env-self',
          capabilities: { portableExecutionOffers: true },
        }),
      },
      {
        match: (url) => url.includes('/api/agents/'),
        reply: () => ({
          success: true,
          data: {
            id: 'planner',
            slug: 'planner',
            available: true,
            execution: { agentConnectionId: null, modelId: null },
          },
        }),
      },
      {
        match: (url) => url.includes('/api/projects/local'),
        reply: () => ({
          success: true,
          data: { slug: 'local', workingDirectory: '/fixture/checkout' },
        }),
      },
      {
        match: (url) => url.includes('/api/orchestration/delegations'),
        reply: () => ({
          success: true,
          data: {
            taskId: 'task:remote',
            sessionId: 'task:remote',
            status: 'dispatched',
            resumable: true,
          },
        }),
      },
    );
  }

  test('a forwarding sender never needs the receiver admission: the portable intent forwards to the receiver', async () => {
    primePeerHttp();
    const { delegateTask } = await import('../../../tools/station-control-delegation.js');
    // No orchestrationService: this Station is NOT the receiver, so the
    // receiver-owned admission cannot exist here — and must not be
    // required. The intent (with its exact portable ids) forwards to the
    // receiving runtime, which composes the admission itself.
    const handle = await delegateTask(
      {
        prompt: 'Ship it',
        target: PORTABLE_TARGET,
        userId: 'u',
        readAuthority: { userId: 'u', mode: 'local' },
      } as never,
      undefined,
    );
    expect(handle).toMatchObject({ taskId: 'task:remote' });
    expect(
      fetchCalls.some(
        (c) => c.startsWith('POST') && c.includes('/delegations'),
      ),
    ).toBe(true);
  });

  test('a receiver-local portable intent without a receiver admission refuses before any effect', async () => {
    primePeerHttp();
    const startSessionInternal = vi.fn(async () => ({
      status: 'accepted' as const,
    }));
    const dispatchWithReceipt = vi.fn(async () => ({ events: [] }));
    const { delegateTask } = await import('../../../tools/station-control-delegation.js');
    await expect(
      delegateTask(
        {
          prompt: 'Ship it',
          target: PORTABLE_TARGET,
          userId: 'u',
          readAuthority: { userId: 'u', mode: 'local' },
        } as never,
        orchestrationStub({ startSessionInternal, dispatchWithReceipt }),
      ),
    ).rejects.toMatchObject({ code: 'receiver_execution_not_offered' });
    expect(startSessionInternal).not.toHaveBeenCalled();
    expect(dispatchWithReceipt).not.toHaveBeenCalled();
  });

  test('a receiver-local portable intent whose admission names a different association refuses (no re-target)', async () => {
    primePeerHttp();
    const startSessionInternal = vi.fn(async () => ({
      status: 'accepted' as const,
    }));
    const dispatchWithReceipt = vi.fn(async () => ({ events: [] }));
    const { delegateTask } = await import('../../../tools/station-control-delegation.js');
    await expect(
      delegateTask(
        {
          prompt: 'Ship it',
          target: PORTABLE_TARGET,
          userId: 'u',
          readAuthority: { userId: 'u', mode: 'local' },
          receiverAdmission: admissionStub(async () => {}, {
            portableProjectId: 'prj_other',
            resourceId: 'git.example/acme/repo',
          }),
        } as never,
        orchestrationStub({ startSessionInternal, dispatchWithReceipt }),
      ),
    ).rejects.toMatchObject({ code: 'receiver_execution_not_offered' });
    expect(startSessionInternal).not.toHaveBeenCalled();
    expect(dispatchWithReceipt).not.toHaveBeenCalled();
  });

  test('the admitted receiver-local workingDirectory is the started session cwd, rechecked at both effect boundaries', async () => {
    primePeerHttp();
    const startSessionInternal = vi.fn(async () => ({
      status: 'accepted' as const,
    }));
    const dispatchWithReceipt = vi.fn(async () => ({ events: [] }));
    const rechecks = vi.fn(async () => {});
    const { delegateTask } = await import('../../../tools/station-control-delegation.js');
    await delegateTask(
      {
        prompt: 'Ship it',
        target: PORTABLE_TARGET,
        userId: 'u',
        readAuthority: { userId: 'u', mode: 'local' },
        receiverAdmission: admissionStub(rechecks),
      } as never,
      orchestrationStub({ startSessionInternal, dispatchWithReceipt }),
    );
    const startInput = (
      startSessionInternal.mock.calls as unknown as Array<[Record<string, any>]>
    )[0]![0];
    expect(startInput.input.cwd).toBe('/fixture/checkout');
    const startMetadata = startInput.input.metadata as Record<string, unknown>;
    expect(startMetadata.projectSlug).toBe('local');
    // The admission is ALSO threaded into the service internal options, so
    // the provider-effect path rechecks it adjacent to the actual adapter
    // invocation (a door check alone cannot cover what races the awaits
    // inside the service).
    const startInternal = (
      startSessionInternal.mock.calls as unknown as Array<
        [unknown, unknown, Record<string, any> | undefined]
      >
    )[0]![2];
    expect(startInternal?.receiverExecutionAdmission?.recheck).toBe(rechecks);
    const turnInternal = (
      dispatchWithReceipt.mock.calls as unknown as Array<
        [unknown, unknown, Record<string, any> | undefined]
      >
    )[0]![2];
    expect(turnInternal?.receiverExecutionAdmission?.recheck).toBe(rechecks);
    // Recheck at BOTH irreversible boundaries: before the session start and
    // again before the turn dispatch.
    expect(rechecks).toHaveBeenCalledTimes(2);
    expect(startSessionInternal.mock.invocationCallOrder[0]).toBeLessThan(
      rechecks.mock.invocationCallOrder[1]!,
    );
    expect(rechecks.mock.invocationCallOrder[1]!).toBeLessThan(
      dispatchWithReceipt.mock.invocationCallOrder[0]!,
    );
  });

  test('an offer that dies between capture and the start boundary refuses the session and never dispatches', async () => {
    primePeerHttp();
    const startSessionInternal = vi.fn(async () => ({
      status: 'accepted' as const,
    }));
    const dispatchWithReceipt = vi.fn(async () => ({ events: [] }));
    const { delegateTask } = await import('../../../tools/station-control-delegation.js');
    let alive = true;
    await expect(
      delegateTask(
        {
          prompt: 'Ship it',
          target: PORTABLE_TARGET,
          userId: 'u',
          readAuthority: { userId: 'u', mode: 'local' },
          receiverAdmission: {
            portableProjectId: 'prj_shared',
            resourceId: 'git.example/acme/repo',
            admittedProject: {
              slug: 'local',
              workingDirectory: '/fixture/checkout',
            },
            recheck: async () => {
              if (!alive)
                throw new ReceiverExecutionRefusal(
                  'receiver_execution_not_offered',
                  'This Station does not currently offer execution for the requested Project resource.',
                );
              // The offer dies AFTER the session start: the second recheck
              // (the turn boundary) must still refuse.
              alive = false;
            },
          },
        } as never,
        orchestrationStub({ startSessionInternal, dispatchWithReceipt }),
      ),
    ).rejects.toMatchObject({ code: 'receiver_execution_not_offered' });
    expect(startSessionInternal).toHaveBeenCalledTimes(1);
    expect(dispatchWithReceipt).not.toHaveBeenCalled();
  });
});
