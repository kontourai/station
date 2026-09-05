import { DEFAULT_REGION_ARRANGEMENT_RECORD } from '@kontourai/station-contracts/device-settings';
import { describe, expect, test } from 'vitest';
import { DOCK_MIN_HEIGHT } from '../../components/chat-dock/dockSnap';
import {
  isDefaultRegionArrangementRecord,
  parseRegionArrangementRecord,
  REGION_ARRANGEMENT_RECORD_VERSION,
  REGION_SIZE_MAX,
  REGION_SIZE_MIN,
  regionArrangementRecordsEqual,
  toRegionArrangementRecord,
} from '../region-arrangement-record';
import {
  DEFAULT_DEVICE_REGION_ARRANGEMENT,
  REGION_IDS,
  type RegionArrangement,
} from '../region-model';

const VALID: RegionArrangement = {
  main: { visible: true, size: 0, occupant: 'home' },
  left: { visible: false, size: 400, occupant: null },
  right: { visible: true, size: 517, occupant: 'activity' },
  bottom: { visible: false, size: 320, occupant: 'chat' },
};

/** A record with one region's stored fields replaced. */
function recordWith(
  region: (typeof REGION_IDS)[number],
  patch: Record<string, unknown>,
) {
  const record = toRegionArrangementRecord(VALID);
  return {
    ...record,
    regions: {
      ...record.regions,
      [region]: { ...record.regions[region], ...patch },
    },
  };
}

describe('region arrangement record (#928 D)', () => {
  test('a valid arrangement round-trips through the record unchanged', () => {
    expect(
      parseRegionArrangementRecord(toRegionArrangementRecord(VALID)),
    ).toEqual(VALID);
  });

  test('an occupant is written as { kind: "surface", id } — the pane-host extension point', () => {
    expect(toRegionArrangementRecord(VALID).regions.right.occupant).toEqual({
      kind: 'surface',
      id: 'activity',
    });
    expect(toRegionArrangementRecord(VALID).regions.left.occupant).toBeNull();
  });

  // The default lives in the UI; contracts holds its serialized twin because
  // it cannot import the UI. This is the pin that keeps them one value.
  test('the contracts default literal equals toRegionArrangementRecord(DEFAULT_DEVICE_REGION_ARRANGEMENT)', () => {
    expect(DEFAULT_REGION_ARRANGEMENT_RECORD).toEqual(
      toRegionArrangementRecord(DEFAULT_DEVICE_REGION_ARRANGEMENT),
    );
    expect(DEFAULT_REGION_ARRANGEMENT_RECORD.version).toBe(
      REGION_ARRANGEMENT_RECORD_VERSION,
    );
    expect(
      isDefaultRegionArrangementRecord(DEFAULT_REGION_ARRANGEMENT_RECORD),
    ).toBe(true);
    expect(
      isDefaultRegionArrangementRecord(toRegionArrangementRecord(VALID)),
    ).toBe(false);
  });

  test('the contracts region-id union mirrors REGION_IDS exactly', () => {
    expect(
      Object.keys(DEFAULT_REGION_ARRANGEMENT_RECORD.regions).sort(),
    ).toEqual([...REGION_IDS].sort());
  });

  test('the persisted size floor is the dock clamps’ shared floor', () => {
    expect(REGION_SIZE_MIN).toBe(DOCK_MIN_HEIGHT);
    expect(REGION_SIZE_MAX).toBeGreaterThan(REGION_SIZE_MIN);
  });

  describe('parse fails closed and never throws', () => {
    test('a value that is not a plain object is no record', () => {
      for (const value of [undefined, null, 'record', 7, [], () => undefined]) {
        expect(parseRegionArrangementRecord(value)).toBeNull();
      }
    });

    test('a record with the wrong version is no record', () => {
      const record = toRegionArrangementRecord(VALID);
      expect(
        parseRegionArrangementRecord({ ...record, version: 2 }),
      ).toBeNull();
      expect(
        parseRegionArrangementRecord({ ...record, version: '1' }),
      ).toBeNull();
      const { version: _dropped, ...unversioned } = record;
      expect(parseRegionArrangementRecord(unversioned)).toBeNull();
    });

    test('unknown region keys are dropped and missing regions take the default', () => {
      const record = toRegionArrangementRecord(VALID);
      const { left: _left, ...withoutLeft } = record.regions;
      const parsed = parseRegionArrangementRecord({
        version: 1,
        regions: { ...withoutLeft, diagonal: { visible: true, size: 300 } },
      });
      expect(parsed).not.toBeNull();
      expect(Object.keys(parsed!).sort()).toEqual([...REGION_IDS].sort());
      expect(parsed!.left).toEqual(DEFAULT_DEVICE_REGION_ARRANGEMENT.left);
      expect(parsed!.right).toEqual(VALID.right);
    });

    test('a regions field that is not an object reads as every region at its default', () => {
      expect(
        parseRegionArrangementRecord({ version: 1, regions: 'x' }),
      ).toEqual(DEFAULT_DEVICE_REGION_ARRANGEMENT);
      expect(parseRegionArrangementRecord({ version: 1 })).toEqual(
        DEFAULT_DEVICE_REGION_ARRANGEMENT,
      );
    });

    test('a non-boolean visible takes the default', () => {
      expect(
        parseRegionArrangementRecord(recordWith('right', { visible: 'yes' }))!
          .right.visible,
      ).toBe(DEFAULT_DEVICE_REGION_ARRANGEMENT.right.visible);
    });

    test('main is visible whatever was stored', () => {
      expect(
        parseRegionArrangementRecord(recordWith('main', { visible: false }))!
          .main.visible,
      ).toBe(true);
    });

    test('a non-finite or out-of-bounds dock size takes the default', () => {
      for (const size of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        '517',
        REGION_SIZE_MIN - 1,
        REGION_SIZE_MAX + 1,
        -1,
      ]) {
        expect(
          parseRegionArrangementRecord(recordWith('right', { size }))!.right
            .size,
          String(size),
        ).toBe(DEFAULT_DEVICE_REGION_ARRANGEMENT.right.size);
      }
      expect(
        parseRegionArrangementRecord(
          recordWith('right', { size: REGION_SIZE_MIN }),
        )!.right.size,
      ).toBe(REGION_SIZE_MIN);
      expect(
        parseRegionArrangementRecord(
          recordWith('right', { size: REGION_SIZE_MAX }),
        )!.right.size,
      ).toBe(REGION_SIZE_MAX);
    });

    test('main’s size is any finite non-negative number, else its default', () => {
      expect(
        parseRegionArrangementRecord(recordWith('main', { size: -4 }))!.main
          .size,
      ).toBe(0);
      expect(
        parseRegionArrangementRecord(recordWith('main', { size: 12 }))!.main
          .size,
      ).toBe(12);
    });

    test('an occupant of an unknown kind reads as an empty region (a newer writer’s variant, not a failure)', () => {
      expect(
        parseRegionArrangementRecord(
          recordWith('right', {
            occupant: { kind: 'pane-host', documentId: 'doc-1' },
          }),
        )!.right.occupant,
      ).toBeNull();
      expect(
        parseRegionArrangementRecord(
          recordWith('right', { occupant: 'activity' }),
        )!.right.occupant,
      ).toBeNull();
      expect(
        parseRegionArrangementRecord(
          recordWith('right', { occupant: ['activity'] }),
        )!.right.occupant,
      ).toBeNull();
    });

    test('a retired surface (an id the registry no longer has) reads as an empty region', () => {
      const parsed = parseRegionArrangementRecord(
        recordWith('right', {
          occupant: { kind: 'surface', id: 'retired-surface' },
        }),
      );
      expect(parsed!.right.occupant).toBeNull();
      // The rest of the record is kept: fail-closed per field, not per record.
      expect(parsed!.right.size).toBe(517);
      expect(parsed!.bottom.occupant).toBe('chat');
    });

    test('a surface in a region it does not declare reads as an empty region', () => {
      // Home declares only `main`; Chat declares only the dock regions.
      expect(
        parseRegionArrangementRecord(
          recordWith('right', { occupant: { kind: 'surface', id: 'home' } }),
        )!.right.occupant,
      ).toBeNull();
      expect(
        parseRegionArrangementRecord(
          recordWith('main', { occupant: { kind: 'surface', id: 'chat' } }),
        )!.main.occupant,
      ).toBeNull();
    });

    test('a surface named by two regions keeps the first in REGION_IDS order and empties the rest', () => {
      const parsed = parseRegionArrangementRecord({
        version: 1,
        regions: {
          main: {
            visible: true,
            size: 0,
            occupant: { kind: 'surface', id: 'activity' },
          },
          left: {
            visible: true,
            size: 400,
            occupant: { kind: 'surface', id: 'activity' },
          },
          right: {
            visible: true,
            size: 400,
            occupant: { kind: 'surface', id: 'activity' },
          },
          bottom: {
            visible: false,
            size: 320,
            occupant: { kind: 'surface', id: 'chat' },
          },
        },
      });
      expect(parsed!.main.occupant).toBe('activity');
      expect(parsed!.left.occupant).toBeNull();
      expect(parsed!.right.occupant).toBeNull();
      expect(parsed!.bottom.occupant).toBe('chat');
    });

    test('a missing region takes its default occupant; a described region with an unreadable occupant reads empty', () => {
      const record = toRegionArrangementRecord(VALID);
      const { bottom: _bottom, ...withoutBottom } = record.regions;
      expect(
        parseRegionArrangementRecord({ version: 1, regions: withoutBottom })!
          .bottom,
      ).toEqual(DEFAULT_DEVICE_REGION_ARRANGEMENT.bottom);
      expect(
        parseRegionArrangementRecord(recordWith('bottom', { occupant: 42 }))!
          .bottom.occupant,
      ).toBeNull();
    });

    test('main with no occupant is allowed (the outlet treats it as Home)', () => {
      expect(
        parseRegionArrangementRecord(recordWith('main', { occupant: null }))!
          .main.occupant,
      ).toBeNull();
    });

    test('a hostile record with wrong types everywhere parses to a usable arrangement', () => {
      expect(() =>
        parseRegionArrangementRecord({
          version: 1,
          regions: {
            main: 'x',
            left: null,
            right: { visible: 1, size: null, occupant: { kind: null } },
            bottom: [],
          },
        }),
      ).not.toThrow();
      expect(
        parseRegionArrangementRecord({
          version: 1,
          regions: {
            main: 'x',
            left: null,
            right: { visible: 1, size: null, occupant: { kind: null } },
            bottom: [],
          },
        }),
      ).toEqual({
        ...DEFAULT_DEVICE_REGION_ARRANGEMENT,
        // `bottom` stored nothing readable, so its default — including its
        // default occupant, Chat — applies.
      });
    });
  });

  test('regionArrangementRecordsEqual compares field by field', () => {
    const record = toRegionArrangementRecord(VALID);
    expect(
      regionArrangementRecordsEqual(record, toRegionArrangementRecord(VALID)),
    ).toBe(true);
    expect(
      regionArrangementRecordsEqual(record, recordWith('right', { size: 518 })),
    ).toBe(false);
    expect(
      regionArrangementRecordsEqual(
        record,
        recordWith('right', { occupant: { kind: 'surface', id: 'chat' } }),
      ),
    ).toBe(false);
    expect(
      regionArrangementRecordsEqual(
        record,
        recordWith('left', { visible: true }),
      ),
    ).toBe(false);
  });
});
