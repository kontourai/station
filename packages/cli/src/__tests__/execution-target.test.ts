import { describe, expect, test } from 'vitest';
import { parseCoreArgs } from '../commands/core-api.js';
import {
  executionEnvironment,
  rejectRetiredExecutionSelectors,
} from '../commands/execution-target.js';

describe('canonical CLI execution targeting', () => {
  test('defaults to the controlling Station current Environment', () => {
    expect(executionEnvironment(parseCoreArgs([]))).toEqual({
      kind: 'current',
    });
  });

  test('brands the shared --on selector as a saved Environment', () => {
    expect(executionEnvironment(parseCoreArgs(['--on=env-media']))).toEqual({
      kind: 'saved',
      id: 'env-media',
    });
  });

  test.each(['connection', 'engine', 'environment'])(
    'rejects the retired --%s execution selector',
    (flag) => {
      expect(() =>
        rejectRetiredExecutionSelectors(parseCoreArgs([`--${flag}=direct`])),
      ).toThrow(`--${flag} is not an execution selector`);
    },
  );

  test('rejects a bare or empty --on before execution', () => {
    expect(() => executionEnvironment(parseCoreArgs(['--on']))).toThrow(
      '--on requires a non-empty Environment id',
    );
    expect(() => executionEnvironment(parseCoreArgs(['--on=']))).toThrow(
      '--on requires a non-empty Environment id',
    );
  });
});
