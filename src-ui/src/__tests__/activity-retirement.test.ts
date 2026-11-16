import { describe, expect, test } from 'vitest';
import { APP_DESTINATION_REGISTRY } from '../app-shell/destination-registry';
import { getLegacyPathRedirect } from '../app-shell/routing';
import {
  parseRegionArrangementRecord,
  toRegionArrangementRecord,
} from '../regions/region-arrangement-record';
import {
  DEFAULT_DEVICE_REGION_ARRANGEMENT,
  REGION_SURFACE_REGISTRY,
} from '../regions/region-model';
import { childTranscriptMessages } from '../workspace-panes/agents/childTranscriptMessages';

describe('Activity retirement', () => {
  test.each([
    '/activity',
    '/sessions',
    '/activity/',
    '/sessions/',
    '/?surface=activity',
  ])('stored URL %s opens the exact session in Chat', (path) => {
    expect(
      getLegacyPathRedirect(
        `${path}${path.includes('?') ? '&' : '?'}session=child%2Fone`,
      ),
    ).toBe('/?surface=chat&session=child%2Fone');
  });
  test('sessionless legacy links land on the inbox and Activity is absent from the surface registry', () => {
    expect(getLegacyPathRedirect('/activity')).toBe('/notifications');
    expect(getLegacyPathRedirect('/?surface=activity')).toBe('/notifications');
    expect(REGION_SURFACE_REGISTRY.has('activity')).toBe(false);
    expect(
      APP_DESTINATION_REGISTRY.getRegistered().some(
        (destination) => destination.id === 'activity',
      ),
    ).toBe(false);
  });
  test('migration retains the existing Chat instead of moving it to the old Activity region', () => {
    const record = toRegionArrangementRecord(DEFAULT_DEVICE_REGION_ARRANGEMENT);
    record.regions.bottom = {
      ...record.regions.bottom,
      visible: true,
      occupant: { kind: 'surface', id: 'chat' },
    };
    record.regions.right = {
      ...record.regions.right,
      visible: true,
      occupant: { kind: 'surface', id: 'activity' },
    };
    const result = parseRegionArrangementRecord(record)!;
    expect(result.bottom.occupant).toBe('chat');
    expect(result.right.visible).toBe(false);
    expect(result.right.panes).toEqual([]);
    expect(
      parseRegionArrangementRecord(toRegionArrangementRecord(result)),
    ).toEqual(result);
  });
  test('a primary Activity pane becomes Home, and a mixed dock retains its other panes', () => {
    const record = toRegionArrangementRecord(DEFAULT_DEVICE_REGION_ARRANGEMENT);
    record.regions.main.occupant = { kind: 'surface', id: 'activity' };
    record.regions.right.occupant = {
      kind: 'pane-host',
      panes: [
        { kind: 'surface', id: 'activity' },
        { kind: 'surface', id: 'workspace-agents' },
      ],
      selected: 'activity',
    };
    const result = parseRegionArrangementRecord(record)!;
    expect(result.main.occupant).toBe('home');
    expect(result.right.occupant).toBe('workspace-agents');
    expect(result.right.panes).toEqual(['workspace-agents']);
  });
  test('the child adapter preserves text roles, tool order and omissions without inventing call/result joins', () => {
    const result = childTranscriptMessages([
      { kind: 'text', message: 0, role: 'user', text: 'Inspect' },
      {
        kind: 'tool-call',
        message: 1,
        name: 'Read',
        input: 'file.ts',
        truncated: true,
      },
      { kind: 'tool-result', message: 2, text: 'missing', isError: true },
      { kind: 'omitted', message: 2, count: 3 },
      {
        kind: 'text',
        message: 3,
        role: 'assistant',
        text: 'Done',
        truncated: true,
      },
    ]);
    expect(result[0]).toMatchObject({ role: 'user', content: 'Inspect' });
    expect(result[1]?.contentParts?.[0]).toMatchObject({
      type: 'tool-invocation',
      toolName: 'Read',
      input: 'file.ts',
    });
    expect(result[1]?.contentParts?.at(-1)?.content).toContain(
      'Tool input truncated',
    );
    expect(result[2]?.content).toContain('Tool error');
    expect(result[3]?.content).toContain('3 blocks');
    expect(result[4]?.content).toContain('truncated');
  });
});

test('duplicate retired panes close their emptied dock after migration', () => {
  const record = toRegionArrangementRecord(DEFAULT_DEVICE_REGION_ARRANGEMENT);
  record.regions.bottom.occupant = null;
  for (const id of ['left', 'right'] as const)
    record.regions[id] = {
      ...record.regions[id],
      visible: true,
      occupant: { kind: 'surface', id: 'activity' },
    };
  const migrated = parseRegionArrangementRecord(record)!;
  expect(migrated.left.occupant).toBe('chat');
  expect(migrated.right.occupant).toBeNull();
  expect(migrated.right.visible).toBe(false);
});

test('engine calls join their own results across page boundaries without extra assistant bubbles', () => {
  const messages = childTranscriptMessages([
    {
      message: 0,
      kind: 'tool-call',
      toolCallId: 'a',
      name: 'Read',
      input: '{"file_path":"one.ts"}',
    },
    {
      message: 0,
      kind: 'tool-call',
      toolCallId: 'b',
      name: 'Read',
      input: 'two.ts',
    },
    {
      message: 1,
      kind: 'tool-result',
      toolCallId: 'b',
      text: 'no access',
      isError: true,
    },
    {
      message: 2,
      kind: 'tool-result',
      toolCallId: 'a',
      text: 'export const ok = true;',
    },
  ]);
  expect(messages).toHaveLength(2);
  expect(messages[0].contentParts?.[0]).toMatchObject({
    toolCallId: 'a',
    input: { file_path: 'one.ts' },
    state: 'output-available',
    output: 'export const ok = true;',
  });
  expect(messages[1].contentParts?.[0]).toMatchObject({
    toolCallId: 'b',
    state: 'output-error',
    errorText: 'no access',
  });
});

test.each([undefined, ''])(
  'missing tool text (%s) stays unknown for joined and unkeyed results',
  (text) => {
    const messages = childTranscriptMessages([
      { message: 0, kind: 'tool-call', toolCallId: 'a', name: 'Read' },
      { message: 1, kind: 'tool-result', toolCallId: 'a', text },
      { message: 2, kind: 'tool-result', text },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0].contentParts?.[0]).toMatchObject({
      state: 'output-available',
      output: 'Text output unavailable.',
    });
    expect(messages[1].content).toBe('Tool result\n\nText output unavailable.');
  },
);
