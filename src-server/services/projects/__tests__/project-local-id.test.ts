import { expect, test } from 'vitest';
import { localProjectIdFor } from '../project-local-id.js';

test('an exact id wins over another Project whose slug equals it (review round 2, P3-1)', () => {
  const projects = {
    listProjects: () => [
      // Listed first: a Project whose slug is the other Project's id.
      { id: 'id-a', slug: 'id-b' },
      { id: 'id-b', slug: 'b' },
    ],
  };
  expect(localProjectIdFor(projects, 'id-b')).toBe('id-b');
  expect(localProjectIdFor(projects, 'b')).toBe('id-b');
  expect(localProjectIdFor(projects, 'id-a')).toBe('id-a');
  expect(localProjectIdFor(projects, 'missing')).toBeUndefined();
});
