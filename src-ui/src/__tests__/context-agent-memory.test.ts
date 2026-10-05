// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import {
  getContextAgent,
  trackContextAgent,
  useContextAgent,
} from '../hooks/useRecentAgents';

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

// #3350 item 4: a mounted surface follows a choice made on another surface
// (a track in this tab) and in another tab (a `storage` event).
test('the remembered Agent is live in this tab and across tabs', () => {
  const { result } = renderHook(() => useContextAgent('ns', 'project'));
  expect(result.current).toBeUndefined();
  act(() => trackContextAgent('ns', 'project', 'codex'));
  expect(result.current).toBe('codex');
  act(() => {
    localStorage.setItem(
      'station.newChat.lastAgentByContext',
      JSON.stringify({ [JSON.stringify(['ns', 'project'])]: 'claude' }),
    );
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'station.newChat.lastAgentByContext',
      }),
    );
  });
  expect(result.current).toBe('claude');
});
