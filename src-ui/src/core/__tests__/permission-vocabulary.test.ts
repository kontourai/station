import { PERMISSION_TIERS } from '@kontourai/station-contracts/plugin';
import { describe, expect, test } from 'vitest';
import {
  describePermission,
  PERMISSION_LABELS,
} from '../permission-vocabulary.js';

describe('permission vocabulary', () => {
  // archive#4301. The permission list is the artifact a person is asked to
  // make a trust decision from, so every entry in it has to be a capability
  // Station can actually name. Two failure directions, and this repo has had
  // both:
  //
  // - a permission with a TIER but no LABEL renders as "Custom permission" —
  //   the string reserved for something a plugin invented — beside a real
  //   built-in the user is being asked to consent to. `ui.confirm` was in
  //   exactly this state.
  // - a permission with a LABEL but no TIER is a capability sentence for
  //   something the vocabulary no longer has. `storage.read`/`storage.write`
  //   were removed from the tier table in this change; a leftover label would
  //   have kept describing a capability that does not exist.
  //
  // Asserting SET EQUALITY rather than one-directional containment is the
  // point: either half deleted on its own reddens here.
  test('every permission with a tier has a label, and every label has a tier', () => {
    expect(Object.keys(PERMISSION_LABELS).sort()).toEqual(
      Object.keys(PERMISSION_TIERS).sort(),
    );
  });

  test('every built-in permission renders a real capability, never the unknown fallback', () => {
    for (const permission of Object.keys(PERMISSION_TIERS)) {
      expect(
        describePermission(permission),
        `${permission} has no capability sentence`,
      ).not.toBe('Custom permission');
    }
  });

  // archive#4301: the retired storage vocabulary must not come back by
  // accident. It gated nothing — no route, middleware or bridge read either
  // name — and `storage.write` was `active`, so the product asked for consent
  // to a capability that did not exist. Reintroduce them only alongside a
  // plugin storage API.
  test.each(['storage.read', 'storage.write'])(
    '%s is not in the vocabulary (station#4301)',
    (retired) => {
      expect(Object.hasOwn(PERMISSION_TIERS, retired)).toBe(false);
      expect(Object.hasOwn(PERMISSION_LABELS, retired)).toBe(false);
      expect(describePermission(retired)).toBe('Custom permission');
    },
  );
});
