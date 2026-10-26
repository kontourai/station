import { describe, expect, test } from 'vitest';
import { CHAT_ATTACHMENT_MAX_COUNT } from '../chat-attachment.js';
import {
  PROJECT_TASK_ROOM_LOCATION_FILE_MAX_CHARS,
  PROJECT_TASK_ROOM_MAX_MENTIONS,
  PROJECT_TASK_ROOM_MAX_PAGE_JSON_ITEMS,
  PROJECT_TASK_ROOM_MAX_RECORD_JSON_ITEMS,
  PROJECT_TASK_ROOM_SCHEMA_VERSION,
  parseProjectTaskRoomHumanMessage,
  parseProjectTaskRoomPresenceLocation,
  parseProjectTaskRoomPrincipal,
  projectTaskRoomWriteSchemaVersion,
} from '../project-task-room.js';

const member = {
  kind: 'member' as const,
  principalId: 'person-1',
  deviceId: 'device-1',
};
const operator = {
  kind: 'operator' as const,
  operatorId: 'person-1',
  deviceId: 'device-1',
};
const message = { kind: 'human-message' as const, text: 'Please review' };
const attachment = {
  id: '12345678-1234-4123-8123-123456789012',
  kind: 'file' as const,
  name: 'notes.txt',
  mimeType: 'text/plain' as const,
  size: 1,
};
const mention = { kind: 'person' as const, principalId: 'person-2' };

describe('v5 room contract boundaries', () => {
  test('parses a v5 member while legacy versions refuse the new principal', () => {
    expect(PROJECT_TASK_ROOM_SCHEMA_VERSION).toBe(
      'station.project-task-room/v5',
    );
    expect(parseProjectTaskRoomPrincipal(member)).toEqual(member);
    for (const version of [
      'station.project-task-room/v2',
      'station.project-task-room/v3',
      'station.project-task-room/v4',
    ] as const) {
      expect(parseProjectTaskRoomPrincipal(member, version)).toBeNull();
      expect(parseProjectTaskRoomPrincipal(operator, version)).toEqual(
        operator,
      );
    }
  });
  test('refuses an incomplete member principal', () => {
    expect(
      parseProjectTaskRoomPrincipal({ kind: 'member', deviceId: 'device-1' }),
    ).toBeNull();
    expect(
      parseProjectTaskRoomPrincipal({
        kind: 'member',
        principalId: 'person-1',
      }),
    ).toBeNull();
    expect(
      parseProjectTaskRoomPrincipal({ ...member, principalId: '' }),
    ).toBeNull();
    expect(
      parseProjectTaskRoomPrincipal({ ...member, extra: true }),
    ).toBeNull();
  });
  test('preserves v4 attachment parsing and refuses mentions on legacy messages', () => {
    const attached = { ...message, attachments: [attachment] };
    expect(
      parseProjectTaskRoomHumanMessage(
        attached,
        'station.project-task-room/v4',
      ),
    ).toEqual(attached);
    expect(
      parseProjectTaskRoomHumanMessage(
        attached,
        'station.project-task-room/v3',
      ),
    ).toBeNull();
    expect(
      parseProjectTaskRoomHumanMessage(
        { ...message, mentions: [] },
        'station.project-task-room/v4',
      ),
    ).toBeNull();
    expect(
      parseProjectTaskRoomHumanMessage(message, 'station.project-task-room/v4'),
    ).toEqual(message);
  });
  test('mentions accept the maximum and refuse max+1, malformed identities and extra keys', () => {
    const full = {
      ...message,
      mentions: Array.from(
        { length: PROJECT_TASK_ROOM_MAX_MENTIONS },
        () => mention,
      ),
    };
    expect(parseProjectTaskRoomHumanMessage(full)).toEqual(full);
    for (const mentions of [
      [...full.mentions, mention],
      [{ ...mention, principalId: '' }],
      [{ kind: 'agent', principalId: 'agent-1' }],
      [{ ...mention, extra: true }],
      null,
      new Array(1),
      [{ ...mention, principalId: 'x'.repeat(257) }],
    ]) {
      expect(
        parseProjectTaskRoomHumanMessage({ ...message, mentions }),
      ).toBeNull();
    }
  });
  test.each(['conversation', 'review', 'plan', { file: 'src/main.ts' }])(
    'parses presence location %j',
    (location) => {
      expect(parseProjectTaskRoomPresenceLocation(location)).toEqual(location);
    },
  );
  test('bounds file locations and refuses extra location fields', () => {
    const file = 'x'.repeat(PROJECT_TASK_ROOM_LOCATION_FILE_MAX_CHARS);
    expect(parseProjectTaskRoomPresenceLocation({ file })).toEqual({ file });
    for (const location of [
      { file: `${file}x` },
      { file: '' },
      { file: 'a', line: 1 },
      'elsewhere',
      null,
    ]) {
      expect(parseProjectTaskRoomPresenceLocation(location)).toBeNull();
    }
  });
  test('format selection advances on v5 content and never downgrades a fenced room', () => {
    expect(
      projectTaskRoomWriteSchemaVersion(
        'station.project-task-room/v4',
        member,
        message,
      ),
    ).toBe('station.project-task-room/v5');
    expect(
      projectTaskRoomWriteSchemaVersion(
        'station.project-task-room/v2',
        operator,
        { ...message, mentions: [] },
      ),
    ).toBe('station.project-task-room/v5');
    expect(
      projectTaskRoomWriteSchemaVersion(
        'station.project-task-room/v5',
        operator,
        message,
      ),
    ).toBe('station.project-task-room/v5');
    expect(
      projectTaskRoomWriteSchemaVersion(
        'station.project-task-room/v4',
        operator,
        message,
      ),
    ).toBe('station.project-task-room/v4');
    expect(
      projectTaskRoomWriteSchemaVersion(
        'station.project-task-room/v2',
        operator,
        { ...message, attachments: [attachment] },
      ),
    ).toBe('station.project-task-room/v4');
    expect(
      projectTaskRoomWriteSchemaVersion(
        'station.project-task-room/v2',
        operator,
        message,
      ),
    ).toBe('station.project-task-room/v2');
  });
});

/** Count JSON values, including containers, independently of the budget derivation. */
function items(value: unknown): number {
  return (
    1 +
    (value && typeof value === 'object'
      ? Object.values(value).reduce<number>(
          (sum, child) => sum + items(child),
          0,
        )
      : 0)
  );
}

test('the closed record and page item budgets cover the fully populated v5 wire shape exactly', () => {
  const scope = {
    projectId: 'project-1',
    projectSlug: 'project',
    taskId: 'task-1',
  };
  const principal = {
    kind: 'agent',
    agentId: 'agent-1',
    ownerOperatorId: 'person-1',
    deviceId: 'device-1',
    authorizationReceiptId: 'auth-1',
  };
  const body = {
    ...message,
    attachments: Array.from(
      { length: CHAT_ATTACHMENT_MAX_COUNT },
      () => attachment,
    ),
    mentions: Array.from(
      { length: PROJECT_TASK_ROOM_MAX_MENTIONS },
      () => mention,
    ),
  };
  const record = {
    schemaVersion: 'station.project-task-room/v5',
    scope,
    principal,
    correlationId: 'correlation-1',
    causationId: 'cause-1',
    envelope: {
      schemaVersion: 'station.channel-sequence/v1',
      channelId: 'channel-1',
      epoch: 0,
      seq: 1,
      proposal: {
        schemaVersion: 'station.channel-proposal/v1',
        proposalId: 'proposal-1',
        channelId: 'channel-1',
        author: {
          memberId: 'person-1',
          deviceId: 'device-1',
          keyId: 'agent-1',
        },
        onBehalfOf: { ownerMemberId: 'person-1', authorizationId: 'auth-1' },
        kind: 'agent-action',
        baseEpoch: 0,
        happenedAt: '2026-10-26T00:00:00.000Z',
        body: {
          schemaVersion: 'station.project-task-room-proposal/v1',
          scope,
          principal,
          body,
          correlationId: 'correlation-1',
          causationId: 'cause-1',
          grantReceipt: {
            receiptId: 'receipt-1',
            capability: 'agent-publish',
            scope,
            principal,
            policyRevision: 'policy-1',
          },
        },
      },
      proposalDigest: 'a'.repeat(64),
      committedAt: '2026-10-26T00:00:00.000Z',
      prevEnvelopeDigest: 'b'.repeat(64),
      policyRevision: 'policy-1',
      leaseRef: 'lease-1',
    },
    body,
    bodyBytes: 1,
    checkpointDigest: 'c'.repeat(64),
  };
  expect(parseProjectTaskRoomHumanMessage(body)).toEqual(body);
  expect(PROJECT_TASK_ROOM_MAX_RECORD_JSON_ITEMS).toBe(items(record));
  const page = {
    kind: 'available',
    records: Array.from({ length: 100 }, () => record),
    checkpoint: {
      channelId: 'channel-1',
      epoch: 0,
      throughSeq: 100,
      checkpointDigest: 'c'.repeat(64),
      retainedAnchorSeq: 0,
      retainedAnchorDigest: 'b'.repeat(64),
    },
    hasMore: true,
    nextCursor: {
      schemaVersion: 'station.project-task-room-cursor/v1',
      channelId: 'channel-1',
      epoch: 0,
      throughSeq: 100,
      checkpointDigest: 'c'.repeat(64),
      retainedAnchorSeq: 0,
      retainedAnchorDigest: 'b'.repeat(64),
      afterSeq: 1,
      afterEnvelopeDigest: 'a'.repeat(64),
      afterCheckpointDigest: 'c'.repeat(64),
    },
    integrity: 'L0',
  };
  expect(PROJECT_TASK_ROOM_MAX_PAGE_JSON_ITEMS).toBe(items(page));
});
