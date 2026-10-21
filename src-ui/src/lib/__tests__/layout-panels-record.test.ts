import {
  DEFAULT_LAYOUT_PANELS_RECORD,
  LAYOUT_PANELS_LAYOUT_BOUND,
  LAYOUT_PANELS_SESSION_BOUND,
} from '@kontourai/station-contracts/device-settings';
import { expect, test } from 'vitest';
import {
  CLOSED_LAYOUT_SESSION_PANELS,
  parseLayoutPanelsRecord,
  readLayoutSessionPanels,
  writeLayoutSessionPanels,
} from '../layout-panels-record';

test('a conversation keeps independent panel choices in each Project/layout', () => {
  const first = writeLayoutSessionPanels(
    DEFAULT_LAYOUT_PANELS_RECORD,
    'project-a/research',
    'conversation',
    { side: 'sources', sideWidth: 480, lowerOpen: true },
    10,
  );
  const both = writeLayoutSessionPanels(
    first,
    'project-b/sales',
    'conversation',
    { side: 'pipeline', lowerHeight: 240 },
    20,
  );
  expect(
    readLayoutSessionPanels(both, 'project-a/research', 'conversation'),
  ).toEqual({
    side: 'sources',
    sideWidth: 480,
    lowerOpen: true,
    lowerHeight: null,
    inbox: null,
    at: 10,
  });
  expect(
    readLayoutSessionPanels(both, 'project-b/sales', 'conversation'),
  ).toEqual({
    side: 'pipeline',
    sideWidth: null,
    lowerOpen: false,
    lowerHeight: 240,
    inbox: null,
    at: 20,
  });
  expect(readLayoutSessionPanels(both, 'project-a/sales', 'conversation')).toBe(
    CLOSED_LAYOUT_SESSION_PANELS,
  );
  expect(
    writeLayoutSessionPanels(
      both,
      'project-b/sales',
      'conversation',
      { side: 'pipeline' },
      30,
    ),
  ).toBe(both);
});

test('the parser drops malformed sessions and prototype names remain ordinary identities', () => {
  const parsed = parseLayoutPanelsRecord(
    JSON.parse(
      '{"version":1,"layouts":{"__proto__":{"sessions":{"constructor":{"side":"notes","lowerOpen":true},"bad":{"sideWidth":-1}}}}}',
    ),
  );
  expect(parsed).not.toBeNull();
  expect(
    readLayoutSessionPanels(parsed!, '__proto__', 'constructor').side,
  ).toBe('notes');
  expect(readLayoutSessionPanels(parsed!, '__proto__', 'bad')).toBe(
    CLOSED_LAYOUT_SESSION_PANELS,
  );
  expect(readLayoutSessionPanels(parsed!, 'constructor', 'toString')).toBe(
    CLOSED_LAYOUT_SESSION_PANELS,
  );
  expect(parseLayoutPanelsRecord({ version: 7, layouts: {} })).toBeNull();
});

test('bounded retention evicts the least recently touched session and layout', () => {
  let record = DEFAULT_LAYOUT_PANELS_RECORD;
  for (let index = 0; index <= LAYOUT_PANELS_SESSION_BOUND; index++) {
    record = writeLayoutSessionPanels(
      record,
      'research',
      `session-${index}`,
      { lowerOpen: true },
      index + 1,
    );
  }
  expect(Object.keys(record.layouts.research!.sessions)).toHaveLength(32);
  expect(readLayoutSessionPanels(record, 'research', 'session-0')).toBe(
    CLOSED_LAYOUT_SESSION_PANELS,
  );
  expect(
    readLayoutSessionPanels(record, 'research', 'session-32').lowerOpen,
  ).toBe(true);
  for (let index = 0; index < LAYOUT_PANELS_LAYOUT_BOUND; index++) {
    record = writeLayoutSessionPanels(
      record,
      `layout-${index}`,
      'session',
      { side: 'notes' },
      100 + index,
    );
  }
  expect(Object.keys(record.layouts)).toHaveLength(32);
  expect(Object.hasOwn(record.layouts, 'research')).toBe(false);
  expect(readLayoutSessionPanels(record, 'layout-31', 'session').side).toBe(
    'notes',
  );
});
