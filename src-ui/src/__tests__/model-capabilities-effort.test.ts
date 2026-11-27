import { expect, test } from 'vitest';
import {
  requestedEffortLabel,
  resolveModelChoice,
} from '../utils/modelCapabilities';

const opus = {
  id: 'claude-opus',
  name: 'Opus',
  capabilities: {
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high', 'xhigh'],
  },
};

test('names only a requested effort the model reports', () => {
  expect(requestedEffortLabel(opus.capabilities, { effort: 'high' })).toBe(
    'High',
  );
  expect(
    requestedEffortLabel(opus.capabilities, { reasoningEffort: 'xhigh' }),
  ).toBe('Highest');
  expect(requestedEffortLabel(opus.capabilities, {})).toBeUndefined();
  expect(
    requestedEffortLabel(opus.capabilities, { effort: 'medium' }),
  ).toBeUndefined();
  expect(requestedEffortLabel(undefined, { effort: 'high' })).toBeUndefined();
});

test('a start resolves effort against the default model when no model was picked', () => {
  const effective = {
    id: 'claude-opus',
    label: 'Opus',
    source: 'agent default' as const,
  };
  expect(
    resolveModelChoice({ providerOptions: { effort: 'low' } }, effective, [
      opus,
    ]).effortLabel,
  ).toBe('Low');
  expect(
    resolveModelChoice(undefined, effective, [opus]).effortLabel,
  ).toBeUndefined();
});
