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
  createSurfaceRegistry,
  DEFAULT_DEVICE_REGION_ARRANGEMENT,
  REGION_IDS,
  REGION_SURFACE_REGISTRY,
  type RegionArrangement,
} from '../region-model';

const VALID: RegionArrangement = {
  main: {
    visible: true,
    size: 0,
    panes: ['home'],
    occupant: 'home',
    maximized: false,
  },
  left: {
    visible: false,
    size: 400,
    panes: [],
    occupant: null,
    maximized: false,
  },
  right: {
    visible: true,
    size: 517,
    panes: ['activity'],
    occupant: 'activity',
    maximized: false,
  },
  bottom: {
    visible: false,
    size: 320,
    panes: ['chat'],
    occupant: 'chat',
    maximized: false,
  },
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
    // A literal ceiling: 8K is above any display edge this UI lays out on.
    // Pinned as a number so widening it is a visible decision, not drift.
    expect(REGION_SIZE_MAX).toBe(8192);
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
        // Absolute values, not derived from the constant: an orchestrator
        // injection widened REGION_SIZE_MAX to MAX_SAFE_INTEGER and this
        // loop moved with it. A record cannot ask for a dock wider than any
        // display, whatever the constant says.
        100_000,
        1e9,
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
            occupant: { kind: 'split-host', documentId: 'doc-1' },
          }),
        )!.right,
      ).toMatchObject({ panes: [], occupant: null });
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

    test('a surface named by two regions keeps the first in REGION_IDS order and empties and hides the rest', () => {
      const parsed = parseRegionArrangementRecord({
        version: 1,
        regions: {
          main: {
            visible: true,
            size: 0,
            occupant: { kind: 'surface', id: 'activity' },
            maximized: false,
          },
          left: {
            visible: true,
            size: 400,
            occupant: { kind: 'surface', id: 'activity' },
            maximized: false,
          },
          right: {
            visible: true,
            size: 400,
            occupant: { kind: 'surface', id: 'activity' },
            maximized: false,
          },
          bottom: {
            visible: false,
            size: 320,
            occupant: { kind: 'surface', id: 'chat' },
            maximized: false,
          },
        },
      });
      expect(parsed!.main.occupant).toBe('activity');
      expect(parsed!.left).toEqual({
        visible: false,
        size: 400,
        panes: [],
        occupant: null,
        maximized: false,
      });
      expect(parsed!.right).toEqual({
        visible: false,
        size: 400,
        panes: [],
        occupant: null,
        maximized: false,
      });
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

  // #928 slice iii: `maximized` is additive to the version-1 record.
  describe('maximized (additive, #928 slice iii)', () => {
    const MAXIMIZED: RegionArrangement = {
      ...VALID,
      right: { ...VALID.right, maximized: true },
    };

    test('round-trips a maximized region and writes the field explicitly', () => {
      const record = toRegionArrangementRecord(MAXIMIZED);
      expect(record.regions.right.maximized).toBe(true);
      expect(record.regions.bottom.maximized).toBe(false);
      expect(parseRegionArrangementRecord(record)).toEqual(MAXIMIZED);
    });

    test('an absent or non-boolean maximized reads as false (a record written before the field existed)', () => {
      const record = toRegionArrangementRecord(VALID);
      const regions = Object.fromEntries(
        Object.entries(record.regions).map(([id, region]) => {
          const { maximized: _dropped, ...rest } = region;
          return [id, rest];
        }),
      );
      const parsed = parseRegionArrangementRecord({ version: 1, regions });
      expect(parsed).toEqual(VALID);
      expect(
        parseRegionArrangementRecord(recordWith('right', { maximized: 'yes' }))!
          .right.maximized,
      ).toBe(false);
    });

    test('main is never maximized whatever was stored', () => {
      expect(
        parseRegionArrangementRecord(recordWith('main', { maximized: true }))!
          .main.maximized,
      ).toBe(false);
    });

    test('a hidden region and an empty region are never maximized', () => {
      // `bottom` holds Chat hidden in VALID.
      expect(
        parseRegionArrangementRecord(recordWith('bottom', { maximized: true }))!
          .bottom.maximized,
      ).toBe(false);
      // `left` is empty in VALID; make it visible-and-maximized with nothing in it.
      expect(
        parseRegionArrangementRecord(
          recordWith('left', { visible: true, maximized: true }),
        )!.left.maximized,
      ).toBe(false);
      // An occupant the parser empties (retired surface) drops the maximize too.
      expect(
        parseRegionArrangementRecord(
          recordWith('right', {
            occupant: { kind: 'surface', id: 'retired-surface' },
            maximized: true,
          }),
        )!.right.maximized,
      ).toBe(false);
    });

    test('more than one maximized region keeps the first in REGION_IDS order', () => {
      const record = toRegionArrangementRecord({
        ...VALID,
        left: {
          visible: true,
          size: 400,
          panes: ['chat'],
          occupant: 'chat',
          maximized: true,
        },
        bottom: {
          visible: false,
          size: 320,
          panes: [],
          occupant: null,
          maximized: false,
        },
        right: { ...VALID.right, maximized: true },
      });
      const parsed = parseRegionArrangementRecord(record);
      expect(parsed!.left.maximized).toBe(true);
      expect(parsed!.right.maximized).toBe(false);
      expect(REGION_IDS.filter((id) => parsed![id].maximized)).toEqual([
        'left',
      ]);
    });

    test('a record without the field equals one spelling out false, so a pre-field default still reads as the default', () => {
      const record = toRegionArrangementRecord(VALID);
      const withoutField = {
        ...record,
        regions: Object.fromEntries(
          Object.entries(record.regions).map(([id, region]) => {
            const { maximized: _dropped, ...rest } = region;
            return [id, rest];
          }),
        ) as typeof record.regions,
      };
      expect(regionArrangementRecordsEqual(record, withoutField)).toBe(true);
      expect(
        regionArrangementRecordsEqual(
          record,
          recordWith('right', { maximized: true }),
        ),
      ).toBe(false);
      // The upgrade pin: a device holding the slice-D default literal (no
      // `maximized`) must still read as "no record" after this slice.
      const preFieldDefault = {
        version: 1,
        regions: {
          main: {
            visible: true,
            size: 0,
            occupant: { kind: 'surface', id: 'home' },
          },
          left: { visible: false, size: 400, occupant: null },
          right: { visible: false, size: 400, occupant: null },
          bottom: {
            visible: false,
            size: 320,
            occupant: { kind: 'surface', id: 'chat' },
          },
        },
      } as unknown as Parameters<typeof isDefaultRegionArrangementRecord>[0];
      expect(isDefaultRegionArrangementRecord(preFieldDefault)).toBe(true);
    });
  });

  // #2046 2a: a region holding two or more panes writes `pane-host`.
  describe('pane-host (#2046 2a, decisions 1 and 2)', () => {
    const TWO_PANES: RegionArrangement = {
      ...VALID,
      right: {
        visible: true,
        size: 517,
        panes: ['activity', 'chat'],
        occupant: 'chat',
        maximized: false,
      },
      bottom: {
        visible: false,
        size: 320,
        panes: [],
        occupant: null,
        maximized: false,
      },
    };

    /**
     * Reverting the writer to `{ kind: 'surface', id: occupant }` fails the
     * first assertion (kind `surface`) and, downstream, the round trip: the
     * parser would read `right` as Chat alone and `panes` would be
     * `['chat']`.
     */
    test('a two-pane region round-trips as pane-host with its panes in tab order and its selected pane', () => {
      const record = toRegionArrangementRecord(TWO_PANES);
      expect(record.regions.right.occupant).toEqual({
        kind: 'pane-host',
        // No document id (2b): the host derives the region's document from
        // the region, so the record names none.
        panes: [
          { kind: 'surface', id: 'activity' },
          { kind: 'surface', id: 'chat' },
        ],
        selected: 'chat',
      });
      expect(parseRegionArrangementRecord(record)).toEqual(TWO_PANES);
    });

    test('a single-pane region still writes { kind: "surface" } (an older build in the stale-tab window reads it)', () => {
      const record = toRegionArrangementRecord(TWO_PANES);
      expect(record.regions.main.occupant).toEqual({
        kind: 'surface',
        id: 'home',
      });
      expect(record.regions.bottom.occupant).toBeNull();
      // The default arrangement, every region one pane or none, is unchanged
      // byte for byte — the contracts pin above depends on it.
      expect(
        Object.values(
          toRegionArrangementRecord(DEFAULT_DEVICE_REGION_ARRANGEMENT).regions,
        ).map((region) => region.occupant?.kind ?? null),
      ).toEqual(['surface', null, null, 'surface']);
    });

    test('an invalid or absent selected falls back to the first pane', () => {
      const record = toRegionArrangementRecord(TWO_PANES);
      const withSelected = (selected: unknown) =>
        parseRegionArrangementRecord({
          ...record,
          regions: {
            ...record.regions,
            right: {
              ...record.regions.right,
              occupant: {
                ...(record.regions.right.occupant as object),
                selected,
              },
            },
          },
        })!.right;
      expect(withSelected('home')).toMatchObject({
        panes: ['activity', 'chat'],
        occupant: 'activity',
      });
      expect(withSelected(7)).toMatchObject({ occupant: 'activity' });
      expect(withSelected(undefined)).toMatchObject({ occupant: 'activity' });
      expect(withSelected('chat')).toMatchObject({ occupant: 'chat' });
    });

    test('panes the registry lacks, or that do not declare the region, are dropped; nothing left reads as empty', () => {
      const parsed = parseRegionArrangementRecord(
        recordWith('right', {
          occupant: {
            kind: 'pane-host',
            panes: [
              { kind: 'surface', id: 'retired-surface' },
              { kind: 'surface', id: 'home' }, // declares only `main`
              { kind: 'surface', id: 'chat' },
              'activity', // not an entry shape
              { kind: 'surface', id: 'chat' }, // a duplicate within the set
            ],
            selected: 'retired-surface',
          },
        }),
      )!.right;
      expect(parsed).toMatchObject({ panes: ['chat'], occupant: 'chat' });

      const nothingLeft = parseRegionArrangementRecord(
        recordWith('right', {
          visible: true,
          occupant: {
            kind: 'pane-host',
            panes: [{ kind: 'surface', id: 'home' }],
          },
        }),
      )!.right;
      expect(nothingLeft).toMatchObject({ panes: [], occupant: null });
    });

    /**
     * #2047: a coding surface in a region's panes is just a surface id to
     * the record — `{ kind: 'surface', id: 'coding:terminal' }`, colon and
     * all — and round-trips like any other. Reverting the registry entries
     * makes the parser drop it (`parseSurfaceEntry`), which the first
     * assertion catches.
     */
    test('a coding surface round-trips in a pane-host and as a one-pane surface', () => {
      const withTerminal: RegionArrangement = {
        ...VALID,
        right: {
          visible: true,
          size: 517,
          panes: ['chat', 'coding:terminal'],
          occupant: 'coding:terminal',
          maximized: false,
        },
        bottom: {
          visible: true,
          size: 320,
          panes: ['coding:file-browser'],
          occupant: 'coding:file-browser',
          maximized: false,
        },
      };
      const record = toRegionArrangementRecord(withTerminal);
      expect(record.regions.right.occupant).toEqual({
        kind: 'pane-host',
        panes: [
          { kind: 'surface', id: 'chat' },
          { kind: 'surface', id: 'coding:terminal' },
        ],
        selected: 'coding:terminal',
      });
      expect(record.regions.bottom.occupant).toEqual({
        kind: 'surface',
        id: 'coding:file-browser',
      });
      expect(parseRegionArrangementRecord(record)).toEqual(withTerminal);
    });

    /**
     * #1969: the Device surface is a bare word (`device`) rather than a
     * `coding:`-prefixed one, so it exercises the same round trip through a
     * different id shape — and the older-registry case below needs its own
     * filter, because `startsWith('coding:')` would never drop it.
     */
    test('the Device surface round-trips and an older registry reads its region as empty', () => {
      const withDevice: RegionArrangement = {
        ...VALID,
        right: {
          visible: true,
          size: 517,
          panes: ['activity', 'device'],
          occupant: 'device',
          maximized: false,
        },
      };
      const record = toRegionArrangementRecord(withDevice);
      expect(record.regions.right.occupant).toEqual({
        kind: 'pane-host',
        panes: [
          { kind: 'surface', id: 'activity' },
          { kind: 'surface', id: 'device' },
        ],
        selected: 'device',
      });
      expect(parseRegionArrangementRecord(record)).toEqual(withDevice);

      const older = createSurfaceRegistry(
        [...REGION_SURFACE_REGISTRY.values()].filter(
          (surface) => surface.id !== 'device',
        ),
      );
      expect(older.has('device')).toBe(false);
      expect(parseRegionArrangementRecord(record, older)?.right).toMatchObject({
        visible: true,
        panes: ['activity'],
        occupant: 'activity',
      });
    });

    /**
     * The rollback story (#2047, same-device stale-tab window): a build whose
     * registry predates the coding surfaces reads the record a newer build
     * wrote. A `pane-host` keeps the panes it knows; a `surface` form naming
     * only the unknown id reads as an EMPTY region — visible, but with
     * nothing to mount (`RegionShells` mounts a host only for a registered
     * occupant). The whole record is never rejected.
     */
    test('an older registry keeps the panes it knows and reads a coding-only region as empty', () => {
      const older = createSurfaceRegistry(
        [...REGION_SURFACE_REGISTRY.values()].filter(
          (surface) => !surface.id.startsWith('coding:'),
        ),
      );
      expect(older.has('coding:terminal')).toBe(false);
      const record = toRegionArrangementRecord({
        ...VALID,
        right: {
          visible: true,
          size: 517,
          panes: ['chat', 'coding:terminal'],
          occupant: 'coding:terminal',
          maximized: false,
        },
        bottom: {
          visible: true,
          size: 320,
          panes: ['coding:file-browser'],
          occupant: 'coding:file-browser',
          maximized: false,
        },
      });
      const parsed = parseRegionArrangementRecord(record, older);
      expect(parsed?.right).toMatchObject({
        visible: true,
        panes: ['chat'],
        occupant: 'chat',
      });
      expect(parsed?.bottom).toMatchObject({
        visible: true,
        size: 320,
        panes: [],
        occupant: null,
      });
      expect(parsed?.main.occupant).toBe('home');
    });

    /**
     * #2049: an instance-keyed pane is a plain `{ kind: 'surface', id }`
     * entry whose id is data. It round-trips because `parseSurfaceEntry`
     * resolves through `resolveRegionSurface`, which knows the prefix — and
     * it is still checked against the REGION the pane declares, so `main`
     * refuses it exactly as it refuses any dock surface. Reverting the parser
     * to a bare registry lookup drops both ids and reds the first two
     * assertions.
     */
    test('a pull-request and a file-preview pane round-trip, and main refuses them', () => {
      const previewId = `file-preview:${'b'.repeat(32)}`;
      const withInstances: RegionArrangement = {
        ...VALID,
        right: {
          visible: true,
          size: 517,
          panes: ['chat', 'pr:github.com/kontourai/station#2049'],
          occupant: 'pr:github.com/kontourai/station#2049',
          maximized: false,
        },
        bottom: {
          visible: true,
          size: 320,
          panes: [previewId],
          occupant: previewId,
          maximized: false,
        },
      };
      expect(
        parseRegionArrangementRecord(toRegionArrangementRecord(withInstances)),
      ).toEqual(withInstances);
      expect(
        parseRegionArrangementRecord(
          recordWith('main', {
            occupant: {
              kind: 'surface',
              id: 'pr:github.com/kontourai/station#2049',
            },
          }),
        )!.main,
      ).toMatchObject({ panes: [], occupant: null });
      // An id no family describes is still unknown — and "describes" is the
      // full shape the family MINTS, not its prefix. A stored id that only
      // starts the same way is refused here, which is what keeps the parser's
      // answer equal to the host chunk's: an id this admitted and
      // `regionSurfacePane` refused would mount a region with no pane in it.
      for (const id of [
        'browser-preview:1',
        'pr:not-a-real-id',
        'pr:github.com/kontourai/station#',
        'pr:github.com/kontourai/station/extra#1',
        'pr:GitHub.com/kontourai/station#1',
        'pr:',
        'file-preview:zzz',
        `file-preview:${'a'.repeat(31)}`,
        `file-preview:${'a'.repeat(32)}X`,
      ])
        expect(
          parseRegionArrangementRecord(
            recordWith('right', { occupant: { kind: 'surface', id } }),
          )!.right,
          id,
        ).toMatchObject({ panes: [], occupant: null });
    });

    test('a pane-host without an array of panes reads as empty; a documentId a 2a build wrote is ignored', () => {
      for (const occupant of [
        { kind: 'pane-host', panes: 'chat' },
        { kind: 'pane-host' },
        { kind: 'pane-host', documentId: 'right' },
      ]) {
        expect(
          parseRegionArrangementRecord(recordWith('right', { occupant }))!
            .right,
          JSON.stringify(occupant),
        ).toMatchObject({ panes: [], occupant: null });
      }
      // The 2a record carried `documentId`; the field is neither required
      // nor read now, so a record from that build still resolves its panes.
      expect(
        parseRegionArrangementRecord(
          recordWith('right', {
            occupant: {
              kind: 'pane-host',
              documentId: 7,
              panes: [
                { kind: 'surface', id: 'chat' },
                { kind: 'surface', id: 'activity' },
              ],
              selected: 'activity',
            },
          }),
        )!.right,
      ).toMatchObject({ panes: ['chat', 'activity'], occupant: 'activity' });
    });

    test('a surface in two regions is dropped from the later region’s panes, keeping the rest', () => {
      const parsed = parseRegionArrangementRecord({
        version: 1,
        regions: {
          main: {
            visible: true,
            size: 0,
            occupant: { kind: 'surface', id: 'home' },
          },
          left: {
            visible: true,
            size: 400,
            occupant: { kind: 'surface', id: 'activity' },
          },
          right: {
            visible: true,
            size: 400,
            occupant: {
              kind: 'pane-host',
              panes: [
                { kind: 'surface', id: 'activity' },
                { kind: 'surface', id: 'chat' },
              ],
              selected: 'activity',
            },
          },
          bottom: {
            visible: true,
            size: 320,
            occupant: { kind: 'surface', id: 'chat' },
          },
        },
      })!;
      expect(parsed.left).toMatchObject({
        panes: ['activity'],
        occupant: 'activity',
      });
      // Activity was `left`'s first; `right` keeps Chat and, its selected
      // pane gone, selects what remains.
      expect(parsed.right).toMatchObject({
        panes: ['chat'],
        occupant: 'chat',
        visible: true,
      });
      // Chat was `right`'s first; `bottom` has nothing left: empty and hidden.
      expect(parsed.bottom).toMatchObject({
        panes: [],
        occupant: null,
        visible: false,
      });
    });

    test('main reads at most one pane, its selected one', () => {
      expect(
        parseRegionArrangementRecord(
          recordWith('main', {
            occupant: {
              kind: 'pane-host',
              panes: [
                { kind: 'surface', id: 'home' },
                { kind: 'surface', id: 'activity' },
              ],
              selected: 'activity',
            },
          }),
        )!.main,
      ).toMatchObject({ panes: ['activity'], occupant: 'activity' });
    });

    test('records differing only in pane order or selection are not equal', () => {
      const record = toRegionArrangementRecord(TWO_PANES);
      const occupant = record.regions.right.occupant;
      if (occupant?.kind !== 'pane-host') throw new Error('unreachable');
      expect(
        regionArrangementRecordsEqual(
          record,
          toRegionArrangementRecord(TWO_PANES),
        ),
      ).toBe(true);
      expect(
        regionArrangementRecordsEqual(
          record,
          recordWith('right', {
            occupant: { ...occupant, panes: [...occupant.panes].reverse() },
          }),
        ),
      ).toBe(false);
      expect(
        regionArrangementRecordsEqual(
          record,
          recordWith('right', {
            occupant: { ...occupant, selected: 'activity' },
          }),
        ),
      ).toBe(false);
      expect(
        regionArrangementRecordsEqual(
          record,
          recordWith('right', { occupant: { kind: 'surface', id: 'chat' } }),
        ),
      ).toBe(false);
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
