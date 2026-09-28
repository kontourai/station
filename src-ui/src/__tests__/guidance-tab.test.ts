/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  GUIDANCE_TAB_MEMORY_KEY,
  readRememberedGuidanceTab,
  resolveGuidanceTab,
} from '../views/guidance-tab';

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

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

  // Privacy-restricted webviews throw on sessionStorage access; Guidance must
  // still open rather than crash its route.
  test('an unreadable memory is the same answer as no memory', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(resolveGuidanceTab(undefined)).toBe('skills');
  });
});
