import { describe, expect, test } from 'vitest';
import { isBoardReference } from '../board.js';

/**
 * Fix round B1 (independent review, BLOCKING): `isBoardReference` is layer
 * (a) of three path-traversal defenses (`board-store.ts`'s `pathFor` holds
 * layers (b)/(c)). This is a DENYLIST of path-hazardous shapes, not a
 * strict allowlist — see `board.ts`'s doc comment for the actual (free-form,
 * colon-bearing) id grammar this codebase mints, which a strict allowlist
 * would have broken.
 */
describe('isBoardReference', () => {
  test.each([
    ['.', 'exact dot'],
    ['..', "exact dot-dot — the reviewer's reproduction"],
    ['', 'empty string'],
    ['a/b', 'contains a forward slash'],
    ['a\\b', 'contains a backslash'],
    ['a\0b', 'contains a NUL byte'],
    ['a\nb', 'contains a control character'],
  ])('rejects a session id of %j (%s)', (id) => {
    expect(isBoardReference({ kind: 'session', id })).toBe(false);
  });

  test.each([
    [{ id: '..', projectId: 'ok' }, "id === '..'"],
    [{ id: 'ok', projectId: '..' }, "projectId === '..'"],
    [{ id: '..', projectId: '..' }, "both '..' — the reviewer's reproduction"],
    [{ id: '.', projectId: 'ok' }, "id === '.'"],
    [{ id: 'ok', projectId: '.' }, "projectId === '.'"],
    [{ id: 'a/b', projectId: 'ok' }, 'id contains a slash'],
    [{ id: 'ok', projectId: 'a/b' }, 'projectId contains a slash'],
  ])('rejects a task reference %j (%s)', ({ id, projectId }) => {
    expect(isBoardReference({ kind: 'task', id, projectId })).toBe(false);
  });

  test('rejects an id over the byte bound', () => {
    expect(isBoardReference({ kind: 'session', id: 'a'.repeat(513) })).toBe(
      false,
    );
    expect(isBoardReference({ kind: 'session', id: 'a'.repeat(512) })).toBe(
      true,
    );
  });

  test('rejects an unknown kind, non-object input, and extra keys', () => {
    expect(isBoardReference({ kind: 'project', id: 'x' })).toBe(false);
    expect(isBoardReference(null)).toBe(false);
    expect(isBoardReference('session:x')).toBe(false);
    expect(isBoardReference({ kind: 'session', id: 'x', extra: 'y' })).toBe(
      false,
    );
    expect(
      isBoardReference({ kind: 'task', id: 'x', projectId: 'y', extra: 'z' }),
    ).toBe(false);
  });

  test('accepts a legitimate colon-bearing session id (real production shape)', () => {
    // orchestration-service.ts: `${conversationId}:session:${crypto.randomUUID()}`
    expect(
      isBoardReference({
        kind: 'session',
        id: 'user-1:1735689600000:abc-123',
      }),
    ).toBe(true);
  });

  test('accepts a UUID-shaped task id and a slugified project id', () => {
    expect(
      isBoardReference({
        kind: 'task',
        id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        projectId: 'my-project-2',
      }),
    ).toBe(true);
  });

  test('a value containing "..data" or "..." (not the exact token) is accepted — only the EXACT value is rejected', () => {
    expect(isBoardReference({ kind: 'session', id: '..data' })).toBe(true);
    expect(isBoardReference({ kind: 'session', id: '...' })).toBe(true);
    expect(isBoardReference({ kind: 'session', id: 'a..b' })).toBe(true);
  });
});
