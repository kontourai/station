import { describe, expect, test } from 'vitest';
import { isRelevantRoot } from '../roots';

const personal = {
  id: 'root:personal',
  scope: { kind: 'personal' as const },
  adapterId: 'kit-default-store',
  storeRoot: '/p',
  displayName: 'Personal',
  createdAt: '',
};

const projectA = {
  id: 'root:proj-a',
  scope: { kind: 'project' as const, projectSlug: 'proj-a' },
  adapterId: 'kit-default-store',
  storeRoot: '/a',
  displayName: 'Project A',
  createdAt: '',
};

const projectB = {
  id: 'root:proj-b',
  scope: { kind: 'project' as const, projectSlug: 'proj-b' },
  adapterId: 'kit-default-store',
  storeRoot: '/b',
  displayName: 'Project B',
  createdAt: '',
};

describe('isRelevantRoot', () => {
  test('personal roots are always relevant, regardless of the active project', () => {
    expect(isRelevantRoot(personal, null)).toBe(true);
    expect(isRelevantRoot(personal, 'proj-a')).toBe(true);
  });

  test('a project root is relevant only when it matches the active project', () => {
    expect(isRelevantRoot(projectA, 'proj-a')).toBe(true);
    expect(isRelevantRoot(projectA, 'proj-b')).toBe(false);
    expect(isRelevantRoot(projectB, 'proj-a')).toBe(false);
  });

  test('a project root is never relevant when no project is active', () => {
    expect(isRelevantRoot(projectA, null)).toBe(false);
  });
});
