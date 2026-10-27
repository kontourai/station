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
  type ProjectTaskRoomAppendBody,
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
  test.each(['principalId', 'deviceId'] as const)(
    'requires a bounded, exact member %s without controls',
    (field) => {
      for (const value of ['person:Alex', '成员-1', 'x'.repeat(256)]) {
        const input = { ...member, [field]: value };
        expect(parseProjectTaskRoomPrincipal(input)).toEqual(input);
      }
      for (const value of [
        '',
        'x'.repeat(257),
        ' person-1',
        'person-1 ',
        '\u00a0person-1',
        'person-1\u00a0',
        'a\u0000b',
        'a\u001fb',
        'a\u007fb',
        'a\u0085b',
        '\ud800',
      ]) {
        expect(
          parseProjectTaskRoomPrincipal({ ...member, [field]: value }),
        ).toBeNull();
      }
    },
  );
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
        (_, index) => ({ ...mention, principalId: `person-${index}` }),
      ),
    };
    expect(parseProjectTaskRoomHumanMessage(full)).toEqual(full);
    for (const mentions of [
      [...full.mentions, { ...mention, principalId: 'overflow-person' }],
      [{ ...mention, principalId: '' }],
      [{ kind: 'agent', principalId: 'agent-1' }],
      [{ ...mention, extra: true }],
      null,
      new Array(1),
      [{ ...mention, principalId: 'x'.repeat(257) }],
      [mention, { ...mention }],
      [mention, { ...mention, principalId: 'person-3' }, { ...mention }],
      [{ ...mention, principalId: ' person-2' }],
      [{ ...mention, principalId: 'person-2 ' }],
      [{ ...mention, principalId: 'person-\u007f2' }],
    ]) {
      expect(
        parseProjectTaskRoomHumanMessage({ ...message, mentions }),
      ).toBeNull();
    }
  });
  test.each([
    'src/main.ts',
    'README.md',
    '.station/config.json',
    'src/my file.ts',
    '文档/说明.md',
    './src/main.ts',
  ])('accepts relative POSIX presence file %j', (file) => {
    expect(parseProjectTaskRoomPresenceLocation({ file })).toEqual({ file });
  });
  test.each([
    '/etc/passwd',
    '//server/share',
    'C:\\x',
    'C:/x',
    'C:x',
    'src\\main.ts',
    '~',
    '~/.ssh/id_rsa',
    '~user/file',
    'file:///x',
    'https://example.com/x',
    'mailto:user@example.com',
    '..',
    '../src/main.ts',
    'src/../main.ts',
    'src/..',
    'src//main.ts',
    'src/',
    '',
    ' src/main.ts',
    'src/main.ts ',
    'src/\ud800.ts',
    'src/\udfff.ts',
    ...Array.from(
      { length: 32 },
      (_, index) => `src/a${String.fromCharCode(index)}b.ts`,
    ),
    ...Array.from(
      { length: 33 },
      (_, index) => `src/a${String.fromCharCode(127 + index)}b.ts`,
    ),
  ])('refuses unsafe presence file %j', (file) => {
    expect(parseProjectTaskRoomPresenceLocation({ file })).toBeNull();
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
        { ...message, mentions: [mention] },
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
  test('empty mentions do not advance any legacy write fence', () => {
    for (const version of [
      'station.project-task-room/v2',
      'station.project-task-room/v3',
      'station.project-task-room/v4',
    ] as const) {
      expect(
        projectTaskRoomWriteSchemaVersion(version, operator, {
          ...message,
          mentions: [],
        }),
      ).toBe(version);
    }
    expect(
      projectTaskRoomWriteSchemaVersion(
        'station.project-task-room/v2',
        operator,
        {
          ...message,
          attachments: [attachment],
          mentions: [],
        },
      ),
    ).toBe('station.project-task-room/v4');
  });
  test('selects the write version directly from append lifecycle bodies', () => {
    const bodies: ProjectTaskRoomAppendBody[] = [
      {
        kind: 'live-work-started',
        sessionId: 'session-1',
        runReference: 'run-1',
      },
      {
        kind: 'live-work-presence-ended',
        sessionId: 'session-1',
        reason: 'departed',
        runReference: 'run-1',
      },
      {
        kind: 'live-work-finished',
        sessionId: 'session-1',
        outcome: 'completed',
        revisionReference: 'revision-1',
      },
      { kind: 'outcome-link', linkKind: 'run', reference: 'run-1' },
    ];
    for (const body of bodies) {
      expect(
        projectTaskRoomWriteSchemaVersion(
          'station.project-task-room/v2',
          operator,
          body,
        ),
      ).toBe('station.project-task-room/v2');
      expect(
        projectTaskRoomWriteSchemaVersion(
          'station.project-task-room/v4',
          member,
          body,
        ),
      ).toBe('station.project-task-room/v5');
    }
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
      (_, index) => ({ ...mention, principalId: `person-${index}` }),
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
