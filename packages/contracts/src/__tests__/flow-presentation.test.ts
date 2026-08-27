import { describe, expect, test } from 'vitest';
import {
  flowRunDisplayIdentity,
  isRetiredFlowDefinition,
  STANDARD_FLOW_BUILDER_GUIDANCE,
} from '../flow-presentation.js';

describe('Flow presentation policy', () => {
  test('hides retired definition and run identifiers', () => {
    expect(isRetiredFlowDefinition('station-delivery')).toBe(true);
    expect(flowRunDisplayIdentity('station-delivery', 'secret-run')).toBe(
      'Legacy delivery checks',
    );
  });

  test('preserves standard definition and run identities', () => {
    expect(flowRunDisplayIdentity('release', 'run-1')).toBe('release · run-1');
  });

  test('guides policy refusals to the standard lifecycle without naming the retired one', () => {
    expect(STANDARD_FLOW_BUILDER_GUIDANCE).toContain('Flow/Builder lifecycle');
    expect(STANDARD_FLOW_BUILDER_GUIDANCE).not.toContain('station-delivery');
  });
});
