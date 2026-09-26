/**
 * #2377 slice A: the station-control authority table against the owner's
 * decisions, written out here independently of the table so a weakened entry
 * cannot pass by agreeing with itself.
 */
import { describe, expect, test } from 'vitest';

import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';
import {
  authorizeStationControlRequest,
  DISPATCH_ROUTES,
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
// Decision 1 names no delegated-custody exception: every Station-wide
// mutation needs a bound operator caller.
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
  'disable_job',
  'delete_job',
  'create_ssh_environment',
  'connect_ssh_environment',
  'disconnect_ssh_environment',
  'remove_ssh_environment',
  'list_delegation_targets',
  'reindex_knowledge',
  'migrate_knowledge',
];
// Decision 2 (slice B): operator-wide reads — Station-wide data no single
// person's view contains — need a bound caller acting for the operator.
const DECISION_2_OPERATOR_READS = [
  'get_job_logs',
  'get_achievements',
  'get_ssh_environment',
];
// Decision 2 (slice B): reads scoped to the principal the caller's session
// acts for. Transcribed from the slice B brief, independently of the table.
const DECISION_2_PRINCIPAL_READS = [
  'list_conversations',
  'get_conversation_messages',
  'board_read',
  'get_basis',
  'get_task_basis',
  'get_session_inventory',
  'list_plugins',
  'read_monitoring_events',
  'navigate_to',
  'list_projects',
  'get_project',
  'list_project_layouts',
  'get_usage',
  'search_knowledge',
  'get_review_request',
  'list_review_receipts',
  'get_review_receipt',
];
// Decision 3: answering a worker's request needs bound + Project approve;
// until slice C adds the Project path, only the bound operator.
const DECISION_3_BOUND_OPERATOR = ['respond_to_task_request'];
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

  test('decision 3: answering a worker request needs the bound operator (slice C adds Project approve)', () => {
    for (const name of DECISION_3_BOUND_OPERATOR) {
      const policy = STATION_CONTROL_TOOL_POLICY[
        name as keyof typeof STATION_CONTROL_TOOL_POLICY
      ] as StationControlToolPolicy;
      expect([name, policy.assurance, policy.role, policy.tightenedBy]).toEqual(
        [name, 'bound', 'operator', ['C']],
      );
    }
  });

  test('decision 2: operator-wide reads need a bound operator caller', () => {
    for (const name of DECISION_2_OPERATOR_READS) {
      const policy = STATION_CONTROL_TOOL_POLICY[
        name as keyof typeof STATION_CONTROL_TOOL_POLICY
      ] as StationControlToolPolicy;
      expect([name, policy.assurance, policy.role, policy.toolClass]).toEqual([
        name,
        'bound',
        'operator',
        'read-only',
      ]);
    }
  });

  test('decision 2: principal-scoped reads need a caller whose session has a recorded owner', () => {
    for (const name of DECISION_2_PRINCIPAL_READS) {
      const policy = STATION_CONTROL_TOOL_POLICY[
        name as keyof typeof STATION_CONTROL_TOOL_POLICY
      ] as StationControlToolPolicy;
      expect([name, policy.toolClass, policy.assurance]).toEqual([
        name,
        'read-only',
        'any',
      ]);
      expect([name, ['self', 'project'].includes(policy.role)]).toEqual([
        name,
        true,
      ]);
      expect([
        name,
        evaluateStationControlPolicy(policy, { caller: null })?.code,
      ]).toEqual([name, 'station_control_caller_required']);
      expect([
        name,
        evaluateStationControlPolicy(policy, {
          caller: { assurance: 'bearer-exposed' },
        })?.code,
      ]).toEqual([name, 'station_control_role_required']);
      expect([
        name,
        evaluateStationControlPolicy(policy, {
          caller: CALLERS['bound-other-person'],
          isOperatorPrincipal,
        }),
      ]).toEqual([name, undefined]);
      expect([
        name,
        evaluateStationControlPolicy(policy, {
          caller: {
            assurance: 'bearer-exposed',
            principal: {
              id: 'human:local:someone-else',
              elevationEligible: true,
            },
          },
          isOperatorPrincipal,
        }),
      ]).toEqual([name, undefined]);
    }
  });

  test('no operator mutation accepts less than a bound caller', () => {
    for (const [name, policy] of TABLE)
      if (policy.role === 'operator')
        expect([name, policy.assurance]).toEqual([name, 'bound']);
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
        ...DECISION_2_OPERATOR_READS,
        ...DECISION_3_BOUND_OPERATOR,
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
        ['C'],
      ]);
      expect(policy.toolClass).toBe('mutating');
    }
  });

  test('decision 4 with decision 2: a caller-less request reaches exactly the reads of nobody’s data', () => {
    for (const [name, policy] of TABLE) {
      if (policy.enforcedBy === 'route') continue;
      const refusal = evaluateStationControlPolicy(policy, { caller: null });
      if (policy.toolClass === 'read-only' && policy.role === 'none')
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
  test('every self and project role is one the guard evaluates: an owner is required', () => {
    for (const [name, policy] of [
      ...TABLE,
      ...Object.entries(STATION_CONTROL_INFRASTRUCTURE_POLICY),
    ] as [string, StationControlToolPolicy][]) {
      if (policy.role !== 'self' && policy.role !== 'project') continue;
      if (policy.enforcedBy === 'route') continue;
      // A caller with no recorded owner acts for no one.
      expect([
        name,
        evaluateStationControlPolicy(policy, {
          caller: { assurance: 'bound' },
        })?.code,
      ]).toEqual([name, 'station_control_role_required']);
      if (policy.role === 'project')
        expect([name, policy.projectAction]).not.toEqual([name, undefined]);
    }
  });

  test('every remaining tightenedBy tag names an open slice; slice B names none', () => {
    for (const [name, policy] of [
      ...TABLE,
      ...Object.entries(STATION_CONTROL_INFRASTRUCTURE_POLICY),
    ] as [string, StationControlToolPolicy][])
      for (const slice of policy.tightenedBy ?? [])
        expect([name, ['C', 'D'].includes(slice)]).toEqual([name, true]);
  });

  test('every entry that owns a leaf shared with dispatch names slice C', () => {
    const dispatchLeaves = new Set(
      DISPATCH_ROUTES.map(
        (route) => `${route.method} ${route.path.replace(/:[A-Za-z]+/g, ':')}`,
      ),
    );
    const missing = TABLE.filter(([, policy]) =>
      policy.routes.some((route) =>
        dispatchLeaves.has(
          `${route.method} ${route.path.replace(/:[A-Za-z]+/g, ':')}`,
        ),
      ),
    )
      .filter(([, policy]) => !policy.tightenedBy?.includes('C'))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  test('read-only entries are never person-only; only the operator-wide reads need more than any caller', () => {
    for (const [name, policy] of TABLE) {
      if (policy.toolClass !== 'read-only') continue;
      expect([name, policy.personOnly]).toEqual([name, 'never']);
      expect([name, policy.assurance]).toEqual([
        name,
        DECISION_2_OPERATOR_READS.includes(name) ? 'bound' : 'any',
      ]);
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
  const DISPATCH_LEAVES = DISPATCH_ROUTES.map(
    (route) => `${route.method} ${route.path}`,
  );
  const EXPECTED_WEAKENED: Record<string, readonly string[]> = {
    // Dispatch (slice C) reaches these while resolving an SSH target; slice C
    // moves that server-side.
    connect_ssh_environment: [
      'POST /api/environments/ssh/:id/connect',
      // Slice B: get_ssh_environment is an operator-wide read, so its leaf
      // is no longer looser than this entry.
    ],
    // Every leaf is shared with dispatch (slice C).
    list_delegation_targets: DISPATCH_LEAVES,
    // Its own respond leaf is strict; the rest is the dispatch plumbing it
    // shares (slice C). The respond COMMAND on /commands is held to a bound
    // operator by the leaf's own rule, not by this entry.
    respond_to_task_request: DISPATCH_LEAVES,
    // Slice B: its status poll, get_review_request, now needs a recorded
    // owner too, so it no longer loosens this entry.
  };
  // Every dispatch tool shares the SSH list with a caller-less read
  // (list_delegation_environments). Slice B: the Project read (get_project)
  // and navigate_to are principal-scoped, so they no longer admit the
  // caller-less request dispatch refuses.
  for (const name of SLICE_C_DISPATCH)
    EXPECTED_WEAKENED[name] = ['GET /api/environments/ssh'];

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

  test('a respondToRequest command needs the bound operator, whichever tool reaches /commands', () => {
    const decide = (caller: StationControlPolicyCaller | null, body: unknown) =>
      authorizeStationControlRequest('POST', '/api/orchestration/commands', {
        caller,
        isOperatorPrincipal,
        body,
      })?.code;
    for (const decision of ['accept', 'acceptForSession'])
      expect(
        decide(CALLERS['bearer-operator'] ?? null, {
          type: 'respondToRequest',
          decision,
        }),
      ).toBe('station_control_assurance_insufficient');
    expect(
      decide(CALLERS['bound-other-person'] ?? null, {
        type: 'respondToRequest',
      }),
    ).toBe('station_control_role_required');
    expect(decide(null, { type: 'respondToRequest' })).toBe(
      'station_control_caller_required',
    );
    expect(
      decide(CALLERS['bound-operator'] ?? null, { type: 'respondToRequest' }),
    ).toBeUndefined();
    for (const mode of ['auto', 'connection-default'])
      expect(
        decide(CALLERS['bearer-operator'] ?? null, {
          type: 'setApprovalMode',
          mode,
        }),
      ).toBe('station_control_assurance_insufficient');
    // Other commands keep the dispatch policy (slice C), steerTurn included.
    expect(
      decide(CALLERS['bearer-operator'] ?? null, { type: 'steerTurn' }),
    ).toBeUndefined();
    expect(
      decide(CALLERS['bearer-operator'] ?? null, { type: 'interruptTurn' }),
    ).toBeUndefined();
    // The dedicated respond leaf is the bound operator's too.
    expect(
      authorizeStationControlRequest(
        'POST',
        '/api/orchestration/delegations/t/respond',
        { caller: CALLERS['bearer-operator'] ?? null, isOperatorPrincipal },
      )?.code,
    ).toBe('station_control_assurance_insufficient');
  });

  test('retargeting a granted job is a person’s step even for the bound operator', () => {
    const decide = (retargetsGrantedJob: boolean) =>
      authorizeStationControlRequest('PUT', '/scheduler/jobs/nightly', {
        caller: CALLERS['bound-operator'] ?? null,
        isOperatorPrincipal,
        body: { prompt: 'new' },
        retargetsGrantedJob,
      })?.code;
    expect(decide(true)).toBe('station_control_person_only');
    expect(decide(false)).toBeUndefined();
  });
});
