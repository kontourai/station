import {
  composeBasisProjection,
  SURFACE_BASIS_VERSION,
} from '@kontourai/surface/basis';
import { describe, expect, test } from 'vitest';
import {
  deriveSessionWorkItemGithubUrl,
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
