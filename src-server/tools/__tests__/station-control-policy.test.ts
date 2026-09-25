/**
 * #2377 slice A: the station-control authority table against the owner's
 * decisions, written out here independently of the table so a weakened entry
 * cannot pass by agreeing with itself.
 */
import { describe, expect, test } from 'vitest';

import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';
import {
  authorizeStationControlRequest,
  evaluateStationControlPolicy,
  matchStationControlRoute,
  STATION_CONTROL_INFRASTRUCTURE_POLICY,
  STATION_CONTROL_OPERATOR_PRINCIPAL_ID,
  STATION_CONTROL_TOOL_POLICY,
  type StationControlPolicyCaller,
  type StationControlPolicyContext,
  type StationControlToolPolicy,
} from '../station-control-policy.js';

const OPERATOR = 'human:local:operator';
const isOperatorPrincipal = (id: string) => id === OPERATOR;

const TABLE = Object.entries(STATION_CONTROL_TOOL_POLICY) as [
  string,
  StationControlToolPolicy,
][];

// Decision 1 (owner, 2026-09-25), transcribed from the issue.
const DECISION_1_BOUND_OPERATOR = [
  'create_agent',
  'update_agent',
  'delete_agent',
  'install_skill',
  'uninstall_skill',
  'update_skill',
  'delete_integration',
  'update_config',
  'add_job',
  'update_job',
  'run_job',
  'enable_job',
  'delete_job',
  'create_ssh_environment',
  'connect_ssh_environment',
  'remove_ssh_environment',
  'migrate_knowledge',
];
const DECISION_1_DELEGATED_OPERATOR = [
  'reindex_knowledge',
  'disable_job',
  'disconnect_ssh_environment',
  'list_delegation_targets',
];
const DECISION_1_PERSON_ONLY = [
  'create_integration',
  'install_registry_integration',
  'create_provider',
];
const DECISION_1_PERSON_ONLY_WITH_TRUST_ALL_TOOLS = ['add_job', 'update_job'];
// Slice C: dispatch keeps today's effective policy (any verified caller).
const SLICE_C_DISPATCH = [
  'send_message',
  'delegate_task',
  'continue_task',
  'interrupt_task',
  'respond_to_task_request',
  'get_task',
  'get_task_events',
  'list_delegated_tasks',
];

const CALLERS: Record<string, StationControlPolicyCaller | null> = {
  none: null,
  'bound-operator': {
    assurance: 'bound',
    principal: { id: OPERATOR, elevationEligible: true },
  },
  'bound-operator-inferred': {
    assurance: 'bound',
    principal: { id: OPERATOR, elevationEligible: false },
  },
  'bound-other-person': {
    assurance: 'bound',
    principal: { id: 'human:local:someone-else', elevationEligible: true },
  },
  'delegated-operator': {
    assurance: 'delegated-custody',
    principal: { id: OPERATOR, elevationEligible: true },
  },
  'bearer-operator': {
    assurance: 'bearer-exposed',
    principal: { id: OPERATOR, elevationEligible: true },
  },
};
const BODIES: unknown[] = [undefined, { trustAllTools: true }];

function contexts(): StationControlPolicyContext[] {
  return Object.values(CALLERS).flatMap((caller) =>
    BODIES.map((body) => ({ caller, isOperatorPrincipal, body })),
  );
}

describe('station-control authority table: the owner decisions', () => {
  test('decision 1: station-wide mutations need a bound operator caller', () => {
    for (const name of DECISION_1_BOUND_OPERATOR) {
      const policy = STATION_CONTROL_TOOL_POLICY[
        name as keyof typeof STATION_CONTROL_TOOL_POLICY
      ] as StationControlToolPolicy;
      expect([name, policy.assurance, policy.role]).toEqual([
        name,
        'bound',
        'operator',
      ]);
    }
  });

  test('decision 1: the delegated-custody operator mutations', () => {
    for (const name of DECISION_1_DELEGATED_OPERATOR) {
      const policy = STATION_CONTROL_TOOL_POLICY[
        name as keyof typeof STATION_CONTROL_TOOL_POLICY
      ] as StationControlToolPolicy;
      expect([name, policy.assurance, policy.role]).toEqual([
        name,
        'delegated-custody',
        'operator',
      ]);
    }
  });

  test('decision 1: host code and credentials are a person’s step', () => {
    const always = TABLE.filter(([, p]) => p.personOnly === 'always').map(
      ([n]) => n,
    );
    expect(always.sort()).toEqual([...DECISION_1_PERSON_ONLY].sort());
    const conditional = TABLE.filter(
      ([, p]) => p.personOnly === 'when-trust-all-tools',
    ).map(([n]) => n);
    expect(conditional.sort()).toEqual(
      [...DECISION_1_PERSON_ONLY_WITH_TRUST_ALL_TOOLS].sort(),
    );
  });

  test('no other tool requires the operator: the operator set is exactly decision 1', () => {
    const operator = TABLE.filter(([, p]) => p.role === 'operator').map(
      ([n]) => n,
    );
    expect(operator.sort()).toEqual(
      [
        ...DECISION_1_BOUND_OPERATOR,
        ...DECISION_1_DELEGATED_OPERATOR,
        ...DECISION_1_PERSON_ONLY,
      ].sort(),
    );
  });

  test('slice C: dispatch keeps any verified caller and names slice C', () => {
    for (const name of SLICE_C_DISPATCH) {
      const policy = STATION_CONTROL_TOOL_POLICY[
        name as keyof typeof STATION_CONTROL_TOOL_POLICY
      ] as StationControlToolPolicy;
      expect([name, policy.assurance, policy.tightenedBy]).toEqual([
        name,
        'any',
        'C',
      ]);
      expect(policy.toolClass).toBe('mutating');
    }
  });

  test('decision 4: a caller-less request reaches exactly the read-only tools', () => {
    for (const [name, policy] of TABLE) {
      if (policy.enforcedBy === 'route') continue;
      const refusal = evaluateStationControlPolicy(policy, { caller: null });
      if (policy.toolClass === 'read-only')
        expect([name, refusal]).toEqual([name, undefined]);
      else
        expect([name, refusal?.code]).toEqual([
          name,
          policy.personOnly === 'always'
            ? 'station_control_person_only'
            : 'station_control_caller_required',
        ]);
    }
  });
});

describe('station-control authority table: no label nothing computes', () => {
  test('every role the central guard does not enforce names the slice that will', () => {
    for (const [name, policy] of [
      ...TABLE,
      ...Object.entries(STATION_CONTROL_INFRASTRUCTURE_POLICY),
    ] as [string, StationControlToolPolicy][]) {
      if (policy.role === 'self' || policy.role === 'project')
        expect([name, policy.tightenedBy ?? policy.enforcedBy]).not.toEqual([
          name,
          undefined,
        ]);
      if (policy.role === 'project')
        expect([name, policy.projectAction]).not.toEqual([name, undefined]);
    }
  });

  test('read-only entries accept any caller and are never person-only', () => {
    for (const [name, policy] of TABLE) {
      if (policy.toolClass !== 'read-only') continue;
      expect([name, policy.assurance, policy.personOnly]).toEqual([
        name,
        'any',
        'never',
      ]);
      expect([name, policy.role]).not.toEqual([name, 'operator']);
    }
  });

  test('every route is a rooted pattern with no wildcard', () => {
    for (const [name, policy] of TABLE)
      for (const route of policy.routes) {
        expect([name, route.path]).toEqual([
          name,
          expect.stringMatching(/^(\/(:[A-Za-z]+|[A-Za-z0-9._-]+))+$/),
        ]);
      }
  });

  test('every declared route resolves back to its own tool', () => {
    for (const [name, policy] of TABLE)
      for (const route of policy.routes) {
        const concrete = route.path.replace(/:[A-Za-z]+/g, 'x');
        expect([
          name,
          matchStationControlRoute(route.method, concrete)?.owners,
        ]).toEqual([name, expect.arrayContaining([name])]);
      }
  });
});

describe('station-control authority table: shared leaves', () => {
  // A route cannot tell which tool is calling, so a leaf reached by a
  // stricter and a looser tool is only as strict as the looser one. This is
  // the complete list of tool routes the server guard enforces more loosely
  // than the tool's own entry, each for the reason given. A new sharing turns
  // this red instead of silently weakening a tool.
  const EXPECTED_WEAKENED: Record<string, readonly string[]> = {
    // Dispatch (slice C) reaches these while resolving an SSH target; slice C
    // moves that server-side.
    connect_ssh_environment: [
      'POST /api/environments/ssh/:id/connect',
      // get_ssh_environment is a read.
      'GET /api/environments/ssh/:id',
    ],
    list_delegation_targets: [
      'GET /api/environments/ssh',
      'POST /api/environments/ssh/:id/connect',
      'GET /api/environments/peers/:environmentId/credential',
      'GET /api/connections/agents',
      'GET /api/connections/:id',
      'GET /api/agents',
      'GET /api/agents/:id',
      'GET /api/projects/:slug',
      'POST /api/orchestration/chat',
      'POST /api/orchestration/chat/delegated',
      'POST /api/orchestration/chat/background',
      'POST /api/orchestration/chat/:conversationId/continue',
      'POST /api/orchestration/delegations',
      'GET /api/orchestration/delegations/:taskId',
      'GET /api/orchestration/delegations/:taskId/events',
      'POST /api/orchestration/delegations/:taskId/continue',
      'POST /api/orchestration/delegations/:taskId/respond',
      'POST /api/orchestration/delegations/:taskId/interrupt',
      'POST /api/orchestration/commands',
      'GET /api/orchestration/sessions/read-model',
      'GET /api/orchestration/sessions/:threadId',
      'GET /api/orchestration/sessions/:threadId/event-page',
    ],
    // Its status poll is get_review_request's read.
    run_independent_review: [
      'GET /api/projects/:projectSlug/reviews/requests/:requestId',
    ],
  };
  // Every dispatch tool shares three read leaves with a read-only tool:
  // the SSH list (list_delegation_environments), a Project read
  // (get_project) and, for the two that navigate, navigate_to.
  for (const name of SLICE_C_DISPATCH)
    EXPECTED_WEAKENED[name] = [
      'GET /api/environments/ssh',
      'GET /api/projects/:slug',
      ...(name === 'send_message' || name === 'delegate_task'
        ? ['POST /api/ui']
        : []),
    ];

  test('the complete list of tool routes the guard enforces more loosely than the tool', () => {
    const weakened: Record<string, string[]> = {};
    for (const [name, policy] of TABLE) {
      for (const route of policy.routes) {
        const concrete = route.path.replace(/:[A-Za-z]+/g, 'x');
        const looser = contexts().some(
          (context) =>
            evaluateStationControlPolicy(policy, context) !== undefined &&
            authorizeStationControlRequest(route.method, concrete, context) ===
              undefined,
        );
        if (looser)
          weakened[name] = [
            ...(weakened[name] ?? []),
            `${route.method} ${route.path}`,
          ];
      }
    }
    expect(weakened).toEqual(EXPECTED_WEAKENED);
  });
});

describe('station-control authority: route matching and refusals', () => {
  test('the tool side names the same operator the server does', () => {
    expect(STATION_CONTROL_OPERATOR_PRINCIPAL_ID).toBe(
      LOCAL_OPERATOR_PRINCIPAL_ID,
    );
    // Without an injected predicate the default is that operator id.
    const decide = (id: string) =>
      authorizeStationControlRequest('PUT', '/config/app', {
        caller: {
          assurance: 'bound',
          principal: { id, elevationEligible: true },
        },
      })?.code;
    expect(decide(LOCAL_OPERATOR_PRINCIPAL_ID)).toBeUndefined();
    expect(decide('human:local:someone-else')).toBe(
      'station_control_role_required',
    );
  });

  test('HEAD is GET, the method is part of the leaf, and an unknown leaf is unmapped', () => {
    expect(matchStationControlRoute('HEAD', '/config/app')?.owners).toEqual([
      'get_config',
    ]);
    expect(matchStationControlRoute('PUT', '/config/app')?.owners).toEqual([
      'update_config',
    ]);
    expect(matchStationControlRoute('DELETE', '/config/app')).toBeUndefined();
    expect(
      authorizeStationControlRequest('POST', '/notifications', {
        caller: CALLERS['bound-operator'] ?? null,
        isOperatorPrincipal,
      })?.code,
    ).toBe('station_control_route_unmapped');
  });

  test('each refusal code for one operator mutation (update_config)', () => {
    const decide = (caller: StationControlPolicyCaller | null) =>
      authorizeStationControlRequest('PUT', '/config/app', {
        caller,
        isOperatorPrincipal,
      })?.code;
    expect(decide(null)).toBe('station_control_caller_required');
    expect(decide(CALLERS['bearer-operator'] ?? null)).toBe(
      'station_control_assurance_insufficient',
    );
    expect(decide(CALLERS['delegated-operator'] ?? null)).toBe(
      'station_control_assurance_insufficient',
    );
    expect(decide(CALLERS['bound-other-person'] ?? null)).toBe(
      'station_control_role_required',
    );
    expect(decide(CALLERS['bound-operator-inferred'] ?? null)).toBe(
      'station_control_role_required',
    );
    expect(decide(CALLERS['bound-operator'] ?? null)).toBeUndefined();
  });

  test('add_job with trustAllTools is a person’s step even for the bound operator; without it the operator may', () => {
    const decide = (body: unknown) =>
      authorizeStationControlRequest('POST', '/scheduler/jobs', {
        caller: CALLERS['bound-operator'] ?? null,
        isOperatorPrincipal,
        body,
      })?.code;
    expect(decide({ name: 'j', trustAllTools: true })).toBe(
      'station_control_person_only',
    );
    expect(decide({ name: 'j', trustAllTools: false })).toBeUndefined();
    expect(decide({ name: 'j' })).toBeUndefined();
  });
});
