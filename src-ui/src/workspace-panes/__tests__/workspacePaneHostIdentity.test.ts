import { expect, test } from 'vitest';
import { workspacePaneHostTupleId } from '../workspacePaneHostIdentity';

test('DOM identities are encoded, delimiter-safe and collision-safe', () => {
  const encoded = workspacePaneHostTupleId('pane', 'a:b c', 'é');
  expect(encoded).toMatch(/^pane-[a-f0-9-]+$/);
  expect(encoded).not.toBe(workspacePaneHostTupleId('pane', 'a', 'b c'));
});
