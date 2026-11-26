/** @vitest-environment jsdom */
import { afterEach, expect, test, vi } from 'vitest';
import { purgeRetiredActivityStorage } from '../retired-activity-storage';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
test('purges only the retired reader namespace', () => {
  localStorage.setItem('station:activity-review:v1:host:thread', 'private');
  localStorage.setItem('station:activity-review:v2:host:thread', 'keep');
  localStorage.setItem('station:chat-drafts:v1', 'draft');
  purgeRetiredActivityStorage();
  expect(
    localStorage.getItem('station:activity-review:v1:host:thread'),
  ).toBeNull();
  expect(localStorage.getItem('station:activity-review:v2:host:thread')).toBe(
    'keep',
  );
  expect(localStorage.getItem('station:chat-drafts:v1')).toBe('draft');
});
test('unavailable storage does not prevent mounting the shell', () => {
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new Error('denied');
  });
  localStorage.setItem('station:activity-review:v1:host:thread', 'private');
  expect(purgeRetiredActivityStorage).not.toThrow();
});
