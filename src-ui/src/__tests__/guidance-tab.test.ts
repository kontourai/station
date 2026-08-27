/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, test } from 'vitest';
import {
  GUIDANCE_TAB_MEMORY_KEY,
  isGuidanceFilter,
  readRememberedGuidanceTab,
  resolveGuidanceTab,
} from '../views/guidance-tab';

afterEach(() => sessionStorage.clear());

// Guidance has ONE authored concept (Skills) and one runtime view (Commands).
// Nothing resolves to a Playbooks tab any more — the noun is gone from the UI.
describe('resolveGuidanceTab', () => {
  test('the URL wins over the memory', () => {
    sessionStorage.setItem(GUIDANCE_TAB_MEMORY_KEY, 'commands');
    expect(resolveGuidanceTab('skills')).toBe('skills');
  });

  test('the memory wins over the default', () => {
    sessionStorage.setItem(GUIDANCE_TAB_MEMORY_KEY, 'commands');
    expect(resolveGuidanceTab(undefined)).toBe('commands');
  });

  // An older build could have left the retired tab in this session's memory.
  test('a retired tab in the memory reads as the default, not as itself', () => {
    sessionStorage.setItem(GUIDANCE_TAB_MEMORY_KEY, 'playbooks');
    expect(readRememberedGuidanceTab()).toBe('skills');
    expect(resolveGuidanceTab(undefined)).toBe('skills');
  });

  test('an unreadable memory is the same answer as no memory', () => {
    expect(resolveGuidanceTab(undefined)).toBe('skills');
  });
});

describe('isGuidanceFilter', () => {
  test('accepts only the narrowing that exists', () => {
    expect(isGuidanceFilter('commands')).toBe(true);
    expect(isGuidanceFilter('playbooks')).toBe(false);
    expect(isGuidanceFilter(undefined)).toBe(false);
  });
});
