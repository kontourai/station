import { describe, expect, test } from 'vitest';
import {
  parseRequiredSlotAssignments,
  REQUIRED_SLOT_DEFAULTS,
  resolveRequiredSlot,
} from '../required-slots.js';

describe('required slots', () => {
  test.each(['home', 'chat'] as const)(
    '%s always has a default and supports override removal',
    (slot) => {
      const floor = {
        id: REQUIRED_SLOT_DEFAULTS[slot],
        available: true,
        value: 'default surface',
      };
      const override = {
        id: 'plugin:replacement',
        available: true,
        value: 'replacement surface',
      };
      expect(resolveRequiredSlot(slot, floor, override)).toMatchObject({
        source: 'override',
        filler: { value: 'replacement surface' },
        safeMode: false,
      });
      expect(resolveRequiredSlot(slot, floor)).toMatchObject({
        source: 'default',
        filler: { value: 'default surface' },
        safeMode: false,
      });
      expect(
        resolveRequiredSlot(slot, floor, { ...override, available: false }),
      ).toMatchObject({
        source: 'default',
        filler: { value: 'default surface' },
        safeMode: false,
      });
      expect(
        resolveRequiredSlot(slot, { ...floor, available: false }, override),
      ).toEqual({
        state: 'safe-mode',
        slot,
        defaultFiller: floor.id,
        safeMode: true,
      });
    },
  );

  test.each([null, '', 'none', ' ', 'NONE'])(
    'rejects an explicit empty Home: %j',
    (value) => {
      expect(() => parseRequiredSlotAssignments({ home: value })).toThrow(
        /non-empty filler/,
      );
    },
  );
  test('omission removes an override and preserves the default', () => {
    expect(parseRequiredSlotAssignments({})).toEqual({});
    expect(parseRequiredSlotAssignments({ chat: 'plugin:chat' })).toEqual({
      chat: 'plugin:chat',
    });
    expect(() =>
      parseRequiredSlotAssignments({ approvals: 'plugin:approvals' }),
    ).toThrow(/Unknown required slot/);
  });
});
