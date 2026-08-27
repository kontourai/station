import { it } from 'vitest';

it('fails if a nested Station worktree escapes Vitest exclusion', () => {
  throw new Error('nested Station worktree fixture was collected');
});
