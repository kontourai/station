import { describe, expect, test } from 'vitest';
import {
  PROJECT_ACCENT_PALETTE,
  projectAccent,
  projectAccents,
} from '../components/project-sidebar/projectAccent';

describe('projectAccent (single-slug compat helper)', () => {
  test('is deterministic and uses a bounded palette', () => {
    expect(projectAccent('operations')).toBe(projectAccent('operations'));
    expect(projectAccent('operations')).toMatch(/^var\(--event-[a-z-]+\)$/);
  });
});

describe('projectAccents — set-aware allocation (chat-dock-maximize-readiness)', () => {
  test('uses every palette entry before repeating any color', () => {
    const slugs = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    const map = projectAccents(slugs);

    expect(map.size).toBe(6);
    const colors = [...map.values()];
    expect(new Set(colors).size).toBe(6);
    expect(colors).toEqual([...PROJECT_ACCENT_PALETTE]);
  });

  test('does not repeat a color while the set fits within the palette', () => {
    // Three projects must each get a distinct color.
    const map = projectAccents(['zebra', 'apple', 'mango']);
    const colors = [...map.values()];
    expect(new Set(colors).size).toBe(3);
  });

  test('repeats only after the palette is exhausted', () => {
    const slugs = Array.from({ length: 8 }, (_, i) => `proj-${i}`);
    const map = projectAccents(slugs);
    const colors = [...map.values()];
    // First six are distinct; positions 6 and 7 reuse palette[0] and [1].
    expect(new Set(colors.slice(0, 6)).size).toBe(6);
    expect(colors[6]).toBe(colors[0]);
    expect(colors[7]).toBe(colors[1]);
  });

  test('is stable regardless of input/API order', () => {
    const a = projectAccents(['c', 'a', 'b', 'e', 'd', 'f']);
    const b = projectAccents(['f', 'e', 'd', 'c', 'b', 'a']);
    for (const slug of ['a', 'b', 'c', 'd', 'e', 'f']) {
      expect(a.get(slug)).toBe(b.get(slug));
    }
  });

  test('assigns deterministically by sorted slug, not by insertion order', () => {
    // Sorted ascending: apple, mango, zebra -> palette 0, 1, 2.
    const map = projectAccents(['zebra', 'apple', 'mango']);
    expect(map.get('apple')).toBe(PROJECT_ACCENT_PALETTE[0]);
    expect(map.get('mango')).toBe(PROJECT_ACCENT_PALETTE[1]);
    expect(map.get('zebra')).toBe(PROJECT_ACCENT_PALETTE[2]);
  });

  test('deduplicates repeated slugs', () => {
    const map = projectAccents(['a', 'a', 'b']);
    expect(map.size).toBe(2);
    expect(map.get('a')).toBe(PROJECT_ACCENT_PALETTE[0]);
    expect(map.get('b')).toBe(PROJECT_ACCENT_PALETTE[1]);
  });
});
