import { describe, expect, test } from 'vitest';
import {
  assertEnvironmentAdmissions,
  assertInternalTagRuleset,
} from '../ios-testflight-delivery-policy.mjs';

const environment = () => ({
  deployment_branch_policy: {
    protected_branches: false,
    custom_branch_policies: true,
  },
  branch_policies: [{ name: 'main', type: 'branch' }],
});
const ruleset = {
  id: 7,
  name: 'protect internal TestFlight authority',
  target: 'tag',
  enforcement: 'active',
  conditions: {
    ref_name: { include: ['refs/tags/ios-testflight/**'], exclude: [] },
  },
  rules: [{ type: 'non_fast_forward' }, { type: 'deletion' }],
  bypass_actors: [],
};

describe('internal iOS TestFlight delivery admission', () => {
  test('requires every channel environment to admit main', () => {
    expect(
      assertEnvironmentAdmissions({
        'native-release': environment(),
        'ios-beta': environment(),
        'ios-nightly': environment(),
      }),
    ).toHaveLength(3);
    expect(() =>
      assertEnvironmentAdmissions({
        'native-release': environment(),
        'ios-beta': {
          ...environment(),
          branch_policies: [{ name: 'v*-preview.*', type: 'tag' }],
        },
        'ios-nightly': environment(),
      }),
    ).toThrow(/ios-beta does not admit refs\/heads\/main/);
  });
  test('requires one immutable unbypassed tag ruleset', () => {
    expect(assertInternalTagRuleset([ruleset])).toMatchObject({ id: 7 });
    expect(() => assertInternalTagRuleset([])).toThrow(/exactly one active/);
    expect(() =>
      assertInternalTagRuleset([{ ...ruleset, rules: [{ type: 'deletion' }] }]),
    ).toThrow(/missing non_fast_forward/);
    expect(() =>
      assertInternalTagRuleset([
        { ...ruleset, bypass_actors: [{ actor_id: 1 }] },
      ]),
    ).toThrow(/unbypassed/);
  });
});
