import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * station#753 fix round: `docs/design/motion.md` requires a motion-contract
 * exception to "include a local test" — this repairs a gap in the pass that
 * introduced the exception (`motion-contract-baseline.json`'s per-file entry
 * for this file existed with no test pinning it).
 *
 * `.notification-history__dismissed`'s `notification-dismiss-collapse`
 * animation is deliberately `4s`, not a `--motion-*` token, because it
 * visually encodes `UNDO_WINDOW_MS` — the undo window's actual dwell time —
 * from NotificationHistory.tsx. Both numbers must move together: this test
 * pins the CSS literal, and asserts it against the live constant rather than
 * a copy of the number, so the two cannot drift silently.
 */

const CSS = readFileSync(
  path.resolve(import.meta.dirname, '..', 'NotificationHistory.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

const TSX = readFileSync(
  path.resolve(import.meta.dirname, '..', 'NotificationHistory.tsx'),
  'utf8',
);

describe('NotificationHistory dismiss-collapse animation (motion-contract exception)', () => {
  test('the undo window constant is 4000ms', () => {
    const match = /const UNDO_WINDOW_MS = (\d+);/.exec(TSX);
    expect(
      match,
      'UNDO_WINDOW_MS not found in NotificationHistory.tsx',
    ).not.toBeNull();
    expect(Number(match?.[1])).toBe(4000);
  });

  test('.notification-history__dismissed animates on the matching literal, not a token', () => {
    const rule = /\.notification-history__dismissed\s*\{([^}]*)\}/.exec(CSS);
    expect(
      rule,
      '.notification-history__dismissed rule not found',
    ).not.toBeNull();
    const body = rule?.[1] ?? '';
    const animation = body
      .split(';')
      .find((declaration) => /^\s*animation\s*:/.test(declaration));
    expect(animation).toBeDefined();
    // 4s === UNDO_WINDOW_MS (4000ms) — the assertion this exception exists to
    // keep honest.
    expect(animation).toMatch(/notification-dismiss-collapse\s+4s\b/);
    expect(animation).not.toMatch(/var\(--motion-/);
  });
});
