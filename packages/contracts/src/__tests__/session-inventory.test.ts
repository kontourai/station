import {
  composeBasisProjection,
  SURFACE_BASIS_VERSION,
} from '@kontourai/surface/basis';
import { describe, expect, test } from 'vitest';
import {
  deriveSessionWorkItemGithubUrl,
  parseSessionInventoryGroupPage,
  parseSessionInventoryProjection,
  SESSION_INVENTORY_V1,
  SESSION_INVENTORY_V1_GROUP_IDS,
  SESSION_INVENTORY_V2,
  SESSION_INVENTORY_V2_GROUP_IDS,
} from '../session-inventory.js';
import {
  buildStationSessionInventoryMcpEnvelope,
  buildStationSessionInventoryMcpGroupPageEnvelope,
  buildStationSessionInventoryMcpV2Envelope,
  parseStationSessionInventoryMcpEnvelope,
  parseStationSessionInventoryMcpInput,
  parseStationSessionInventoryMcpV2Envelope,
  parseStationSessionInventoryMcpV2Input,
} from '../session-inventory-mcp.js';
import { createStationAnswerBinding } from '../task-basis.js';

function projection(): any {
  return {
    version: SESSION_INVENTORY_V1,
    scope: { kind: 'whole-session', sessionId: 'session-a' },
    groups: SESSION_INVENTORY_V1_GROUP_IDS.map((id) => ({
      id,
      owner: { owner: 'station.inventory', id: 'v1' },
      state: 'empty',
      count: { kind: 'exact', value: 0 },
      items: [],
      gaps: [],
    })),
  };
}
function currentProjection(): any {
  const binding = createStationAnswerBinding({
    sessionId: 'session-a',
    turnId: 'turn-a',
    messageId: 'message-a',
  });
  const basis = composeBasisProjection({
    version: SURFACE_BASIS_VERSION,
    answer: {
      owner: { authority: '@kontourai/thread' },
      state: 'available',
      observedAt: '2026-08-27T00:00:00.000Z',
      value: {
        ref: binding.answer,
        fact: 'answer-observed',
        observedAt: '2026-08-27T00:00:00.000Z',
      },
    },
    assessment: {
      owner: { authority: '@kontourai/surface' },
      state: 'not-captured',
      observedAt: '2026-08-27T00:00:00.000Z',
    },
    contributions: [],
  });
  const value = projection();
  value.scope = {
    kind: 'current-answer',
    sessionId: 'session-a',
    turnId: 'turn-a',
  };
  value.basis = basis;
  value.basisBinding = binding;
  value.groups[1] = {
    id: 'sources',
    owner: { owner: '@kontourai/fieldwork', id: 'reviewed-source/v1' },
    state: 'available',
    count: { kind: 'exact', value: 1 },
    items: [
      {
        kind: 'surface-answer-contribution',
        key: `reviewed-source:fieldwork-reviewed-source:v1:${'a'.repeat(64)}`,
        owner: { owner: '@kontourai/fieldwork', id: 'reviewed-source/v1' },
        relations: ['contributed-to'],
        sessionId: 'session-a',
        turnId: 'turn-a',
        answerReferenceId: 'message-a',
        reviewedSource: {
          exactRef: `fieldwork-reviewed-source:v1:${'a'.repeat(64)}`,
          review: 'accepted',
          currentness: 'current',
          checkedAt: '2026-08-27T00:00:00.000Z',
          assessmentRevision: 1,
        },
        contributionGaps: [],
      },
    ],
    gaps: [],
  };
  return value;
}
function v2Projection(): any {
  return {
    version: SESSION_INVENTORY_V2,
    scope: { kind: 'whole-session', sessionId: 'session-a' },
    groups: SESSION_INVENTORY_V2_GROUP_IDS.map((id) => ({
      id,
      owner: { owner: 'station.inventory', id: 'v2' },
      state: 'empty',
      count: { kind: 'exact', value: 0 },
      items: [],
      gaps: [],
    })),
  };
}
describe('Session inventory v1', () => {
  test('closes the portable MCP input and keeps continuations out of structured content', () => {
    expect(
      parseStationSessionInventoryMcpInput({
        operation: 'open',
        scope: { kind: 'whole-session', sessionId: 'session-a' },
      }),
    ).not.toBeNull();
    expect(
      parseStationSessionInventoryMcpInput({
        operation: 'page',
        scope: { kind: 'whole-session', sessionId: 'session-a' },
        occurrenceId: 'a'.repeat(24),
        groupId: 'inputs',
        continuationToken: 'b'.repeat(16),
      }),
    ).not.toBeNull();
    const value = projection();
    const envelope = buildStationSessionInventoryMcpEnvelope(value);
    expect(envelope?.kind).toBe('projection');
    if (envelope?.kind === 'projection')
      expect(envelope.projection.groups[0]).not.toHaveProperty('continuation');
    const page = buildStationSessionInventoryMcpGroupPageEnvelope({
      version: SESSION_INVENTORY_V1,
      scope: value.scope,
      group: value.groups[0],
    });
    expect(page?.kind).toBe('group-page');
    expect(parseStationSessionInventoryMcpEnvelope(page)).toEqual(page);
    if (page?.kind !== 'group-page') throw new Error('expected group page');
    expect(
      parseStationSessionInventoryMcpEnvelope({
        ...page,
        page: {
          ...page.page,
          group: { ...page.page.group, continuation: 'x'.repeat(16) },
        },
      }),
    ).toBeNull();
    for (const hostile of [
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error('prototype');
          },
        },
      ),
      Object.defineProperty({}, 'version', {
        get: () => {
          throw new Error('getter');
        },
      }),
    ])
      expect(parseStationSessionInventoryMcpEnvelope(hostile)).toBeNull();
  });
  test('accepts the fixed, ordered empty projection', () => {
    expect(parseSessionInventoryProjection(projection())).not.toBeNull();
  });
  test('rejects group reordering, over-previewing and unknown fields', () => {
    const reordered = projection();
    reordered.groups.reverse();
    expect(parseSessionInventoryProjection(reordered)).toBeNull();
    const tooMany = projection();
    tooMany.groups[0]!.items = Array.from({ length: 3 }, () => ({
      kind: 'thread-authored-input',
      key: 'i',
      owner: { owner: 'thread', id: 'v1' },
      relations: ['provided-to'],
      sessionId: 'session-a',
      eventId: 'event-a',
      turnId: 'turn-a',
      inputKind: 'message',
      attachmentDescriptors: [],
    }));
    expect(parseSessionInventoryProjection(tooMany)).toBeNull();
    const extra = projection() as ReturnType<typeof projection> & {
      extra?: boolean;
    };
    extra.extra = true;
    expect(parseSessionInventoryProjection(extra)).toBeNull();
  });
  test('rejects inadmissible contribution and protected restricted fields', () => {
    const badRelation = projection();
    badRelation.groups[0]!.items = [
      {
        kind: 'thread-authored-input',
        key: 'i',
        owner: { owner: 'thread', id: 'v1' },
        relations: ['contributed-to'],
        sessionId: 'session-a',
        eventId: 'event-a',
        turnId: 'turn-a',
        inputKind: 'message',
        attachmentDescriptors: [],
      },
    ];
    expect(parseSessionInventoryProjection(badRelation)).toBeNull();
    const restricted = projection();
    restricted.groups[1] = {
      id: 'sources',
      owner: { owner: 'surface.sources', id: 'v1' },
      state: 'restricted',
      count: { kind: 'exact', value: 0 },
      items: [],
      gaps: [{ kind: 'restricted' }],
    };
    expect(parseSessionInventoryProjection(restricted)).toBeNull();
    const missingRestrictedGap = projection();
    missingRestrictedGap.groups[1] = {
      id: 'sources',
      owner: { owner: 'surface.sources', id: 'v1' },
      state: 'restricted',
      items: [],
      gaps: [],
    };
    expect(parseSessionInventoryProjection(missingRestrictedGap)).toBeNull();
  });
  test('rejects hostile row detail, mismatched current turn and mismatched kept task', () => {
    const malformed = projection();
    malformed.groups[0]!.items = [
      {
        kind: 'thread-authored-input',
        key: 'i',
        owner: { owner: 'thread', id: 'v1' },
        relations: ['provided-to'],
        sessionId: 'session-a',
        eventId: 'event-a',
        turnId: 'turn-a',
        inputKind: 'message',
        attachmentDescriptors: [
          {
            kind: 'attachment',
            name: 'x',
            mediaType: 'text/plain',
            length: 'not-a-number',
          },
        ],
      },
    ];
    expect(parseSessionInventoryProjection(malformed)).toBeNull();
    const current = projection();
    current.scope = {
      kind: 'current-answer',
      sessionId: 'session-a',
      turnId: 'turn-a',
    };
    current.groups[0]!.items = [
      {
        kind: 'thread-authored-input',
        key: 'i',
        owner: { owner: 'thread', id: 'v1' },
        relations: ['provided-to'],
        sessionId: 'session-a',
        eventId: 'event-a',
        turnId: 'turn-other',
        inputKind: 'message',
        attachmentDescriptors: [],
      },
    ];
    expect(parseSessionInventoryProjection(current)).toBeNull();
    const kept = projection();
    kept.scope = {
      kind: 'kept-in-task',
      sessionId: 'session-a',
      taskId: 'task-a',
    };
    kept.groups[7]!.items = [
      {
        kind: 'task-kept-result',
        key: 'k',
        owner: { owner: 'task', id: 'v1' },
        relations: ['kept-in-task'],
        taskId: 'task-other',
        provenanceSessionId: 'session-a',
        referenceId: 'result-a',
      },
    ];
    expect(parseSessionInventoryProjection(kept)).toBeNull();
  });
  test('requires one bound Basis and rejects foreign reviewed-source identity, relation, and gap data', () => {
    const notChosen = currentProjection();
    notChosen.groups[1].items[0].reviewedSource.review = 'not-chosen';
    notChosen.groups[1].items[0].contributionGaps = [
      'reviewed-source-review-not-chosen',
    ];
    expect(
      parseSessionInventoryProjection(notChosen)?.groups[1].items[0],
    ).toMatchObject({
      reviewedSource: { review: 'not-chosen' },
      contributionGaps: ['reviewed-source-review-not-chosen'],
      relations: ['contributed-to'],
    });
    expect(parseSessionInventoryProjection(currentProjection())).not.toBeNull();
    const missingBasis = currentProjection();
    delete missingBasis.basis;
    expect(parseSessionInventoryProjection(missingBasis)).toBeNull();
    const wrongMessage = currentProjection();
    wrongMessage.basisBinding.answer.messageId = 'other-message';
    expect(parseSessionInventoryProjection(wrongMessage)).toBeNull();
    const badRef = currentProjection();
    badRef.groups[1].items[0].reviewedSource.exactRef =
      'fieldwork-reviewed-source:v1:UPPER';
    expect(parseSessionInventoryProjection(badRef)).toBeNull();
    const inferredSupport = currentProjection();
    inferredSupport.groups[1].items[0].relations = [
      'contributed-to',
      'supports',
    ];
    expect(parseSessionInventoryProjection(inferredSupport)).toBeNull();
    const badGap = currentProjection();
    badGap.groups[1].items[0].contributionGaps = ['https://private.example'];
    expect(parseSessionInventoryProjection(badGap)).toBeNull();
  });
});

describe('Session inventory v2', () => {
  test('requires the dedicated ordered work-items group and admits only its closed row', () => {
    const value = v2Projection();
    const group = value.groups.find((item: any) => item.id === 'work-items');
    group.state = 'available';
    group.count = { kind: 'exact', value: 1 };
    group.items = [
      {
        kind: 'station-session-work-item',
        key: 'work-item:association-a',
        owner: { owner: 'station.session-work-items', id: 'v1' },
        relations: ['observed-during', 'produced-by'],
        sessionId: 'session-a',
        conversationId: 'conversation-a',
        eventId: 'event-a',
        turnId: 'turn-a',
        toolCallId: 'call-a',
        provider: { id: 'github', host: 'github.com' },
        workItemRef: 'github:kontourai/station#235',
        repository: { owner: 'kontourai', name: 'station' },
        nativeId: '1234567890',
        associationIds: ['association-a'],
        observedAt: '2026-08-28T12:00:00.000Z',
      },
    ];
    expect(parseSessionInventoryProjection(value)).not.toBeNull();
    const valid = structuredClone(value);
    const wrongGroup = structuredClone(valid);
    const input = wrongGroup.groups.find((item: any) => item.id === 'inputs');
    input.state = 'available';
    input.count = { kind: 'exact', value: 1 };
    input.items = group.items;
    group.items = [];
    group.state = 'empty';
    group.count = { kind: 'exact', value: 0 };
    expect(parseSessionInventoryProjection(wrongGroup)).toBeNull();
    const extra = structuredClone(valid);
    extra.groups.push(extra.groups[0]);
    expect(parseSessionInventoryProjection(extra)).toBeNull();
    const crossSession = structuredClone(valid);
    crossSession.groups.find(
      (item: any) => item.id === 'work-items',
    ).items[0].sessionId = 'other-session';
    expect(parseSessionInventoryProjection(crossSession)).toBeNull();
  });
  test('derives a work-item URL only from its valid closed row locator', () => {
    const value = v2Projection();
    const group = value.groups.find((item: any) => item.id === 'work-items');
    const row = {
      kind: 'station-session-work-item',
      key: 'work-item:association-a',
      owner: { owner: 'station.session-work-items', id: 'v1' },
      relations: ['observed-during', 'produced-by'],
      sessionId: 'session-a',
      conversationId: 'conversation-a',
      eventId: 'event-a',
      turnId: 'turn-a',
      toolCallId: 'call-a',
      provider: { id: 'github', host: 'github.com' },
      workItemRef: 'github:kontourai/station#235',
      repository: { owner: 'kontourai', name: 'station' },
      nativeId: '1234567890',
      associationIds: ['association-a'],
      observedAt: '2026-08-28T12:00:00.000Z',
    };
    group.state = 'available';
    group.count = { kind: 'exact', value: 1 };
    group.items = [row];
    expect(deriveSessionWorkItemGithubUrl(row)).toBe(
      'https://github.com/kontourai/station/issues/235',
    );
    expect(
      deriveSessionWorkItemGithubUrl({ ...row, key: 'work-item:attacker' }),
    ).toBeNull();
    expect(
      deriveSessionWorkItemGithubUrl({
        ...row,
        workItemRef: 'github:kontourai/..#235',
      }),
    ).toBeNull();
  });
  test('keeps v1 MCP closed while v2 admits the work-items contract', () => {
    const value = v2Projection();
    expect(buildStationSessionInventoryMcpEnvelope(value)).toBeNull();
    const envelope = buildStationSessionInventoryMcpV2Envelope(value);
    expect(parseStationSessionInventoryMcpV2Envelope(envelope)).toEqual(
      envelope,
    );
    expect(parseStationSessionInventoryMcpEnvelope(envelope)).toBeNull();
    expect(
      parseStationSessionInventoryMcpInput({
        operation: 'page',
        scope: value.scope,
        occurrenceId: 'a'.repeat(24),
        groupId: 'work-items',
        continuationToken: 'b'.repeat(16),
      }),
    ).toBeNull();
    expect(
      parseStationSessionInventoryMcpV2Input({
        version: 'station.session-inventory-mcp/v2',
        operation: 'page',
        scope: value.scope,
        occurrenceId: 'a'.repeat(24),
        groupId: 'work-items',
        continuationToken: 'b'.repeat(16),
      }),
    ).not.toBeNull();
    for (const hostile of [
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error('prototype');
          },
        },
      ),
      Object.defineProperty({}, 'version', {
        get: () => {
          throw new Error('getter');
        },
      }),
    ])
      expect(parseStationSessionInventoryMcpV2Envelope(hostile)).toBeNull();
  });
});

const OBSERVED_AT = '2026-10-20T00:00:00.000Z';
const NON_AVAILABLE_ANSWER_STATES = [
  'unavailable',
  'stale',
  'corrupt',
  'restricted',
  'unsupported-version',
  'not-captured',
  'observed-empty',
] as const;
type AnswerState = 'available' | (typeof NON_AVAILABLE_ANSWER_STATES)[number];

function currentAnswerBasis(
  state: AnswerState,
  answerMessageId = 'message-a',
): any {
  const answerRef = createStationAnswerBinding({
    sessionId: 'session-a',
    turnId: 'turn-a',
    messageId: answerMessageId,
  }).answer;
  const owner = { authority: '@kontourai/thread' as const };
  return composeBasisProjection({
    version: SURFACE_BASIS_VERSION,
    answer:
      state === 'available'
        ? {
            owner,
            state,
            observedAt: OBSERVED_AT,
            value: {
              ref: answerRef,
              fact: 'answer-observed',
              observedAt: OBSERVED_AT,
            },
          }
        : state === 'observed-empty'
          ? { owner, state, observedAt: OBSERVED_AT, value: [] }
          : { owner, state, observedAt: OBSERVED_AT },
    assessment: {
      owner: { authority: '@kontourai/surface' },
      state: 'not-captured',
      observedAt: OBSERVED_AT,
    },
    contributions: [],
  } as any);
}

function lineageRows(): Record<string, any> {
  return {
    input: {
      kind: 'thread-authored-input',
      key: 'input:event-input',
      owner: { owner: 'thread.answer-basis', id: 'v1' },
      relations: ['contributed-to'],
      sessionId: 'session-a',
      eventId: 'event-input',
      turnId: 'turn-a',
      inputKind: 'message',
      attachmentDescriptors: [],
    },
    toolResult: {
      kind: 'thread-tool-result',
      key: 'tool:event-tool',
      owner: { owner: 'station.session', id: 'v1' },
      relations: ['observed-during', 'produced-by'],
      sessionId: 'session-a',
      eventId: 'event-tool',
      turnId: 'turn-a',
      toolCallId: 'call-a',
      name: 'read_file',
      terminalStatus: 'succeeded',
    },
    delegation: {
      kind: 'station-delegation',
      key: 'delegation:event-delegation',
      owner: { owner: 'station.session', id: 'v1' },
      relations: ['observed-during'],
      sessionId: 'session-a',
      eventId: 'event-delegation',
      turnId: 'turn-a',
      toolCallId: 'call-b',
      childSessionId: 'session-child',
    },
    decision: {
      kind: 'station-request-decision',
      key: 'decision:event-decision',
      owner: { owner: 'station.session', id: 'v1' },
      relations: ['observed-during'],
      sessionId: 'session-a',
      eventId: 'event-decision',
      turnId: 'turn-a',
      requestId: 'request-a',
      status: 'accepted',
    },
    output: {
      kind: 'station-session-output',
      key: 'output:event-output',
      owner: { owner: 'station.session-outputs', id: 'v1' },
      relations: ['produced-by'],
      output: {
        ref: { sessionId: 'session-a', eventId: 'event-output' },
        turnId: 'turn-a',
        toolCallId: 'call-c',
        declaredAt: OBSERVED_AT,
        descriptor: {
          kind: 'workspace-file',
          relativePath: 'report.md',
          digest: 'c'.repeat(64),
          length: 12,
        },
      },
    },
    workItem: {
      kind: 'station-session-work-item',
      key: 'work-item:association-a',
      owner: { owner: 'station.session-work-items', id: 'v1' },
      relations: ['observed-during', 'produced-by'],
      sessionId: 'session-a',
      conversationId: 'conversation-a',
      eventId: 'event-work-item',
      turnId: 'turn-a',
      toolCallId: 'call-d',
      provider: { id: 'github', host: 'github.com' },
      workItemRef: 'github:kontourai/station#235',
      repository: { owner: 'kontourai', name: 'station' },
      nativeId: '1234567890',
      associationIds: ['association-a'],
      observedAt: OBSERVED_AT,
    },
    resources: {
      kind: 'station-resource-summary',
      key: 'resources:session-a',
      owner: { owner: 'station.session', id: 'v1' },
      relations: ['observed-during'],
      sessionId: 'session-a',
      inputTokens: 10,
    },
  };
}

const ROW_GROUP: Record<string, string> = {
  input: 'inputs',
  toolResult: 'execution',
  delegation: 'execution',
  decision: 'decisions',
  output: 'outputs',
  workItem: 'work-items',
  resources: 'resources',
};

function withRows(value: any, rows: readonly any[]): any {
  for (const [name, row] of Object.entries(lineageRows())) {
    const selected = rows.filter((item) => item.key === row.key);
    if (!selected.length) continue;
    const group = value.groups.find((item: any) => item.id === ROW_GROUP[name]);
    group.state = 'available';
    group.items = [...group.items, ...selected];
    group.count = { kind: 'exact', value: group.items.length };
  }
  return value;
}

/** A v2 current-answer projection with every non-answer group resolved. */
function currentAnswerV2(state: AnswerState, rows?: readonly any[]): any {
  const value = v2Projection();
  value.scope = {
    kind: 'current-answer',
    sessionId: 'session-a',
    turnId: 'turn-a',
  };
  value.basis = currentAnswerBasis(state);
  value.basisBinding = createStationAnswerBinding({
    sessionId: 'session-a',
    turnId: 'turn-a',
    messageId: 'message-a',
  });
  const sources = value.groups.find((item: any) => item.id === 'sources');
  Object.assign(sources, {
    owner: { owner: '@kontourai/fieldwork', id: 'reviewed-source/v1' },
    state: 'unavailable',
    gaps: [{ kind: 'unavailable' }],
  });
  delete sources.count;
  const all = lineageRows();
  return withRows(
    value,
    rows ?? [
      all.input,
      all.toolResult,
      all.delegation,
      all.decision,
      all.output,
      all.workItem,
    ],
  );
}

function answerContributionRow(): any {
  return structuredClone(currentProjection().groups[1].items[0]);
}

describe('Current-answer inventory with a partial Basis (#3853)', () => {
  test.each(NON_AVAILABLE_ANSWER_STATES)(
    'a %s answer keeps every other resolved group',
    (state) => {
      const value = currentAnswerV2(state);
      const parsed = parseSessionInventoryProjection(structuredClone(value));
      expect(parsed).not.toBeNull();
      expect(parsed?.basis?.answer.state).toBe(state);
      expect(parsed?.groups).toEqual(value.groups);
      for (const id of [
        'inputs',
        'execution',
        'decisions',
        'outputs',
        'work-items',
      ])
        expect(parsed?.groups.find((group) => group.id === id)?.state).toBe(
          'available',
        );
      // The group-page parser follows the same rule.
      expect(
        parseSessionInventoryGroupPage({
          version: value.version,
          scope: value.scope,
          basis: value.basis,
          basisBinding: value.basisBinding,
          group: value.groups.find((group: any) => group.id === 'execution'),
        }),
      ).not.toBeNull();
    },
  );

  test('an available answer must still equal the bound answer exactly', () => {
    expect(
      parseSessionInventoryProjection(currentAnswerV2('available')),
    ).not.toBeNull();
    const otherAnswer = currentAnswerV2('available');
    otherAnswer.basis = currentAnswerBasis('available', 'message-other');
    expect(parseSessionInventoryProjection(otherAnswer)).toBeNull();
    const otherBinding = currentAnswerV2('available');
    otherBinding.basisBinding = createStationAnswerBinding({
      sessionId: 'session-a',
      turnId: 'turn-a',
      messageId: 'message-other',
    });
    expect(parseSessionInventoryProjection(otherBinding)).toBeNull();
    expect(
      parseSessionInventoryGroupPage({
        version: otherAnswer.version,
        scope: otherAnswer.scope,
        basis: otherAnswer.basis,
        basisBinding: otherAnswer.basisBinding,
        group: otherAnswer.groups[0],
      }),
    ).toBeNull();
  });

  test.each(NON_AVAILABLE_ANSWER_STATES)(
    'a %s answer admits no row bound to an answer',
    (state) => {
      const withContribution = (answerState: AnswerState) => {
        const value = currentAnswerV2(answerState);
        value.groups[1] = {
          id: 'sources',
          owner: { owner: '@kontourai/fieldwork', id: 'reviewed-source/v1' },
          state: 'available',
          count: { kind: 'exact', value: 1 },
          items: [answerContributionRow()],
          gaps: [],
        };
        return value;
      };
      // Control: the same row is admissible against an available answer.
      expect(
        parseSessionInventoryProjection(withContribution('available')),
      ).not.toBeNull();
      const value = withContribution(state);
      expect(parseSessionInventoryProjection(value)).toBeNull();
      expect(
        parseSessionInventoryGroupPage({
          version: value.version,
          scope: value.scope,
          basis: value.basis,
          basisBinding: value.basisBinding,
          group: value.groups[1],
        }),
      ).toBeNull();
    },
  );

  test.each(['available', 'unavailable'] as const)(
    'a %s answer bound to a different turn or Session is rejected',
    (state) => {
      const otherTurn = currentAnswerV2(state);
      otherTurn.basisBinding = createStationAnswerBinding({
        sessionId: 'session-a',
        turnId: 'turn-other',
        messageId: 'message-a',
      });
      expect(parseSessionInventoryProjection(otherTurn)).toBeNull();
      const otherSession = currentAnswerV2(state);
      otherSession.basisBinding = createStationAnswerBinding({
        sessionId: 'session-other',
        turnId: 'turn-a',
        messageId: 'message-a',
      });
      expect(parseSessionInventoryProjection(otherSession)).toBeNull();
      const missing = currentAnswerV2(state);
      delete missing.basisBinding;
      expect(parseSessionInventoryProjection(missing)).toBeNull();
    },
  );
});

describe('Current-answer lineage rows', () => {
  const lineageKinds = [
    'toolResult',
    'delegation',
    'decision',
    'output',
    'workItem',
  ] as const;

  test.each(lineageKinds)(
    'a lineage-only %s row of the exact turn parses without contributed-to',
    (name) => {
      const row = lineageRows()[name];
      expect(row.relations).not.toContain('contributed-to');
      const value = currentAnswerV2('available', [row]);
      const parsed = parseSessionInventoryProjection(value);
      expect(parsed).not.toBeNull();
      expect(
        parsed?.groups.find((group) => group.id === ROW_GROUP[name])?.items,
      ).toEqual([row]);
    },
  );

  test.each(lineageKinds)(
    'a lineage-only %s row of another turn is rejected',
    (name) => {
      const row = lineageRows()[name];
      if (name === 'output') row.output.turnId = 'turn-other';
      else row.turnId = 'turn-other';
      expect(
        parseSessionInventoryProjection(currentAnswerV2('available', [row])),
      ).toBeNull();
    },
  );

  test.each(['decision', 'delegation'] as const)(
    'a %s row needs its turn in current-answer but not in whole-session',
    (name) => {
      const unbound = lineageRows()[name];
      delete unbound.turnId;
      expect(
        parseSessionInventoryProjection(
          currentAnswerV2('available', [unbound]),
        ),
      ).toBeNull();
      expect(
        parseSessionInventoryProjection(withRows(v2Projection(), [unbound])),
      ).not.toBeNull();
      expect(
        parseSessionInventoryProjection(
          withRows(v2Projection(), [lineageRows()[name]]),
        ),
      ).not.toBeNull();
      const malformed = lineageRows()[name];
      malformed.turnId = '';
      expect(
        parseSessionInventoryProjection(withRows(v2Projection(), [malformed])),
      ).toBeNull();
    },
  );

  test('a Session resource aggregate is not a turn slice', () => {
    const resources = lineageRows().resources;
    expect(
      parseSessionInventoryProjection(withRows(v2Projection(), [resources])),
    ).not.toBeNull();
    expect(
      parseSessionInventoryProjection(
        currentAnswerV2('available', [resources]),
      ),
    ).toBeNull();
  });

  test('lineage admits only observed-during and produced-by', () => {
    const decision = lineageRows().decision;
    decision.relations = ['observed-during', 'kept-in-task'];
    expect(
      parseSessionInventoryProjection(currentAnswerV2('available', [decision])),
    ).toBeNull();
    const provided = lineageRows().decision;
    provided.relations = ['provided-to'];
    expect(
      parseSessionInventoryProjection(currentAnswerV2('available', [provided])),
    ).toBeNull();
    const none = lineageRows().toolResult;
    none.relations = [];
    expect(
      parseSessionInventoryProjection(currentAnswerV2('available', [none])),
    ).toBeNull();
  });

  test('a contributing output is bound to the exact turn too', () => {
    const output = lineageRows().output;
    output.relations = ['produced-by', 'contributed-to'];
    expect(
      parseSessionInventoryProjection(currentAnswerV2('available', [output])),
    ).not.toBeNull();
    output.output.turnId = 'turn-other';
    expect(
      parseSessionInventoryProjection(currentAnswerV2('available', [output])),
    ).toBeNull();
    expect(
      parseSessionInventoryProjection(withRows(v2Projection(), [output])),
    ).not.toBeNull();
  });

  test('contributed-to stays the per-kind support edge', () => {
    for (const name of ['toolResult', 'delegation', 'decision', 'workItem']) {
      const claimed = lineageRows()[name];
      claimed.relations = [...claimed.relations, 'contributed-to'];
      expect(
        parseSessionInventoryProjection(
          currentAnswerV2('available', [claimed]),
        ),
      ).toBeNull();
    }
    const input = lineageRows().input;
    expect(input.relations).toEqual(['contributed-to']);
    expect(
      parseSessionInventoryProjection(currentAnswerV2('available', [input])),
    ).not.toBeNull();
    input.turnId = 'turn-other';
    expect(
      parseSessionInventoryProjection(currentAnswerV2('available', [input])),
    ).toBeNull();
  });
});
