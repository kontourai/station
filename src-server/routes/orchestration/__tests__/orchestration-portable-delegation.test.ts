/**
 * #484 phase A — the receiver-side portable-execution slice, unit-bounded,
 * plus the controller/receiver split (root review of d097bccf8):
 *
 * 1. The ORCHESTRATION ROUTE never mints the offer admission itself (that
 *    forced every controlling sender to hold a local offer for a saved
 *    receiver's intent). It captures the server-only mint factory bound to
 *    the current request credential before any await, threads the factory
 *    plus the verified inbound device kind into `delegateTask`, maps every
 *    `ReceiverExecutionRefusal` to an exact 403 WITH its distinct code,
 *    and leaves non-portable delegations byte-unchanged.
 * 2. The TOOL mints the admission through that factory ONLY when this
 *    Station is the actual local executor (its single `resolveTarget`
 *    resolved `current`) — a forwarding controller never mints, so it
 *    needs no local offer — rechecks it immediately before the
 *    irreversible session start and again before the turn dispatch, AND
 *    threads it into the service internal options so the provider-effect
 *    path rechecks it adjacent to the actual adapter invocation. An
 *    explicit portable arrival FROM an enrolled peer (`delegation` device
 *    kind, derived from verified principal + device kind, never body) is
 *    refused forwarding to a third host before any outbound fetch or
 *    provider effect.
 *
 * The route diagnostic stubs the peer HTTP surface (handshake / agent /
 * project) with `fetch`; the actual two-runtime proof lives in
 * `portable-receiver-two-runtimes.e2e.test.ts`.
 */

import { PORTABLE_EXECUTION_CONSENT_METADATA_KEY } from '@kontourai/station-contracts/provider';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
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
      localProjectId: 'local-project-1',
      workingDirectory: '/fixture/checkout',
      resourcePath: '/fixture/checkout',
    },
    recheck,
  };
}

describe('POST /delegations — portable execution admission (#484 phase A)', () => {
  test('a portable intent composes the mint factory (never a minted admission) into delegateTask', async () => {
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
    const app = createOrchestrationRoutes(
      {} as never,
      baseDeps({
        delegateTask,
        authorizeReceiverExecution,
        isRequestPrincipalCurrent,
      }),
    );
    const res = await app.request('/delegations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Ship it', target: PORTABLE_TARGET }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    // The route mints NOTHING eagerly: the admission owner is untouched
    // until the actual executor invokes the factory.
    expect(authorizeReceiverExecution).not.toHaveBeenCalled();
    const input = delegateTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.receiverAdmission).toBeUndefined();
    expect(typeof input.authorizeReceiverExecution).toBe('function');
    // The factory mints through the owner with the request-bound currency
    // probe when the executor invokes it.
    const minted = await (
      input.authorizeReceiverExecution as (workspace: {
        portableProjectId: string;
        resourceId: string;
      }) => Promise<unknown>
    )(PORTABLE_TARGET.workspace);
    expect(authorizeReceiverExecution).toHaveBeenCalledTimes(1);
    expect(authorizeReceiverExecution.mock.calls[0]![0]).toEqual(
      PORTABLE_TARGET.workspace,
    );
    expect(typeof authorizeReceiverExecution.mock.calls[0]![1]).toBe(
      'function',
    );
    expect(minted).toMatchObject({ admittedProject: { slug: 'local' } });
    // The captured currency probe is live-bound to the request: invoking
    // it reaches the request-principal check.
    const probe = authorizeReceiverExecution.mock.calls[0]![1] as () => boolean;
    expect(probe()).toBe(true);
    expect(isRequestPrincipalCurrent).toHaveBeenCalled();
  });

  test('a refusal maps to an exact safe code without serializing internal diagnostics', async () => {
    const delegateTask = vi
      .fn()
      .mockRejectedValue(
        new ReceiverExecutionRefusal(
          'receiver_execution_not_offered',
          'Internal diagnostic containing /private/customer/checkout and a secret placeholder',
        ),
      );
    const app = createOrchestrationRoutes(
      {} as never,
      baseDeps({
        delegateTask,
        authorizeReceiverExecution: vi.fn(),
        isRequestPrincipalCurrent: () => true,
      }),
    );
    const res = await app.request('/delegations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Ship it', target: PORTABLE_TARGET }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      success: false,
      error:
        'This Station does not currently offer execution for the requested Project resource.',
      code: 'receiver_execution_not_offered',
    });
    expect(delegateTask).toHaveBeenCalledTimes(1);
  });

  test('a non-portable delegation is byte-unchanged (no admission composed)', async () => {
    const delegateTask = vi.fn().mockResolvedValue({ taskId: 'task:2' });
    const authorizeReceiverExecution = vi.fn();
    const app = createOrchestrationRoutes(
      {} as never,
      baseDeps({
        delegateTask,
        authorizeReceiverExecution,
        isRequestPrincipalCurrent: () => true,
      }),
    );
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
  const routes: Array<{
    match: (url: string) => boolean;
    reply: () => unknown;
  }> = [];
  beforeAll(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: unknown) => {
        const url = String(input);
        for (const route of routes) {
          if (route.match(url)) {
            fetchCalls.push(
              `${init && (init as any).method ? (init as any).method : 'GET'} ${url}`,
            );
            return new Response(JSON.stringify(route.reply()), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
        }
        return new Response(JSON.stringify({ success: false }), {
          status: 404,
        });
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
    const { delegateTask } = await import(
      '../../../tools/station-control-delegation.js'
    );
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
        isRequestAuthorityCurrent: () => true,
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
    const { delegateTask } = await import(
      '../../../tools/station-control-delegation.js'
    );
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
    const { delegateTask } = await import(
      '../../../tools/station-control-delegation.js'
    );
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
    const { delegateTask } = await import(
      '../../../tools/station-control-delegation.js'
    );
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
    // #484: the server-minted portable consent marker rides the start
    // metadata (no caller can forge it — it is a reserved key), and the
    // same identity is threaded through internal options so the service
    // re-stamps it after the reserved-key strip for the persisted
    // session binding that continuation paths enforce.
    expect(startMetadata[PORTABLE_EXECUTION_CONSENT_METADATA_KEY]).toEqual({
      portableProjectId: 'prj_shared',
      resourceId: 'git.example/acme/repo',
      localProjectId: 'local-project-1',
    });
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
    expect(startInternal?.receiverExecutionAdmission?.admitted).toMatchObject({
      projectSlug: 'local',
      cwd: '/fixture/checkout',
      portableProjectId: 'prj_shared',
      resourceId: 'git.example/acme/repo',
      localProjectId: 'local-project-1',
    });
    expect(startInternal?.portableExecutionConsent).toEqual({
      portableProjectId: 'prj_shared',
      resourceId: 'git.example/acme/repo',
      localProjectId: 'local-project-1',
    });
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

  test('default-policy control: a shared receiver admission starts in the exact resource path with shared isolation', async () => {
    primePeerHttp();
    const startSessionInternal = vi.fn(async () => ({
      status: 'accepted' as const,
    }));
    const dispatchWithReceipt = vi.fn(async () => ({ events: [] }));
    const { delegateTask } = await import(
      '../../../tools/station-control-delegation.js'
    );
    await delegateTask(
      {
        prompt: 'Ship it',
        target: PORTABLE_TARGET,
        userId: 'u',
        readAuthority: { userId: 'u', mode: 'local' },
        // The admitted resource path differs from the compat default: the
        // provider must start in the checked resource path, never the
        // default checkout, under the receiver operator's shared policy.
        receiverAdmission: {
          ...admissionStub(async () => {}),
          admittedProject: {
            slug: 'local',
            workingDirectory: '/fixture/checkout',
            resourcePath: '/fixture/bound-repo',
          },
        },
      } as never,
      orchestrationStub({ startSessionInternal, dispatchWithReceipt }),
    );
    const startInput = (
      startSessionInternal.mock.calls as unknown as Array<[Record<string, any>]>
    )[0]![0];
    expect(startInput.input.cwd).toBe('/fixture/bound-repo');
    expect(startInput.input.workspaceIsolation).toEqual({ mode: 'shared' });
  });

  test('a worktree-configured receiver Project refuses before any session or provider effect', async () => {
    primePeerHttp();
    const { ProjectContributionService } = await import(
      '../../../services/projects/project-contribution-service.js'
    );
    const { delegateTask } = await import(
      '../../../tools/station-control-delegation.js'
    );
    // The REAL admission owner over stub stores: the receiver Project names
    // worktree isolation, so the admitted policy is worktree. The portable
    // delegation path has no worktree provisioning owner, so it must refuse
    // here — silently starting the shared checkout would ignore the
    // receiver operator's policy.
    const project = {
      id: 'local-id',
      slug: 'local',
      workingDirectory: '/fixture/checkout',
      defaultWorkspaceIsolation: 'worktree',
    };
    const serviceManifest = {
      schemaVersion: 1 as const,
      id: 'prj_shared',
      slug: 'local',
      name: 'Local',
      repos: [
        {
          kind: 'git' as const,
          id: 'git.example/acme/repo',
          canonicalRemote: 'git.example/acme/repo',
        },
      ],
      knowledge: [],
      agents: [],
      integrations: [],
      layouts: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const binding: unknown = {
      verifiedAt: Date.parse('2026-09-20T11:00:00.000Z'),
      projectId: 'prj_shared',
      resourceId: 'git.example/acme/repo',
    };
    const config = {
      contribution: {
        'project:prj_shared': {
          enabled: true,
          execution: { repoIds: ['git.example/acme/repo'] },
        },
      },
    };
    const service = new ProjectContributionService({
      source: {
        listProjects: () => [project],
        projectRevision: () => ({
          value: project,
          replace: vi.fn(),
          remove: vi.fn(),
          createLayout: vi.fn(),
          withCurrentRead: async (op: any) => op(project),
        }),
      },
      manifests: { readProjectManifest: () => serviceManifest },
      bindings: { findBinding: () => binding },
      resolver: {
        resolveProjectExecutionRoot: vi.fn(async () => undefined),
        resolveProjectResource: vi.fn(async () => ({
          state: 'bound' as const,
          resourceId: 'git.example/acme/repo',
          path: '/fixture/checkout',
        })),
      },
      config: {
        loadAppConfig: async () => config,
        mutateAppConfig: async () => config,
      },
    } as never);
    const admission = await service.authorizeReceiverExecution(
      {
        portableProjectId: 'prj_shared',
        resourceId: 'git.example/acme/repo',
      },
      () => true,
    );
    expect(admission.admittedProject.defaultWorkspaceIsolation).toBe(
      'worktree',
    );
    const startSessionInternal = vi.fn(async () => ({
      status: 'accepted' as const,
    }));
    const dispatchWithReceipt = vi.fn(async () => ({ events: [] }));
    await expect(
      delegateTask(
        {
          prompt: 'Ship it',
          target: PORTABLE_TARGET,
          userId: 'u',
          readAuthority: { userId: 'u', mode: 'local' },
          receiverAdmission: admission,
        } as never,
        orchestrationStub({ startSessionInternal, dispatchWithReceipt }),
      ),
    ).rejects.toMatchObject({ code: 'receiver_execution_unavailable' });
    expect(startSessionInternal).not.toHaveBeenCalled();
    expect(dispatchWithReceipt).not.toHaveBeenCalled();
  });

  test('a portable attachment without compat workingDirectory starts in the checked resource path', async () => {
    primePeerHttp();
    const startSessionInternal = vi.fn(async () => ({
      status: 'accepted' as const,
    }));
    const dispatchWithReceipt = vi.fn(async () => ({ events: [] }));
    const { delegateTask } = await import(
      '../../../tools/station-control-delegation.js'
    );
    const stubbed = admissionStub();
    const { workingDirectory: _compatDefault, ...admittedWithoutCompat } =
      stubbed.admittedProject;
    await delegateTask(
      {
        prompt: 'Ship it',
        target: PORTABLE_TARGET,
        userId: 'u',
        readAuthority: { userId: 'u', mode: 'local' },
        receiverAdmission: {
          ...stubbed,
          admittedProject: {
            ...admittedWithoutCompat,
            resourcePath: '/bindings/repo-checkout',
          },
        },
      } as never,
      orchestrationStub({ startSessionInternal, dispatchWithReceipt }),
    );
    // No invented default checkout: the provider starts in the resource's
    // checked path with the original slug identity intact.
    const startInput = (
      startSessionInternal.mock.calls as unknown as Array<[Record<string, any>]>
    )[0]![0];
    expect(startInput.input.cwd).toBe('/bindings/repo-checkout');
    expect(startInput.input.metadata.projectSlug).toBe('local');
  });

  test('an offer that dies between capture and the start boundary refuses the session and never dispatches', async () => {
    primePeerHttp();
    const startSessionInternal = vi.fn(async () => ({
      status: 'accepted' as const,
    }));
    const dispatchWithReceipt = vi.fn(async () => ({ events: [] }));
    const { delegateTask } = await import(
      '../../../tools/station-control-delegation.js'
    );
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
              localProjectId: 'local-project-1',
              workingDirectory: '/fixture/checkout',
              resourcePath: '/fixture/checkout',
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

  test('a REAL service admission carried to the effect boundary refuses after the binding is replaced', async () => {
    primePeerHttp();
    const { ProjectContributionService } = await import(
      '../../../services/projects/project-contribution-service.js'
    );
    const { delegateTask } = await import(
      '../../../tools/station-control-delegation.js'
    );
    // The real receiver admission owner over stub stores (same contract
    // shape as the service suite's fixture): no admission stub stands in.
    const project = {
      id: 'local-id',
      slug: 'local',
      workingDirectory: '/fixture/checkout',
    };
    const serviceManifest = {
      schemaVersion: 1 as const,
      id: 'prj_shared',
      slug: 'local',
      name: 'Local',
      repos: [
        {
          kind: 'git' as const,
          id: 'git.example/acme/repo',
          canonicalRemote: 'git.example/acme/repo',
        },
      ],
      knowledge: [],
      agents: [],
      integrations: [],
      layouts: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    let binding: unknown = {
      verifiedAt: Date.parse('2026-09-20T11:00:00.000Z'),
      projectId: 'prj_shared',
      resourceId: 'git.example/acme/repo',
    };
    const config = {
      contribution: {
        'project:prj_shared': {
          enabled: true,
          execution: { repoIds: ['git.example/acme/repo'] },
        },
      },
    };
    const service = new ProjectContributionService({
      source: {
        listProjects: () => [project],
        projectRevision: () => ({
          value: project,
          replace: vi.fn(),
          remove: vi.fn(),
          createLayout: vi.fn(),
          withCurrentRead: async (op: any) => op(project),
        }),
      },
      manifests: { readProjectManifest: () => serviceManifest },
      bindings: { findBinding: () => binding },
      resolver: {
        resolveProjectExecutionRoot: vi.fn(async () => undefined),
        resolveProjectResource: vi.fn(async () => ({
          state: 'bound' as const,
          resourceId: 'git.example/acme/repo',
          path: '/fixture/checkout',
        })),
      },
      config: {
        loadAppConfig: async () => config,
        mutateAppConfig: async () => config,
      },
    } as never);
    const admission = await service.authorizeReceiverExecution(
      {
        portableProjectId: 'prj_shared',
        resourceId: 'git.example/acme/repo',
      },
      () => true,
    );
    // The binding row is replaced under the same cwd AFTER the mint: the
    // turn-effect boundary recheck must refuse before the provider effect.
    // (The stub orchestration service below performs no start-adjacent
    // recheck of its own, so the refusal lands at the turn boundary after
    // the session start — exactly like the stub-recheck test above — while
    // the dispatch itself never runs.)
    binding = {
      verifiedAt: Date.parse('2026-09-20T11:30:00.000Z'),
      projectId: 'prj_shared',
      resourceId: 'git.example/acme/repo',
    };
    const startSessionInternal = vi.fn(async () => ({
      status: 'accepted' as const,
    }));
    const dispatchWithReceipt = vi.fn(async () => ({ events: [] }));
    await expect(
      delegateTask(
        {
          prompt: 'Ship it',
          target: PORTABLE_TARGET,
          userId: 'u',
          readAuthority: { userId: 'u', mode: 'local' },
          receiverAdmission: admission,
        } as never,
        orchestrationStub({ startSessionInternal, dispatchWithReceipt }),
      ),
    ).rejects.toMatchObject({ code: 'receiver_execution_unavailable' });
    expect(dispatchWithReceipt).not.toHaveBeenCalled();
  });

  describe('controller/receiver split — REAL route → delegateTask composition', () => {
    const PEER_API = 'https://peer.example';
    const PEER_ENV = 'env-peer';
    const PEER_PORTABLE_TARGET = {
      environment: { kind: 'saved' as const, id: PEER_ENV },
      agent: 'planner',
      workspace: {
        kind: 'project-portable' as const,
        portableProjectId: 'prj_shared',
        resourceId: 'git.example/acme/repo',
      },
    };
    let peerHandshake: () => unknown = () => ({
      environmentId: PEER_ENV,
      capabilities: { portableExecutionOffers: true },
    });

    // One setup per test: the outer afterEach clears the shared route
    // table, so routes are re-pushed here; the shared fetch stub records
    // only method+url, so peer POST bodies are captured by wrapping fetch.
    const peerPosts: Array<{ url: string; body: unknown }> = [];
    let unwrapFetch: (() => void) | undefined;
    beforeEach(() => {
      peerPosts.length = 0;
      peerHandshake = () => ({
        environmentId: PEER_ENV,
        capabilities: { portableExecutionOffers: true },
      });
      const inner = globalThis.fetch;
      const wrapped: typeof fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (
          url.startsWith(PEER_API) &&
          url.includes('/api/orchestration/delegations') &&
          init?.method === 'POST'
        ) {
          try {
            peerPosts.push({
              url,
              body: JSON.parse(String(init?.body ?? '{}')),
            });
          } catch {
            peerPosts.push({ url, body: undefined });
          }
        }
        return inner(input, init);
      };
      vi.stubGlobal('fetch', wrapped);
      unwrapFetch = () => {
        vi.stubGlobal('fetch', inner as never);
      };
      routes.push(
        {
          match: (url) =>
            !url.startsWith(PEER_API) &&
            url.endsWith('/.well-known/station/v1'),
          reply: () => ({ environmentId: 'env-self', capabilities: {} }),
        },
        {
          match: (url) => url.includes('/api/environments/ssh'),
          reply: () => ({ success: true, data: [] }),
        },
        {
          match: (url) =>
            url.includes(`/api/environments/peers/${PEER_ENV}/credential`),
          reply: () => ({
            success: true,
            data: {
              environmentId: PEER_ENV,
              apiBase: PEER_API,
              scope: 'peer',
              credential: 'peer-cred-1',
              label: 'peer',
            },
          }),
        },
        {
          match: (url) =>
            url.startsWith(PEER_API) && url.endsWith('/.well-known/station/v1'),
          reply: () => peerHandshake(),
        },
        {
          match: (url) =>
            url.startsWith(PEER_API) &&
            url.includes('/api/orchestration/delegations'),
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
      );
    });
    afterEach(() => {
      unwrapFetch?.();
      unwrapFetch = undefined;
    });

    function compositionApp(options: {
      service?: OrchestrationService;
      senderOffer?: ReturnType<typeof vi.fn>;
      inboundDeviceKind?: 'device' | 'delegation';
      resolvePrincipal?: (c: any) => { id: string };
      authorityCurrent?: () => boolean;
    }) {
      return createOrchestrationRoutes(
        {} as never,
        baseDeps({
          delegateTask: (input: any) =>
            realDelegateTask(input, options.service),
          ...(options.senderOffer
            ? { authorizeReceiverExecution: options.senderOffer }
            : {}),
          isRequestPrincipalCurrent: options.authorityCurrent ?? (() => true),
          ...(options.inboundDeviceKind
            ? { resolveInboundDeviceKind: () => options.inboundDeviceKind }
            : {}),
          ...(options.resolvePrincipal
            ? { resolvePrincipal: options.resolvePrincipal }
            : {}),
        }),
      );
    }

    async function realDelegateTask(
      input: any,
      service: OrchestrationService | undefined,
    ): Promise<unknown> {
      const { delegateTask } = await import(
        '../../../tools/station-control-delegation.js'
      );
      return delegateTask(input, service);
    }

    function postDelegations(app: any, target: unknown) {
      return app.request('/delegations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Ship it', target }),
      }) as Promise<Response>;
    }

    test('a controller credential revoked during the peer handshake cannot dispatch work', async () => {
      let current = true;
      const senderOffer = vi.fn(async () => admissionStub());
      peerHandshake = () => {
        current = false;
        return {
          environmentId: PEER_ENV,
          capabilities: { portableExecutionOffers: true },
        };
      };
      const app = compositionApp({
        service: undefined,
        senderOffer,
        authorityCurrent: () => current,
      });
      const response = await postDelegations(app, PEER_PORTABLE_TARGET);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: 'receiver_execution_authority_changed',
      });
      expect(peerPosts).toHaveLength(0);
      expect(senderOffer).not.toHaveBeenCalled();
    });

    test('a controller with NO local offer forwards the exact portable intent; the sender admission is never minted', async () => {
      const senderOffer = vi.fn(async () => admissionStub());
      const app = compositionApp({ service: undefined, senderOffer });
      const res = await postDelegations(app as never, PEER_PORTABLE_TARGET);
      expect(res.status, await res.clone().text()).toBe(200);
      // The sender minted NOTHING locally — no offer or association was
      // needed on the controller.
      expect(senderOffer).not.toHaveBeenCalled();
      // The exact intent (portable ids intact) forwarded as a current-host
      // request to the configured peer.
      expect(peerPosts).toHaveLength(1);
      expect(peerPosts[0]!.body).toMatchObject({
        prompt: 'Ship it',
        target: {
          environment: { kind: 'current' },
          workspace: {
            kind: 'project-portable',
            portableProjectId: 'prj_shared',
            resourceId: 'git.example/acme/repo',
          },
        },
      });
      expect(await res.json()).toMatchObject({
        success: true,
        data: { taskId: 'task:remote' },
      });
    });

    test('an enrolled peer inbound naming a third host refuses 403 with NO outbound peer effect', async () => {
      const senderOffer = vi.fn(async () => admissionStub());
      const startSessionInternal = vi.fn(async () => ({
        status: 'accepted' as const,
      }));
      const dispatchWithReceipt = vi.fn(async () => ({ events: [] }));
      const app = compositionApp({
        service: orchestrationStub({
          startSessionInternal,
          dispatchWithReceipt,
        }),
        senderOffer,
        inboundDeviceKind: 'delegation',
      });
      const res = await postDelegations(app as never, PEER_PORTABLE_TARGET);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        success: false,
        code: 'receiver_execution_forwarding_refused',
      });
      // NO onward hop: nothing posted to the third host, no local mint,
      // no session or turn effect.
      expect(peerPosts).toHaveLength(0);
      expect(fetchCalls.some((call) => call.includes(PEER_API))).toBe(false);
      expect(senderOffer).not.toHaveBeenCalled();
      expect(startSessionInternal).not.toHaveBeenCalled();
      expect(dispatchWithReceipt).not.toHaveBeenCalled();
    });

    test('a delegation-kind peer naming the local operator is still refused (display identity never overrides)', async () => {
      const senderOffer = vi.fn(async () => admissionStub());
      const startSessionInternal = vi.fn(async () => ({
        status: 'accepted' as const,
      }));
      const dispatchWithReceipt = vi.fn(async () => ({ events: [] }));
      const app = compositionApp({
        service: orchestrationStub({
          startSessionInternal,
          dispatchWithReceipt,
        }),
        senderOffer,
        inboundDeviceKind: 'delegation',
        // The enrolled peer's credential can carry a human person binding
        // (or ingress identity) that resolves to the local operator — the
        // actual runtime composition for a paired personal device. The
        // verified device kind must still win: refuse, no onward hop.
        resolvePrincipal: () => ({ id: 'human:local:operator' }),
      });
      const res = await postDelegations(app as never, PEER_PORTABLE_TARGET);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        success: false,
        code: 'receiver_execution_forwarding_refused',
      });
      expect(peerPosts).toHaveLength(0);
      expect(fetchCalls.some((call) => call.includes(PEER_API))).toBe(false);
      expect(senderOffer).not.toHaveBeenCalled();
      expect(startSessionInternal).not.toHaveBeenCalled();
      expect(dispatchWithReceipt).not.toHaveBeenCalled();
    });

    test('an ordinary operator/device controller MAY still select the saved peer (forward allowed)', async () => {
      for (const inboundDeviceKind of [undefined, 'device' as const]) {
        peerPosts.length = 0;
        const senderOffer = vi.fn(async () => admissionStub());
        const app = compositionApp({
          service: undefined,
          senderOffer,
          ...(inboundDeviceKind ? { inboundDeviceKind } : {}),
        });
        const res = await postDelegations(app as never, PEER_PORTABLE_TARGET);
        expect(res.status, await res.clone().text()).toBe(200);
        expect(senderOffer).not.toHaveBeenCalled();
        expect(peerPosts).toHaveLength(1);
      }
    });

    test('a wrong expected environment refuses 403 before any dispatch post', async () => {
      peerHandshake = () => ({
        environmentId: 'env-other',
        capabilities: { portableExecutionOffers: true },
      });
      const senderOffer = vi.fn(async () => admissionStub());
      const app = compositionApp({ service: undefined, senderOffer });
      const res = await postDelegations(app as never, PEER_PORTABLE_TARGET);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        success: false,
        code: 'receiver_execution_not_offered',
      });
      expect(senderOffer).not.toHaveBeenCalled();
      expect(peerPosts).toHaveLength(0);
    });

    test('a missing portable capability flag refuses 403 before any dispatch post', async () => {
      peerHandshake = () => ({
        environmentId: PEER_ENV,
        capabilities: {},
      });
      const senderOffer = vi.fn(async () => admissionStub());
      const app = compositionApp({ service: undefined, senderOffer });
      const res = await postDelegations(app as never, PEER_PORTABLE_TARGET);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        success: false,
        code: 'receiver_execution_not_offered',
      });
      expect(senderOffer).not.toHaveBeenCalled();
      expect(peerPosts).toHaveLength(0);
    });

    test('receiver-local execution mints through the factory and binds the admitted offer', async () => {
      const receiverOffer = vi.fn(
        async (
          _workspace: Pick<
            ReceiverExecutionAdmission,
            'portableProjectId' | 'resourceId'
          >,
        ) => admissionStub(),
      );
      const startSessionInternal = vi.fn(async () => ({
        status: 'accepted' as const,
      }));
      const dispatchWithReceipt = vi.fn(async () => ({ events: [] }));
      const app = compositionApp({
        service: orchestrationStub({
          startSessionInternal,
          dispatchWithReceipt,
        }),
        senderOffer: receiverOffer,
      });
      const res = await postDelegations(app as never, PORTABLE_TARGET);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(receiverOffer).toHaveBeenCalledTimes(1);
      expect(receiverOffer.mock.calls[0]![0]).toEqual({
        portableProjectId: 'prj_shared',
        resourceId: 'git.example/acme/repo',
      });
      const startInput = (
        startSessionInternal.mock.calls as unknown as Array<
          [Record<string, any>]
        >
      )[0]![0];
      expect(startInput.input.cwd).toBe('/fixture/checkout');
      expect(dispatchWithReceipt).toHaveBeenCalledTimes(1);
    });

    test('receiver-local execution without a wired factory refuses 403 with its code and no effect', async () => {
      const startSessionInternal = vi.fn(async () => ({
        status: 'accepted' as const,
      }));
      const dispatchWithReceipt = vi.fn(async () => ({ events: [] }));
      const app = compositionApp({
        service: orchestrationStub({
          startSessionInternal,
          dispatchWithReceipt,
        }),
      });
      const res = await postDelegations(app as never, PORTABLE_TARGET);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        success: false,
        code: 'receiver_execution_not_offered',
      });
      expect(startSessionInternal).not.toHaveBeenCalled();
      expect(dispatchWithReceipt).not.toHaveBeenCalled();
    });

    test('legacy non-portable peer forwarding is unchanged through the same composition', async () => {
      const senderOffer = vi.fn(async () => admissionStub());
      const app = compositionApp({ service: undefined, senderOffer });
      const res = await postDelegations(app as never, {
        environment: { kind: 'saved' as const, id: PEER_ENV },
        agent: 'planner',
        workspace: { kind: 'project' as const, projectSlug: 'local' },
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(senderOffer).not.toHaveBeenCalled();
      expect(peerPosts).toHaveLength(1);
      expect(peerPosts[0]!.body).toMatchObject({
        target: { workspace: { kind: 'project', projectSlug: 'local' } },
      });
    });
  });

  describe('isInboundDelegationPeer derivation (verified device kind is decisive)', () => {
    test('a delegation device kind is a peer even when display identity names the operator', async () => {
      const { isInboundDelegationPeer } = await import(
        '../../../tools/station-control-delegation.js'
      );
      const operator = {
        version: 1,
        actor: { kind: 'operator' },
        reported: { version: 1, surface: 'web', build: null },
      };
      const internal = {
        version: 1,
        actor: { kind: 'internal' },
        reported: { version: 1, surface: 'mobile', build: null },
      };
      const device = {
        version: 1,
        actor: { kind: 'device', deviceId: 'd1' },
        reported: { version: 1, surface: 'mobile', build: null },
      };
      // A delegation-kind device credential can carry a human person
      // binding (or ingress identity) naming the local operator: the
      // verified kind still wins — otherwise the peer escapes no-onward-hop
      // by wearing the operator's display name.
      expect(
        isInboundDelegationPeer(undefined, operator as never, 'delegation'),
      ).toBe(true);
      expect(
        isInboundDelegationPeer(undefined, internal as never, 'delegation'),
      ).toBe(true);
      expect(
        isInboundDelegationPeer(
          { id: 'human:local:operator', kind: 'human', display: 'op' },
          undefined,
          'delegation',
        ),
      ).toBe(true);
      expect(
        isInboundDelegationPeer(undefined, device as never, 'delegation'),
      ).toBe(true);
      // Ordinary personal devices, operator callers with no device
      // credential, and callers with no kind at all are never peers.
      expect(
        isInboundDelegationPeer(undefined, device as never, 'device'),
      ).toBe(false);
      expect(
        isInboundDelegationPeer(undefined, device as never, undefined),
      ).toBe(false);
      expect(
        isInboundDelegationPeer(undefined, operator as never, undefined),
      ).toBe(false);
      expect(isInboundDelegationPeer(undefined, undefined, 'delegation')).toBe(
        true,
      );
    });

    test('the wired kind resolver reports the verified device record (actual middleware composition)', async () => {
      const {
        resolveInboundDeviceKindForRequest,
        setRuntimeAuthenticatedRequestPrincipal,
      } = await import('../../../security/runtime-request-security.js');
      const delegationRequest = new Request(
        'https://station.local/api/orchestration/delegations',
        { method: 'POST' },
      );
      setRuntimeAuthenticatedRequestPrincipal(delegationRequest, {
        credential: 'cred-delegation-1',
        authority: 'device-credential',
        deviceId: 'peer-1',
        source: 'bearer',
      });
      const identifyDevice = (credential: string) =>
        credential === 'cred-delegation-1'
          ? { kind: 'delegation' as const }
          : null;
      // The real composition — verified credential + device-record lookup,
      // never body/userId/metadata — reports the delegation kind even
      // though nothing here names the operator.
      expect(
        resolveInboundDeviceKindForRequest(delegationRequest, identifyDevice),
      ).toBe('delegation');
      // An operator credential is never a peer, even against a device
      // record that claims delegation: authority gates the lookup.
      const operatorRequest = new Request(
        'https://station.local/api/orchestration/delegations',
        { method: 'POST' },
      );
      setRuntimeAuthenticatedRequestPrincipal(operatorRequest, {
        credential: 'op-cred',
        authority: 'operator-credential',
        source: 'bearer',
      });
      expect(
        resolveInboundDeviceKindForRequest(operatorRequest, () => ({
          kind: 'delegation' as const,
        })),
      ).toBeUndefined();
      // An ordinary personal device resolves its own kind (may forward);
      // an unknown record resolves undefined (never a peer).
      const deviceRequest = new Request(
        'https://station.local/api/orchestration/delegations',
        { method: 'POST' },
      );
      setRuntimeAuthenticatedRequestPrincipal(deviceRequest, {
        credential: 'cred-device-1',
        authority: 'device-credential',
        deviceId: 'phone-1',
        source: 'bearer',
      });
      expect(
        resolveInboundDeviceKindForRequest(deviceRequest, () => ({
          kind: 'device' as const,
        })),
      ).toBe('device');
      expect(
        resolveInboundDeviceKindForRequest(deviceRequest, () => null),
      ).toBeUndefined();
      expect(
        resolveInboundDeviceKindForRequest(
          new Request('https://station.local/api/orchestration/delegations'),
          identifyDevice,
        ),
      ).toBeUndefined();
    });
  });

  describe('POST /delegations/:taskId/continue|respond — portable follow-up factory (#484 continuation)', () => {
    test('continue composes the mint factory (never a minted admission) and maps a wrapped refusal code to 403', async () => {
      const continueDelegatedTask = vi.fn().mockResolvedValue({
        taskId: 'task:1',
        status: 'dispatched',
      });
      const authorizeReceiverExecution = vi
        .fn()
        .mockResolvedValue(admissionStub());
      const isRequestPrincipalCurrent = vi.fn(() => true);
      const app = createOrchestrationRoutes(
        {} as never,
        baseDeps({
          continueDelegatedTask,
          authorizeReceiverExecution,
          isRequestPrincipalCurrent,
        }),
      );
      const res = await app.request('/delegations/task:1/continue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'One more thing' }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      // The route mints NOTHING eagerly — the follow-up body carries no
      // portable ids at all, so there is nothing to mint for here. The
      // tool mints on the executing receiver from the thread's own
      // persisted marker.
      expect(authorizeReceiverExecution).not.toHaveBeenCalled();
      const input = continueDelegatedTask.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(typeof input.authorizeReceiverExecution).toBe('function');
      // The factory mints through the owner with the request-bound
      // currency probe when the executor invokes it.
      await (
        input.authorizeReceiverExecution as (workspace: {
          portableProjectId: string;
          resourceId: string;
        }) => Promise<unknown>
      )({
        portableProjectId: 'prj_shared',
        resourceId: 'git.example/acme/repo',
      });
      expect(authorizeReceiverExecution).toHaveBeenCalledTimes(1);
      expect(authorizeReceiverExecution.mock.calls[0]![0]).toEqual({
        portableProjectId: 'prj_shared',
        resourceId: 'git.example/acme/repo',
      });
      expect(typeof authorizeReceiverExecution.mock.calls[0]![1]).toBe(
        'function',
      );
    });

    test('continue maps an effect-path (wrapped) stale refusal to the exact 403', async () => {
      const continueDelegatedTask = vi
        .fn()
        .mockRejectedValue(
          Object.assign(
            new Error(
              'This portable task predates its Project identity record and cannot continue. Start a new portable execution.',
            ),
            { code: 'receiver_execution_consent_stale' },
          ),
        );
      const app = createOrchestrationRoutes(
        {} as never,
        baseDeps({
          continueDelegatedTask,
          authorizeReceiverExecution: vi.fn(),
          isRequestPrincipalCurrent: () => true,
        }),
      );
      const res = await app.request('/delegations/task:1/continue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'One more thing' }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        success: false,
        error:
          'The original Project identity of this portable task cannot be verified. Start a new portable execution.',
        code: 'receiver_execution_consent_stale',
      });
      expect(continueDelegatedTask).toHaveBeenCalledTimes(1);
    });

    describe('follow-up forwarding guards — REAL route → tool composition', () => {
      const PEER_API = 'https://peer.example';
      const PEER_ENV = 'env-peer';
      const peerPosts: Array<{ url: string; body: unknown }> = [];
      const fetchCalls: string[] = [];
      let unwrapFetch: (() => void) | undefined;
      let revokeOnCredentialRead = false;
      let current = true;

      const ok = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      beforeEach(() => {
        peerPosts.length = 0;
        fetchCalls.length = 0;
        revokeOnCredentialRead = false;
        current = true;
        const inner = globalThis.fetch;
        const wrapped: typeof fetch = (async (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          const url = input instanceof Request ? input.url : String(input);
          const method =
            init && typeof init === 'object' && 'method' in init
              ? String((init as { method?: unknown }).method ?? 'GET')
              : 'GET';
          fetchCalls.push(`${method} ${url}`);
          if (
            !url.startsWith(PEER_API) &&
            url.endsWith('/.well-known/station/v1')
          ) {
            return ok({ environmentId: 'env-self', capabilities: {} });
          }
          if (
            !url.startsWith(PEER_API) &&
            url.includes('/api/environments/ssh')
          ) {
            return ok({ success: true, data: [] });
          }
          if (url.includes(`/api/environments/peers/${PEER_ENV}/credential`)) {
            if (revokeOnCredentialRead) current = false;
            return ok({
              success: true,
              data: {
                environmentId: PEER_ENV,
                apiBase: PEER_API,
                scope: 'peer',
                credential: 'peer-cred-1',
                label: 'peer',
              },
            });
          }
          if (url.startsWith(PEER_API)) {
            try {
              peerPosts.push({
                url,
                body: JSON.parse(
                  String((init as { body?: unknown })?.body ?? '{}'),
                ),
              });
            } catch {
              peerPosts.push({ url, body: undefined });
            }
            return ok({
              success: true,
              data: { taskId: 'task:remote', status: 'dispatched' },
            });
          }
          throw new Error(`Unexpected request: ${url}`);
        }) as never;
        vi.stubGlobal('fetch', wrapped);
        unwrapFetch = () => {
          vi.stubGlobal('fetch', inner as never);
        };
      });

      afterEach(() => {
        unwrapFetch?.();
        unwrapFetch = undefined;
      });

      async function realContinue(input: any): Promise<unknown> {
        const { continueDelegatedTask } = await import(
          '../../../tools/station-control-delegation.js'
        );
        return continueDelegatedTask(input, undefined);
      }

      async function realRespond(input: any): Promise<unknown> {
        const { respondToDelegatedTaskRequest } = await import(
          '../../../tools/station-control-delegation.js'
        );
        return respondToDelegatedTaskRequest(input, undefined);
      }

      function followUpApp(options: {
        continueDelegatedTask?: (input: any) => Promise<unknown>;
        respondToDelegatedTaskRequest?: (input: any) => Promise<unknown>;
        inboundDeviceKind?: 'device' | 'delegation';
        resolvePrincipal?: (c: any) => { id: string };
      }) {
        return createOrchestrationRoutes(
          {} as never,
          baseDeps({
            continueDelegatedTask:
              options.continueDelegatedTask ?? realContinue,
            respondToDelegatedTaskRequest:
              options.respondToDelegatedTaskRequest ?? realRespond,
            isRequestPrincipalCurrent: () => current,
            ...(options.inboundDeviceKind
              ? { resolveInboundDeviceKind: () => options.inboundDeviceKind }
              : {}),
            ...(options.resolvePrincipal
              ? { resolvePrincipal: options.resolvePrincipal }
              : {}),
          }),
        );
      }

      test.each(['continue', 'respond'] as const)(
        'a delegation peer with local-operator person binding cannot third-hop a %s: 403, no outbound POST',
        async (kind) => {
          const app = followUpApp({
            inboundDeviceKind: 'delegation',
            // The enrolled peer's credential carries a person binding naming
            // the local operator — display identity must never override the
            // verified device kind into a forward.
            resolvePrincipal: () => ({ id: 'human:local:operator' }),
          });
          const path =
            kind === 'continue'
              ? '/delegations/task:1/continue'
              : '/delegations/task:1/respond';
          const body =
            kind === 'continue'
              ? {
                  message: 'One more thing',
                  environmentId: PEER_ENV,
                }
              : {
                  requestId: 'request-1',
                  decision: 'accept',
                  environmentId: PEER_ENV,
                };
          const res = await app.request(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          expect(res.status).toBe(403);
          expect(await res.json()).toMatchObject({
            success: false,
            code: 'receiver_execution_forwarding_refused',
          });
          // No outbound POST: the third host was never touched.
          expect(peerPosts).toHaveLength(0);
          expect(fetchCalls.some((call) => call.includes(PEER_API))).toBe(
            false,
          );
        },
      );

      test.each(['continue', 'respond'] as const)(
        'a sender revocation during resolution refuses a %s before any outbound POST',
        async (kind) => {
          // Revocation lands while the target resolves (the credential read
          // flips it): the post-resolution currency probe refuses.
          revokeOnCredentialRead = true;
          const app = followUpApp({});
          const path =
            kind === 'continue'
              ? '/delegations/task:1/continue'
              : '/delegations/task:1/respond';
          const body =
            kind === 'continue'
              ? {
                  message: 'One more thing',
                  environmentId: PEER_ENV,
                }
              : {
                  requestId: 'request-1',
                  decision: 'accept',
                  environmentId: PEER_ENV,
                };
          const res = await app.request(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          expect(res.status).toBe(403);
          expect(await res.json()).toMatchObject({
            success: false,
            code: 'receiver_execution_authority_changed',
          });
          expect(peerPosts).toHaveLength(0);
          expect(fetchCalls.some((call) => call.includes(PEER_API))).toBe(
            false,
          );
        },
      );

      test.each(['continue', 'respond'] as const)(
        'an ordinary operator %s still forwards to the saved peer (legacy flow preserved)',
        async (kind) => {
          const app = followUpApp({});
          const path =
            kind === 'continue'
              ? '/delegations/task:1/continue'
              : '/delegations/task:1/respond';
          const body =
            kind === 'continue'
              ? {
                  message: 'One more thing',
                  environmentId: PEER_ENV,
                }
              : {
                  requestId: 'request-1',
                  decision: 'accept',
                  environmentId: PEER_ENV,
                };
          const res = await app.request(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          expect(res.status, await res.clone().text()).toBe(200);
          expect(peerPosts).toHaveLength(1);
        },
      );
    });

    test('respond composes the mint factory and maps a wrapped refusal code to 403', async () => {
      const respondToDelegatedTaskRequest = vi.fn().mockResolvedValue({
        taskId: 'task:1',
        requestId: 'request-1',
        status: 'resolved',
      });
      const authorizeReceiverExecution = vi
        .fn()
        .mockResolvedValue(admissionStub());
      const app = createOrchestrationRoutes(
        {} as never,
        baseDeps({
          respondToDelegatedTaskRequest,
          authorizeReceiverExecution,
          isRequestPrincipalCurrent: () => true,
        }),
      );
      const res = await app.request('/delegations/task:1/respond', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'request-1', decision: 'accept' }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(authorizeReceiverExecution).not.toHaveBeenCalled();
      const input = respondToDelegatedTaskRequest.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(typeof input.authorizeReceiverExecution).toBe('function');

      // A wrapped effect-path refusal keeps its exact 403 on respond too.
      const refusing = vi.fn().mockRejectedValue(
        Object.assign(
          new Error('The offered Project resource is unavailable.'),
          {
            code: 'receiver_execution_unavailable',
          },
        ),
      );
      const refusingApp = createOrchestrationRoutes(
        {} as never,
        baseDeps({
          respondToDelegatedTaskRequest: refusing,
          authorizeReceiverExecution: vi.fn(),
          isRequestPrincipalCurrent: () => true,
        }),
      );
      const refused = await refusingApp.request('/delegations/task:1/respond', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'request-1', decision: 'accept' }),
      });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        success: false,
        error: 'The offered Project resource is unavailable.',
        code: 'receiver_execution_unavailable',
      });
    });
  });
});
