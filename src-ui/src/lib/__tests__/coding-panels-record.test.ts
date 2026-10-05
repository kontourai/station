import {
  CODING_PANELS_SESSION_BOUND,
  DEFAULT_CODING_PANELS_RECORD,
} from '@kontourai/station-contracts/device-settings';
import { describe, expect, test } from 'vitest';
import {
  CLOSED_CODING_SESSION_PANELS,
  parseCodingSessionPanelsRecord,
  readCodingSessionPanels,
  writeCodingSessionPanels,
} from '../coding-panels-record';

describe('coding-panels-record (#3051)', () => {
  test('a session the record does not know starts closed', () => {
    expect(
      readCodingSessionPanels(DEFAULT_CODING_PANELS_RECORD, 'conv-new'),
    ).toEqual(CLOSED_CODING_SESSION_PANELS);
    expect(CLOSED_CODING_SESSION_PANELS).toMatchObject({
      side: null,
      terminalOpen: false,
      sideWidth: null,
      terminalHeight: null,
    });
  });

  test('a write patches one session and leaves the others alone', () => {
    const a = writeCodingSessionPanels(
      DEFAULT_CODING_PANELS_RECORD,
      'conv-a',
      { side: 'diff', sideWidth: 500 },
      10,
    );
    const ab = writeCodingSessionPanels(
      a,
      'conv-b',
      { terminalOpen: true, terminalHeight: 300 },
      20,
    );
    expect(readCodingSessionPanels(ab, 'conv-a')).toEqual({
      side: 'diff',
      sideWidth: 500,
      terminalOpen: false,
      terminalHeight: null,
      inbox: null,
      at: 10,
    });
    expect(readCodingSessionPanels(ab, 'conv-b')).toEqual({
      side: null,
      sideWidth: null,
      terminalOpen: true,
      terminalHeight: 300,
      inbox: null,
      at: 20,
    });
    // The reader's own inbox choice is a field like the others, and so is
    // the layout's own fold.
    expect(
      readCodingSessionPanels(
        writeCodingSessionPanels(ab, 'conv-a', { inbox: true }, 30),
        'conv-a',
      ).inbox,
    ).toBe(true);
    expect(
      readCodingSessionPanels(
        writeCodingSessionPanels(ab, 'conv-a', { inbox: 'layout' }, 31),
        'conv-a',
      ).inbox,
    ).toBe('layout');
    // A patch that changes nothing is the same record (no store write).
    expect(writeCodingSessionPanels(ab, 'conv-a', { side: 'diff' }, 30)).toBe(
      ab,
    );
  });

  test(`the bound is ${CODING_PANELS_SESSION_BOUND}: the entry past it evicts the one touched longest ago`, () => {
    // A literal beside the constant, so a change to the bound is a change here.
    expect(CODING_PANELS_SESSION_BOUND).toBe(32);
    let record = DEFAULT_CODING_PANELS_RECORD;
    for (let index = 0; index < CODING_PANELS_SESSION_BOUND; index += 1) {
      record = writeCodingSessionPanels(
        record,
        `conv-${index}`,
        { side: 'diff' },
        // conv-5 is the oldest, not conv-0: eviction follows the touch, not
        // the insertion.
        index === 5 ? 1 : 100 + index,
      );
    }
    expect(Object.keys(record.sessions)).toHaveLength(
      CODING_PANELS_SESSION_BOUND,
    );

    const overflowed = writeCodingSessionPanels(
      record,
      'conv-extra',
      { side: 'files' },
      1000,
    );
    expect(Object.keys(overflowed.sessions)).toHaveLength(
      CODING_PANELS_SESSION_BOUND,
    );
    expect(overflowed.sessions['conv-5']).toBeUndefined();
    expect(overflowed.sessions['conv-0']).toBeDefined();
    expect(overflowed.sessions['conv-extra']?.side).toBe('files');

    // A touch of an old entry keeps it: conv-0 (touched now) survives the
    // next overflow, and conv-1 (the oldest now) does not.
    const touched = writeCodingSessionPanels(
      overflowed,
      'conv-0',
      { terminalOpen: true },
      2000,
    );
    const again = writeCodingSessionPanels(
      touched,
      'conv-extra-2',
      { side: 'diff' },
      3000,
    );
    expect(again.sessions['conv-0']).toBeDefined();
    expect(again.sessions['conv-1']).toBeUndefined();
  });

  test('the parser is the import validation: a malformed record is refused, a malformed entry dropped, an overflow trimmed', () => {
    expect(parseCodingSessionPanelsRecord(null)).toBeNull();
    expect(parseCodingSessionPanelsRecord('not a record')).toBeNull();
    expect(
      parseCodingSessionPanelsRecord({ version: 2, sessions: {} }),
    ).toBeNull();
    expect(
      parseCodingSessionPanelsRecord({ version: 1, sessions: [] }),
    ).toBeNull();

    const parsed = parseCodingSessionPanelsRecord({
      version: 1,
      sessions: {
        good: { side: 'diff', sideWidth: 400, terminalOpen: true, at: 5 },
        sparse: {},
        'bad-side': { side: 42 },
        'bad-width': { sideWidth: -1 },
        'bad-open': { terminalOpen: 'yes' },
        'bad-inbox': { inbox: 'yes' },
        folded: { inbox: 'layout' },
        'bad-at': { at: 'now' },
        '': { side: 'diff' },
      },
    });
    expect(parsed).toEqual({
      version: 1,
      sessions: {
        good: {
          side: 'diff',
          sideWidth: 400,
          terminalOpen: true,
          terminalHeight: null,
          inbox: null,
          at: 5,
        },
        sparse: CLOSED_CODING_SESSION_PANELS,
        folded: { ...CLOSED_CODING_SESSION_PANELS, inbox: 'layout' },
      },
    });

    const sessions: Record<string, unknown> = {};
    for (let index = 0; index <= CODING_PANELS_SESSION_BOUND; index += 1)
      sessions[`conv-${index}`] = { side: 'diff', at: index };
    const trimmed = parseCodingSessionPanelsRecord({ version: 1, sessions });
    expect(Object.keys(trimmed?.sessions ?? {})).toHaveLength(
      CODING_PANELS_SESSION_BOUND,
    );
    expect(trimmed?.sessions['conv-0']).toBeUndefined();
  });
});
