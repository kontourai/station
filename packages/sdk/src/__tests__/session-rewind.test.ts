import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getSessionLiveContinuity,
  rewindSessionToTurn,
} from '../client/session-rewind';

afterEach(() => {
  vi.unstubAllGlobals();
});

function answer(status: number, body: unknown) {
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const API = 'https://station.test';

describe('session continuity client', () => {
  it("reads the session's declared continuity", async () => {
    const fetch = answer(200, {
      success: true,
      data: { live: true, rewind: 'in-place', fork: 'native' },
    });
    expect(await getSessionLiveContinuity(API, 'thread/1')).toEqual({
      live: true,
      rewind: 'in-place',
      fork: 'native',
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `${API}/api/orchestration/sessions/thread%2F1/continuity`,
    );
  });

  it('an older host (404) offers nothing', async () => {
    answer(404, { success: false, error: 'Not found' });
    expect(await getSessionLiveContinuity(API, 'thread-1')).toEqual({
      live: false,
      rewind: 'none',
      fork: 'none',
    });
  });

  it('a malformed answer is an error, never a guessed offer', async () => {
    answer(200, { success: true, data: { live: true, rewind: 'yes' } });
    await expect(getSessionLiveContinuity(API, 'thread-1')).rejects.toThrow(
      'Invalid session continuity response',
    );
  });
});

describe('session rewind client', () => {
  it('posts the turn and reads the rewound outcome', async () => {
    const fetch = answer(200, {
      success: true,
      data: {
        kind: 'rewound',
        beforeTurnId: 'turn-2',
        hiddenTurnIds: ['turn-2', 'turn-3'],
        affectedFiles: { count: 3, paths: ['a.ts'] },
      },
    });
    expect(await rewindSessionToTurn(API, 'thread-1', 'turn-2')).toEqual({
      kind: 'rewound',
      beforeTurnId: 'turn-2',
      hiddenTurnIds: ['turn-2', 'turn-3'],
      affectedFiles: { count: 3, paths: ['a.ts'] },
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      `${API}/api/orchestration/sessions/thread-1/rewind`,
    );
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      turnId: 'turn-2',
    });
  });

  it('a typed refusal and an engine failure come back as given', async () => {
    answer(200, {
      success: true,
      data: { kind: 'refused', reason: 'unknown-turn' },
    });
    expect(await rewindSessionToTurn(API, 'thread-1', 'turn-2')).toEqual({
      kind: 'refused',
      reason: 'unknown-turn',
    });
    answer(200, { success: true, data: { kind: 'failed', message: 'no' } });
    expect(await rewindSessionToTurn(API, 'thread-1', 'turn-2')).toEqual({
      kind: 'failed',
      message: 'no',
    });
  });

  it('an unknown refusal reason or outcome is an error', async () => {
    answer(200, { success: true, data: { kind: 'refused', reason: 'other' } });
    await expect(
      rewindSessionToTurn(API, 'thread-1', 'turn-2'),
    ).rejects.toThrow('Invalid session rewind response');
  });

  it('an older host (404) reads as unsupported', async () => {
    answer(404, { success: false, error: 'Not found' });
    expect(await rewindSessionToTurn(API, 'thread-1', 'turn-2')).toEqual({
      kind: 'refused',
      reason: 'unsupported',
    });
  });
});
