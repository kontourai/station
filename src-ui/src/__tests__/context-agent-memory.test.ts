// @vitest-environment jsdom
import { beforeEach, expect, test } from 'vitest';
import { getContextAgent, trackContextAgent } from '../hooks/useRecentAgents';

beforeEach(() => localStorage.clear());
test('choice memory separates Station access, projects and No project and restores the last choice', () => {
  trackContextAgent('station-a:operator', 'project', 'codex');
  trackContextAgent('station-a:operator', '__global__', 'claude');
  trackContextAgent('station-b:operator', 'project', 'muse');
  trackContextAgent('station-a:member', 'project', 'reviewer');
  expect(getContextAgent('station-a:operator', 'project')).toBe('codex');
  expect(getContextAgent('station-a:operator', '__global__')).toBe('claude');
  expect(getContextAgent('station-b:operator', 'project')).toBe('muse');
  expect(getContextAgent('station-a:member', 'project')).toBe('reviewer');
  trackContextAgent('station-a:operator', 'project', 'reviewer');
  expect(getContextAgent('station-a:operator', 'project')).toBe('reviewer');
  expect(
    getContextAgent('station-a:operator', 'other-project'),
  ).toBeUndefined();
});
test('unverified access neither reads another namespace nor writes a choice', () => {
  trackContextAgent('verified', 'project', 'codex');
  const before = Object.entries(localStorage);
  trackContextAgent(null, 'project', 'claude');
  expect(getContextAgent(null, 'project')).toBeUndefined();
  expect(Object.entries(localStorage)).toEqual(before);
  expect(getContextAgent('verified', 'project')).toBe('codex');
});
