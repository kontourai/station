/**
 * The browser tools' REST side (#90 #122/#123): the full authority chain
 * runs on every request, from the verified caller to D5, before any browser
 * work — and each refusal is a typed answer the tool can hand to the model.
 * The D5 decision is the REAL principal authorizer over a membership stand-in.
 */
import { describe, expect, test, vi } from 'vitest';
import { createBrowserPrincipalAuthorizer } from '../../services/browser/browser-agent-authority.js';
import {
  type StationControlCaller,
  stationControlCallerPrincipal,
} from '../../tools/station-control-shared.js';
import { createBrowserAgentRoutes } from '../browser-agent.js';

const OPERATOR = 'human:local:operator';

function bound(
  principalId: string,
  overrides: Partial<StationControlCaller> = {},
): StationControlCaller {
  return {
    sessionId: `agent-of-${principalId}`,
    assurance: 'bound',
    principal: stationControlCallerPrincipal(principalId, 'session-owner'),
    localProjectId: 'alpha',
    projectIdSource: 'session-record',
    ...overrides,
  };
}

/** Callers by the test header; a request without it carries none. */
const CALLERS: Record<string, StationControlCaller> = {
  operator: bound(OPERATOR),
  admin: bound('human:deployment:admin'),
  owner: bound('human:deployment:owner'),
  contributor: bound('human:deployment:contrib'),
  'inactive-admin': bound('human:deployment:gone'),
  'beta-admin': bound('human:deployment:beta-admin'),
  'bearer-exposed': bound(OPERATOR, { assurance: 'bearer-exposed' }),
  'delegated-custody': bound(OPERATOR, { assurance: 'delegated-custody' }),
  'inferred-owner': {
    ...bound(OPERATOR),
    principal: stationControlCallerPrincipal(
      OPERATOR,
      'ownerless-single-operator',
    ),
  },
  'slug-lookup': bound(OPERATOR, { projectIdSource: 'slug-lookup' }),
  'no-project': {
    sessionId: 'agent-no-project',
    assurance: 'bound',
    principal: stationControlCallerPrincipal(OPERATOR, 'session-owner'),
  },
};

const MEMBERS: Record<
  string,
  { projectId: string; role: string; status: string }
> = {
  'human:deployment:admin': {
    projectId: 'alpha',
    role: 'admin',
    status: 'active',
  },
  'human:deployment:owner': {
    projectId: 'alpha',
    role: 'owner',
    status: 'active',
  },
  'human:deployment:contrib': {
    projectId: 'alpha',
    role: 'contributor',
    status: 'active',
  },
  'human:deployment:gone': {
    projectId: 'alpha',
    role: 'admin',
    status: 'removed',
  },
  'human:deployment:beta-admin': {
    projectId: 'beta',
    role: 'admin',
    status: 'active',
  },
};

function harness() {
  const automation = {
    status: vi.fn(async () => []),
    open: vi.fn(),
    navigate: vi.fn(),
    resize: vi.fn(),
    snapshot: vi.fn(async () => ({ ok: true, snapshot: '' })),
    click: vi.fn(async () => ({ ok: true, clicked: 'x' })),
    type: vi.fn(),
    press: vi.fn(),
    scroll: vi.fn(),
    waitFor: vi.fn(),
    evaluate: vi.fn(),
  };
  const app = createBrowserAgentRoutes({
    isInternalRequest: (request) => request.headers.get('x-internal') === '1',
    resolveCaller: (request) =>
      CALLERS[request.headers.get('x-test-caller') ?? ''] ?? null,
    authorizePrincipal: createBrowserPrincipalAuthorizer({
      isOperatorPrincipal: (id) => id === OPERATOR,
      membership: {
        admissionsForResolvedPrincipal: (id) => {
          const member = MEMBERS[id];
          return member
            ? [
                {
                  scope: { localProjectId: member.projectId },
                  member: { role: member.role, status: member.status },
                },
              ]
            : [];
        },
      },
    }),
    automation: automation as never,
    settings: { evaluateAllowed: () => false },
    browserReady: () => true,
    projectSlug: () => 'alpha',
    surfaceIdFor: () => undefined,
  });
  const call = (
    operation: string,
    who: string | undefined,
    body: unknown = {},
    internal = true,
  ) =>
    app.request(`/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(internal ? { 'x-internal': '1' } : {}),
        ...(who ? { 'x-test-caller': who } : {}),
      },
      body: JSON.stringify(body),
    });
  const touched = () =>
    Object.values(automation).some((fn) => fn.mock.calls.length > 0);
  return { automation, call, touched };
}

describe('browser-agent routes: the authority chain', () => {
  test('a request that is not Station’s internal principal gets a bare 404', async () => {
    const h = harness();
    const response = await h.call('click', 'operator', {}, false);
    expect(response.status).toBe(404);
    expect(h.touched()).toBe(false);
  });

  test.each([
    [undefined, 'caller-required'],
    ['bearer-exposed', 'caller-not-bound'],
    ['delegated-custody', 'caller-not-bound'],
    ['inferred-owner', 'principal-unverified'],
    ['slug-lookup', 'project-unverified'],
    ['no-project', 'project-unverified'],
    ['contributor', 'not-authorized'],
    ['inactive-admin', 'not-authorized'],
    ['beta-admin', 'not-authorized'],
  ])('%s is refused as %s, and no browser work runs', async (who, code) => {
    const h = harness();
    const response = await h.call('click', who, {
      browserSessionId: 'bs_x',
      target: { x: 1, y: 1 },
    });
    const body = (await response.json()) as {
      ok: boolean;
      code: string;
      message: string;
    };
    expect(body).toMatchObject({ ok: false, code });
    expect(body.message.length).toBeGreaterThan(20);
    expect(h.touched()).toBe(false);
  });

  test('a bearer-exposed refusal explains why in words a model can act on', async () => {
    const h = harness();
    const body = (await (await h.call('status', 'bearer-exposed')).json()) as {
      message: string;
    };
    expect(body.message).toMatch(
      /^Browser tools need a verified agent session; this engine's credential is not bound/,
    );
  });

  test.each([
    ['operator', { kind: 'operator' }, 'operator'],
    [
      'admin',
      { kind: 'project-admin', principalId: 'human:deployment:admin' },
      'principal:human:deployment:admin',
    ],
    [
      'owner',
      { kind: 'project-admin', principalId: 'human:deployment:owner' },
      'principal:human:deployment:owner',
    ],
  ])(
    '%s passes, in its own profile, as an agent acting for its principal',
    async (who, projectActor, profileKey) => {
      const h = harness();
      const response = await h.call('click', who, {
        browserSessionId: 'bs_x',
        target: { x: 1, y: 1 },
      });
      expect(await response.json()).toMatchObject({ ok: true });
      const [authority, selector] = h.automation.click.mock
        .calls[0] as unknown as [Record<string, unknown>, string];
      expect(selector).toBe('bs_x');
      expect(authority).toMatchObject({
        projectId: 'alpha',
        projectActor,
        profileKey,
        actor: { kind: 'agent', sessionId: CALLERS[who]!.sessionId },
      });
    },
  );

  test("open binds the session to the caller's own thread; a threadId in the body is ignored", async () => {
    const h = harness();
    h.automation.open.mockResolvedValue({
      ok: true,
      reused: false,
      session: {
        browserSessionId: 'bs_x',
        hostId: 'local',
        threadId: 'agent-of-human:local:operator',
        state: 'live',
        url: 'about:blank',
        viewport: { width: 1, height: 1, deviceScaleFactor: 1 },
        generation: 1,
      },
    } as never);
    const response = await h.call('open', 'operator', {
      url: 'about:blank',
      threadId: 'forged-thread',
    });
    expect(await response.json()).toMatchObject({
      ok: true,
      session: { threadId: 'agent-of-human:local:operator' },
    });
    const [authority, input] = h.automation.open.mock.calls[0] as unknown as [
      { threadId?: string },
      Record<string, unknown>,
    ];
    expect(authority.threadId).toBe('agent-of-human:local:operator');
    expect(input).not.toHaveProperty('threadId');
    expect(JSON.stringify(h.automation.open.mock.calls)).not.toContain(
      'forged-thread',
    );
  });

  test('identity in the body is ignored: the caller comes from the credential alone', async () => {
    const h = harness();
    const body = (await (
      await h.call('status', 'contributor', {
        principalId: OPERATOR,
        sessionId: 'agent-of-human:local:operator',
        projectId: 'alpha',
      })
    ).json()) as { code: string };
    expect(body.code).toBe('not-authorized');
    expect(h.touched()).toBe(false);
  });
});
