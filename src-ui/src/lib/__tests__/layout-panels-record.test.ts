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
  expect(parseLayoutPanelsRecord(null)).toBeNull();
  expect(parseLayoutPanelsRecord({ version: 1, layouts: [] })).toBeNull();
  const validated = parseLayoutPanelsRecord({
    version: 1,
    layouts: {
      research: {
        sessions: {
          good: { side: 'sources', sideWidth: 400, lowerOpen: true, at: 5 },
          sparse: {},
          folded: { inbox: 'layout' },
          'bad-side': { side: 42 },
          'bad-width': { sideWidth: -1 },
          'bad-open': { lowerOpen: 'yes' },
          'null-open': { lowerOpen: null },
          'bad-inbox': { inbox: 'yes' },
          'bad-at': { at: 'now' },
          '': { side: 'sources' },
        },
      },
    },
  });
  expect(validated?.layouts.research?.sessions).toEqual({
    good: {
      side: 'sources',
      sideWidth: 400,
      lowerOpen: true,
      lowerHeight: null,
      inbox: null,
      at: 5,
    },
    sparse: CLOSED_LAYOUT_SESSION_PANELS,
    folded: { ...CLOSED_LAYOUT_SESSION_PANELS, inbox: 'layout' },
  });
  const imported = parseLayoutPanelsRecord({
    version: 1,
    layouts: {
      research: {
        sessions: Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [
            `session-${index}`,
            { side: 'sources', at: index === 6 ? 0 : index + 1 },
          ]),
        ),
      },
    },
  });
  expect(Object.keys(imported?.layouts.research?.sessions ?? {})).toHaveLength(
    32,
  );
  expect(imported?.layouts.research?.sessions['session-6']).toBeUndefined();
});

test('bounded retention follows touch time rather than insertion order for sessions and layouts', () => {
  let record = DEFAULT_LAYOUT_PANELS_RECORD;
  for (let index = 0; index < LAYOUT_PANELS_SESSION_BOUND; index++) {
    record = writeLayoutSessionPanels(
      record,
      'research',
      `session-${index}`,
      { lowerOpen: true },
      index === 5 ? 1 : 100 + index,
    );
  }
  record = writeLayoutSessionPanels(
    record,
    'research',
    'session-0',
    { side: 'retouched' },
    1000,
  );
  record = writeLayoutSessionPanels(
    record,
    'research',
    'session-32',
    { side: 'new' },
    1001,
  );
  expect(Object.keys(record.layouts.research!.sessions)).toHaveLength(32);
  expect(readLayoutSessionPanels(record, 'research', 'session-5')).toBe(
    CLOSED_LAYOUT_SESSION_PANELS,
  );
  expect(readLayoutSessionPanels(record, 'research', 'session-0').side).toBe(
    'retouched',
  );
  record = writeLayoutSessionPanels(
    record,
    'research',
    'session-33',
    { lowerOpen: true },
    1002,
  );
  expect(readLayoutSessionPanels(record, 'research', 'session-1')).toBe(
    CLOSED_LAYOUT_SESSION_PANELS,
  );
  expect(readLayoutSessionPanels(record, 'research', 'session-0').side).toBe(
    'retouched',
  );
  let layouts = DEFAULT_LAYOUT_PANELS_RECORD;
  for (let index = 0; index < LAYOUT_PANELS_LAYOUT_BOUND; index++) {
    layouts = writeLayoutSessionPanels(
      layouts,
      `layout-${index}`,
      'session',
      { side: 'notes' },
      index === 7 ? 1 : 100 + index,
    );
  }
  layouts = writeLayoutSessionPanels(
    layouts,
    'layout-0',
    'session',
    { side: 'retouched' },
    1000,
  );
  layouts = writeLayoutSessionPanels(
    layouts,
    'layout-32',
    'session',
    { side: 'new' },
    1001,
  );
  expect(Object.keys(layouts.layouts)).toHaveLength(32);
  expect(Object.hasOwn(layouts.layouts, 'layout-7')).toBe(false);
  expect(readLayoutSessionPanels(layouts, 'layout-0', 'session').side).toBe(
    'retouched',
  );
});
