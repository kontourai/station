import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  ACP_SESSION_LISTING_BOUNDS,
  advertisesSessionListing,
  hasDedicatedSessionSource,
  MAX_REMEMBERED_PROBE_SESSIONS,
  PROBE_SESSION_LEDGER_MAX_BYTES,
  parseAcpSessionListPage,
  probeSessionLedgerPath,
  readAcpSessionListing,
  readProbeSessionIds,
  writeProbeSessionIds,
} from '../acp-session-listing.js';
import { answerFromFrame, capturedAgent } from './acp-session-list-frames.js';

afterEach(() => {
  vi.useRealTimers();
});

const makeTempDir = trackTempDirs();

describe('ACP session listing', () => {
  test('reads which captured agents advertise session/list', () => {
    expect(
      advertisesSessionListing(
        capturedAgent('antigravity-1.5.8').initialize.agentCapabilities,
      ),
    ).toBe(true);
    expect(
      advertisesSessionListing(
        capturedAgent('factory-droid-0.190.0').initialize.agentCapabilities,
      ),
    ).toBe(true);
    // Kiro 3.3.0 answers `sessionCapabilities: {}`: no listing.
    expect(
      advertisesSessionListing(
        capturedAgent('kiro-cli-3.3.0').initialize.agentCapabilities,
      ),
    ).toBe(false);
    expect(
      advertisesSessionListing({ sessionCapabilities: { list: null } }),
    ).toBe(false);
    expect(advertisesSessionListing(undefined)).toBe(false);
  });

  test('keeps the id, folder and last activity of a captured Antigravity listing and leaves out the probe session', async () => {
    const { list } = capturedAgent('antigravity-1.5.8');
    const captured = list!.result!.sessions as Array<Record<string, string>>;
    const probeSession = captured[0]!.sessionId!;
    const request = vi.fn((method: string) => {
      expect(method).toBe('session/list');
      return answerFromFrame(list);
    });

    const listing = await readAcpSessionListing(request, {
      deadlineMs: 1_000,
      exclude: new Set([probeSession]),
      now: () => 42,
    });

    expect(request).toHaveBeenCalledExactlyOnceWith('session/list', {});
    expect(listing).toMatchObject({
      observedAt: 42,
      outcome: 'ok',
      rejected: 0,
    });
    expect(listing.sessions).toHaveLength(captured.length - 1);
    expect(listing.sessions.map((s) => s.sessionId)).not.toContain(
      probeSession,
    );
    expect(listing.sessions[0]).toEqual({
      sessionId: captured[1]!.sessionId,
      cwd: captured[1]!.cwd,
      updatedAt: new Date(captured[1]!.updatedAt!).toISOString(),
    });
  });

  test('an agent that refuses the listing (Cursor signed out) is a failed outcome, not an empty success', async () => {
    const listing = await readAcpSessionListing(
      () => answerFromFrame(capturedAgent('cursor-agent-2026.05.01').list),
      { deadlineMs: 1_000 },
    );
    expect(listing).toMatchObject({ outcome: 'failed', sessions: [] });

    const empty = await readAcpSessionListing(
      () => answerFromFrame(capturedAgent('hermes-agent-0.17.0').list),
      { deadlineMs: 1_000 },
    );
    expect(empty).toMatchObject({ outcome: 'ok', sessions: [] });
  });

  test('pages by cursor within the page bound and refuses a repeated cursor', async () => {
    const page = (n: number, nextCursor?: string) => ({
      sessions: [{ sessionId: `s-${n}`, cwd: `/work/${n}` }],
      ...(nextCursor ? { nextCursor } : {}),
    });
    const paged = vi
      .fn()
      .mockResolvedValueOnce(page(1, 'c1'))
      .mockResolvedValueOnce(page(2));
    const two = await readAcpSessionListing(paged, { deadlineMs: 1_000 });
    expect(two.outcome).toBe('ok');
    expect(two.sessions.map((s) => s.sessionId)).toEqual(['s-1', 's-2']);
    expect(paged).toHaveBeenLastCalledWith('session/list', { cursor: 'c1' });

    let n = 0;
    const endless = vi.fn(async () => {
      n += 1;
      return page(n, `c${n}`);
    });
    const bounded = await readAcpSessionListing(endless, { deadlineMs: 1_000 });
    expect(bounded.outcome).toBe('limit');
    expect(endless).toHaveBeenCalledTimes(ACP_SESSION_LISTING_BOUNDS.maxPages);

    const looping = vi.fn(async () => page(1, 'same'));
    const loop = await readAcpSessionListing(looping, { deadlineMs: 1_000 });
    expect(loop.outcome).toBe('malformed');
    expect(looping).toHaveBeenCalledTimes(2);
  });

  test('bounds the session count, drops invalid entries and refuses a non-list answer', async () => {
    // Full pages whose total passes the bound: the excess is not kept.
    let page = 0;
    const capped = await readAcpSessionListing(
      async () => {
        page += 1;
        return {
          sessions: Array.from(
            { length: ACP_SESSION_LISTING_BOUNDS.maxSessions },
            (_, i) => ({ sessionId: `s-${page}-${i}`, cwd: '/work' }),
          ),
          nextCursor: `c${page}`,
        };
      },
      { deadlineMs: 1_000 },
    );
    expect(capped.outcome).toBe('limit');
    expect(capped.sessions).toHaveLength(
      ACP_SESSION_LISTING_BOUNDS.maxSessions,
    );

    expect(
      parseAcpSessionListPage({
        sessions: [
          { sessionId: 'ok', cwd: '/abs', updatedAt: 'not a time' },
          { sessionId: 'relative', cwd: 'work' },
          { sessionId: 'x'.repeat(257), cwd: '/abs' },
          { sessionId: 'ctl\u0007', cwd: '/abs' },
          { cwd: '/abs' },
          'not an object',
        ],
      }),
    ).toEqual({
      sessions: [{ sessionId: 'ok', cwd: '/abs' }],
      rejected: 5,
      cursorRejected: false,
    });
    expect(parseAcpSessionListPage({ items: [] })).toBeUndefined();
    expect(
      (
        await readAcpSessionListing(async () => ({ items: [] }), {
          deadlineMs: 1_000,
        })
      ).outcome,
    ).toBe('malformed');
  });

  test('an agent that never answers fails at the deadline, with the floor only where asked for', async () => {
    vi.useFakeTimers();
    const floored = readAcpSessionListing(() => new Promise(() => {}), {
      deadlineMs: 0,
      minDeadlineMs: ACP_SESSION_LISTING_BOUNDS.minDeadlineMs,
    });
    await vi.advanceTimersByTimeAsync(ACP_SESSION_LISTING_BOUNDS.minDeadlineMs);
    await expect(floored).resolves.toMatchObject({
      outcome: 'failed',
      sessions: [],
    });

    // An awaited probe gets no extra time: a spent budget sends nothing.
    const request = vi.fn(() => new Promise(() => {}));
    const spent = readAcpSessionListing(request, { deadlineMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(spent).resolves.toMatchObject({ outcome: 'failed' });
    expect(request).not.toHaveBeenCalled();
  });

  test('a page over the session bound is refused before any entry is read', async () => {
    let entriesRead = 0;
    const entry = {
      get sessionId() {
        entriesRead += 1;
        return 's';
      },
      cwd: '/work',
    };
    const oversized = {
      sessions: Array.from(
        { length: ACP_SESSION_LISTING_BOUNDS.maxSessions + 1 },
        () => entry,
      ),
    };
    const listing = await readAcpSessionListing(async () => oversized, {
      deadlineMs: 1_000,
    });
    expect(listing).toMatchObject({ outcome: 'limit', sessions: [] });
    expect(entriesRead).toBe(0);
  });

  test('engines with their own session source are not listed here', () => {
    expect(
      hasDedicatedSessionSource({ id: 'grok-build', command: 'grok' }),
    ).toBe(true);
    expect(
      hasDedicatedSessionSource({
        id: 'my-opencode',
        command: '/opt/homebrew/bin/opencode',
      }),
    ).toBe(true);
    expect(
      hasDedicatedSessionSource({ id: 'antigravity', command: 'agy' }),
    ).toBe(false);
  });

  describe('remembered probe session ids', () => {
    const ledger = () =>
      probeSessionLedgerPath(makeTempDir('station-probe-ids-'), 'agy');

    test('are owner-only even when the folder already existed more open', () => {
      const path = ledger();
      const folder = join(path, '..');
      mkdirSync(folder, { recursive: true, mode: 0o755 });
      chmodSync(folder, 0o755);
      writeProbeSessionIds(path, ['a']);
      expect(statSync(folder).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readProbeSessionIds(path)).toEqual(['a']);
    });

    test('keep the newest ids within the byte cap the reader accepts', () => {
      const path = ledger();
      // 256 ids of 256 bytes encode past the reader's cap.
      const ids = Array.from(
        { length: MAX_REMEMBERED_PROBE_SESSIONS },
        (_, i) => `${String(i).padStart(3, '0')}${'x'.repeat(253)}`,
      );
      writeProbeSessionIds(path, ids);
      expect(statSync(path).size).toBeLessThanOrEqual(
        PROBE_SESSION_LEDGER_MAX_BYTES,
      );
      const read = readProbeSessionIds(path);
      expect(read.length).toBeGreaterThan(0);
      expect(read.at(-1)).toBe(ids.at(-1));
      expect(ids.slice(-read.length)).toEqual(read);
    });

    test('keep at most 256 ids, dropping the oldest', () => {
      const path = ledger();
      const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
      writeProbeSessionIds(path, ids(MAX_REMEMBERED_PROBE_SESSIONS));
      expect(readProbeSessionIds(path)).toEqual(
        ids(MAX_REMEMBERED_PROBE_SESSIONS),
      );
      writeProbeSessionIds(path, ids(MAX_REMEMBERED_PROBE_SESSIONS + 1));
      expect(readProbeSessionIds(path)).toEqual(
        ids(MAX_REMEMBERED_PROBE_SESSIONS + 1).slice(1),
      );
    });

    test('read corrupt, non-array or oversized content as none', () => {
      const path = ledger();
      writeProbeSessionIds(path, ['seed']);
      for (const content of [
        '{not json',
        '{"ids":["a"]}',
        JSON.stringify(['x'.repeat(PROBE_SESSION_LEDGER_MAX_BYTES)]),
      ]) {
        writeFileSync(path, content);
        expect(readProbeSessionIds(path)).toEqual([]);
      }
      writeFileSync(path, JSON.stringify(['ok', 7, '', 'x'.repeat(300)]));
      expect(readProbeSessionIds(path)).toEqual(['ok']);
      expect(readFileSync(path, 'utf8')).toContain('ok');
    });
  });
});
