import {
  SCHEDULER_OPERATOR_OPERATIONS,
  SCHEDULER_OPERATOR_SURFACE,
} from '@kontourai/station-contracts/scheduler';
import { describe, expect, test } from 'vitest';
import { actionsFor } from '../help.js';

describe('scheduler surface parity', () => {
  test('CLI help is driven by the canonical operator contract', () => {
    const actions = actionsFor('schedule');
    expect(actions).toEqual([
      'list',
      'jobs',
      ...SCHEDULER_OPERATOR_OPERATIONS.filter(
        (operation) => operation !== 'list',
      ),
    ]);
    expect(
      Object.values(SCHEDULER_OPERATOR_SURFACE).map(({ cli }) => cli),
    ).toEqual([...SCHEDULER_OPERATOR_OPERATIONS]);
  });
});
