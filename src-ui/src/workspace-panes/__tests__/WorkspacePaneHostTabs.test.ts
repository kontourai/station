import { describe, expect, test } from 'vitest';
import { workspacePaneHostTabNextIndex } from '../WorkspacePaneHostTabs';

describe('workspace pane tab keyboard interaction', () => {
  test.each([
    ['ArrowRight', 0, 3, 1],
    ['ArrowRight', 2, 3, 0],
    ['ArrowLeft', 0, 3, 2],
    ['ArrowDown', 2, 3, 0],
    ['ArrowUp', 0, 3, 2],
    ['Home', 2, 3, 0],
    ['End', 0, 3, 2],
  ])('moves %s from %i in a %i-tab group to %i', (key, index, length, next) => {
    expect(workspacePaneHostTabNextIndex(index, length, key)).toBe(next);
  });

  test('does not claim unrelated keys or empty groups', () => {
    expect(workspacePaneHostTabNextIndex(0, 2, 'Enter')).toBeNull();
    expect(workspacePaneHostTabNextIndex(0, 0, 'End')).toBeNull();
  });
});
