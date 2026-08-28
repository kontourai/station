import {
  parseSessionWorkItemAssociation,
  type SessionWorkItemAssociation,
} from '@kontourai/station-contracts/session-work-item';
import { describe, expect, test } from 'vitest';
import {
  deriveGithubIssueHttpsLink,
  mintWorkItemResultProjectorProvenanceForReviewedLoader,
  projectSessionWorkItemRead,
  SESSION_WORK_ITEM_READ_MAX_OBSERVATIONS,
  WorkItemResultProjector,
  type WorkItemResultProjectorInput,
} from '../work-item-result-projector.js';

const provenance = mintWorkItemResultProjectorProvenanceForReviewedLoader();

function minimalContent(overrides: Record<string, unknown> = {}): unknown {
  return [
    {
      type: 'text',
      text: JSON.stringify({
        id: '1234567890',
        url: 'https://github.com/kontourai/station/issues/235',
        ...overrides,
      }),
    },
  ];
}

function input(
  content = minimalContent(),
  overrides: Partial<WorkItemResultProjectorInput> = {},
): WorkItemResultProjectorInput {
  return {
    associationId: 'association-1',
    sessionId: 'session-1',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    toolCallId: 'call-1',
    terminalStatus: 'success',
    provenance,
    githubArguments: {
      owner: 'kontourai',
      repo: 'station',
      title: 'Capture issue work',
    },
    content,
    ...overrides,
  };
}

function durable(
  candidate: NonNullable<ReturnType<WorkItemResultProjector['project']>>,
  eventId = 'event-1',
): SessionWorkItemAssociation {
  const association = parseSessionWorkItemAssociation({
    ...candidate,
    eventId,
    observedAt: '2026-08-28T12:00:00.000Z',
  });
  if (!association) throw new Error('expected durable association');
  return association;
}

describe('WorkItemResultProjector', () => {
  test('projects the official MinimalResponse text block using trusted arguments', () => {
    const projected = new WorkItemResultProjector().project(input());
    expect(projected).toMatchObject({
      version: 'station.session-work-item/v1',
      workItemRef: 'github:kontourai/station#235',
      nativeId: '1234567890',
    });
    expect(projected).not.toHaveProperty('eventId');
    expect(projected).not.toHaveProperty('observedAt');
    expect(projected).not.toHaveProperty('url');
    expect(projected).not.toHaveProperty('title');
  });

  test.each([
    ['failed call', input(minimalContent(), { terminalStatus: 'error' })],
    [
      'invented REST object',
      input({ number: 235, node_id: 'I', html_url: 'x' }),
    ],
    [
      'two content blocks',
      input([
        ...((minimalContent() as unknown[]) || []),
        { type: 'text', text: '{}' },
      ]),
    ],
    ['non-text block', input([{ type: 'image', text: '{}' }])],
    ['extra result field', input(minimalContent({ body: 'issue body' }))],
    ['non-decimal official id', input(minimalContent({ id: 'I_kwDOExample' }))],
    ['zero official id', input(minimalContent({ id: '0' }))],
    [
      'foreign URL',
      input(
        minimalContent({
          url: 'https://github.example/kontourai/station/issues/235',
        }),
      ),
    ],
    [
      'mismatched trusted repo',
      input(minimalContent(), {
        githubArguments: { owner: 'kontourai', repo: 'other', title: 'x' },
      }),
    ],
    [
      'normalized URL',
      input(
        minimalContent({
          url: 'https://github.com/kontourai/station/issues/235/../235',
        }),
      ),
    ],
    [
      'dot repo',
      input(minimalContent(), {
        githubArguments: { owner: 'kontourai', repo: '.', title: 'x' },
      }),
    ],
  ])('rejects %s', (_label, rejected) => {
    expect(new WorkItemResultProjector().project(rejected)).toBeNull();
  });

  test('does not treat spoofed server/tool strings as result-projection authority', () => {
    const spoofed = input(undefined, {
      provenance: {
        serverId: 'github',
        originalToolName: 'create_issue',
      } as unknown as WorkItemResultProjectorInput['provenance'],
    });
    expect(new WorkItemResultProjector().project(spoofed)).toBeNull();
  });

  test('freezes loader-issued provenance against retargeting', () => {
    expect(Object.isFrozen(provenance)).toBe(true);
    expect(() => {
      (provenance as unknown as { serverId: string }).serverId = 'other';
    }).toThrow();
    expect(new WorkItemResultProjector().project(input())).not.toBeNull();
  });

  test('normalizes GitHub identity casing before durable association and links', () => {
    const projector = new WorkItemResultProjector();
    const mixed = projector.project(
      input(
        minimalContent({
          url: 'https://github.com/KontourAI/Station/issues/235',
        }),
        {
          associationId: 'association-mixed',
          toolCallId: 'call-mixed',
          githubArguments: {
            owner: 'KontourAI',
            repo: 'Station',
            title: 'Capture issue work',
          },
        },
      ),
    );
    if (!mixed) throw new Error('expected mixed-case association');
    expect(mixed.repository).toEqual({ owner: 'kontourai', name: 'station' });
    expect(mixed.workItemRef).toBe('github:kontourai/station#235');
    expect(deriveGithubIssueHttpsLink(durable(mixed, 'event-mixed'))).toBe(
      'https://github.com/kontourai/station/issues/235',
    );
    const lowercase = projector.project(input());
    if (!lowercase) throw new Error('expected lowercase association');
    const read = projectSessionWorkItemRead(
      { sessionId: 'session-1', conversationId: 'conversation-1' },
      [durable(lowercase), durable(mixed, 'event-mixed')],
    );
    expect(read.kind).toBe('available');
    if (read.kind === 'available')
      expect(read.projection.items).toHaveLength(1);
  });

  test('projects one scoped Session/conversation and fails closed on conflicts', () => {
    const projector = new WorkItemResultProjector();
    const first = projector.project(input());
    const duplicate = projector.project(
      input(minimalContent(), {
        associationId: 'association-2',
        toolCallId: 'call-2',
      }),
    );
    if (!first || !duplicate) throw new Error('expected associations');
    const available = projectSessionWorkItemRead(
      { sessionId: 'session-1', conversationId: 'conversation-1' },
      [durable(first), durable(duplicate, 'event-2')],
    );
    expect(available.kind).toBe('available');
    if (available.kind === 'available') {
      expect(available.projection.observations).toHaveLength(2);
      expect(available.projection.items).toEqual([
        expect.objectContaining({
          conversationId: 'conversation-1',
          associationIds: ['association-1', 'association-2'],
        }),
      ]);
    }
    expect(
      projectSessionWorkItemRead(
        { sessionId: 'session-1', conversationId: 'conversation-1' },
        [{ ...durable(first), nativeId: '9876543210' }],
      ),
    ).toEqual({ kind: 'available', projection: expect.any(Object) });
    expect(
      projectSessionWorkItemRead(
        { sessionId: 'session-1', conversationId: 'conversation-1' },
        [
          durable(first),
          { ...durable(duplicate, 'event-2'), nativeId: '9876543210' },
        ],
      ),
    ).toEqual({ kind: 'corrupt', code: 'identity-conflict' });
    expect(
      projectSessionWorkItemRead(
        { sessionId: 'session-1', conversationId: 'conversation-1' },
        [
          durable(first),
          {
            ...durable(duplicate, 'event-2'),
            associationId: first.associationId,
          },
        ],
      ),
    ).toEqual({ kind: 'corrupt', code: 'association-conflict' });
    expect(
      projectSessionWorkItemRead(
        { sessionId: 'session-1', conversationId: 'conversation-1' },
        [
          durable(first),
          {
            ...durable(duplicate, 'event-2'),
            associationId: 'association-source-conflict',
            eventId: 'event-1',
            toolCallId: first.toolCallId,
          },
        ],
      ),
    ).toEqual({ kind: 'corrupt', code: 'association-conflict' });
    expect(
      projectSessionWorkItemRead(
        { sessionId: 'session-1', conversationId: 'conversation-1' },
        [
          durable(first),
          {
            ...durable(duplicate, 'event-2'),
            associationId: 'association-3',
            eventId: 'event-3',
            toolCallId: 'call-3',
            workItemRef: 'github:kontourai/other#235',
            repository: { owner: 'kontourai', name: 'other' },
          },
        ],
      ),
    ).toEqual({ kind: 'corrupt', code: 'identity-conflict' });
  });

  test('rejects out-of-scope and over-bound reads instead of truncating', () => {
    const observation = new WorkItemResultProjector().project(input());
    if (!observation) throw new Error('expected association');
    expect(
      projectSessionWorkItemRead(
        { sessionId: 'session-1', conversationId: 'conversation-1' },
        [{ ...durable(observation), conversationId: 'conversation-2' }],
      ),
    ).toEqual({ kind: 'corrupt', code: 'scope-mismatch' });
    expect(
      projectSessionWorkItemRead(
        { sessionId: 'session-1', conversationId: 'conversation-1' },
        Array.from(
          { length: SESSION_WORK_ITEM_READ_MAX_OBSERVATIONS + 1 },
          () => durable(observation),
        ),
      ),
    ).toEqual({ kind: 'corrupt', code: 'bound-exceeded' });
  });
});
