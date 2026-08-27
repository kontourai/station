/**
 * station#3213: the failure fold the session detail and the chat dock now
 * SHARE. It was inline in `useMutableSessionDetailState`, which is why the
 * dock — one layer away from the same facts — could not say a session had
 * failed at all.
 *
 * These pin the preference order, because that order is the whole reason the
 * extraction is worth doing: two surfaces reading one session must quote one
 * cause. A second copy that fell back differently would show the live
 * `runtime.error` on one surface and the server's `blockedReason` mirror on
 * the other, and nobody would be able to tell which was true.
 */

import { describe, expect, test } from 'vitest';
import type { OrchestrationEvent } from '../../hooks/orchestration/types';
import { NO_FAILURE_DETAIL_RECORDED } from '../attention';
import {
  isFailedSession,
  lastRuntimeErrorMessage,
  sessionFailureText,
  transcriptCarriesFailureText,
} from '../sessionFailure';

function runtimeError(message: string, at: string): OrchestrationEvent {
  return {
    method: 'runtime.error',
    provider: 'codex',
    threadId: 'thread-alpha',
    createdAt: at,
    severity: 'error',
    message,
  };
}

const TURN_STARTED: OrchestrationEvent = {
  method: 'turn.started',
  provider: 'codex',
  threadId: 'thread-alpha',
  createdAt: '2026-08-18T00:00:00.000Z',
  turnId: 'turn-1',
  prompt: 'do the thing',
};

describe('isFailedSession', () => {
  test('reads the lifecycle fold', () => {
    expect(isFailedSession({ lifecycleState: 'failed' } as any)).toBe(true);
    expect(isFailedSession({ lifecycleState: 'running' } as any)).toBe(false);
  });

  test('falls back to the coarse provider status only when no fold is present', () => {
    expect(isFailedSession({ status: 'failed' } as any)).toBe(true);
    // The fold wins: a session the lifecycle says is running is not failed,
    // whatever the process-level status happens to read.
    expect(
      isFailedSession({ lifecycleState: 'running', status: 'failed' } as any),
    ).toBe(false);
  });
});

describe('lastRuntimeErrorMessage', () => {
  test('takes the LAST runtime.error, not the first', () => {
    expect(
      lastRuntimeErrorMessage([
        runtimeError('first failure', '2026-08-18T00:00:01.000Z'),
        TURN_STARTED,
        runtimeError('later failure', '2026-08-18T00:00:03.000Z'),
      ]),
    ).toBe('later failure');
  });

  test('is undefined when the feed carries no runtime error', () => {
    expect(lastRuntimeErrorMessage([TURN_STARTED])).toBeUndefined();
    expect(lastRuntimeErrorMessage([])).toBeUndefined();
  });
});

describe('sessionFailureText', () => {
  const failed = {
    lifecycleState: 'failed',
    blockedReason: 'blocked-reason mirror',
  } as any;

  test('a session that has not failed has no failure text', () => {
    expect(
      sessionFailureText({ lifecycleState: 'running' } as any, [
        runtimeError(
          'a turn error that did not end the session',
          '2026-08-18T00:00:01.000Z',
        ),
      ]),
    ).toBeNull();
  });

  test('no session record at all is not a failure', () => {
    expect(sessionFailureText(null)).toBeNull();
    expect(sessionFailureText(undefined)).toBeNull();
  });

  test('the live feed wins over the server-side mirror', () => {
    expect(
      sessionFailureText(failed, [
        runtimeError(
          'ECONNREFUSED api.example.com:443',
          '2026-08-18T00:00:03.000Z',
        ),
      ]),
    ).toBe('ECONNREFUSED api.example.com:443');
  });

  test('the mirror carries the cause when the feed has not loaded it', () => {
    expect(sessionFailureText(failed, [])).toBe('blocked-reason mirror');
    // A caller with no event feed at all is the same case, not a different one.
    expect(sessionFailureText(failed)).toBe('blocked-reason mirror');
  });

  test('an unrecorded cause says so, in the one shared sentence', () => {
    expect(sessionFailureText({ lifecycleState: 'failed' } as any, [])).toBe(
      NO_FAILURE_DETAIL_RECORDED,
    );
  });
});

describe('transcriptCarriesFailureText (station#3299)', () => {
  const RAW =
    "Failed to execute 'close' on 'ReadableStreamDefaultController': Unexpected end of JSON input";

  test('matches the [CHAT_ERROR] marker card embedding the raw cause', () => {
    expect(
      transcriptCarriesFailureText(
        [{ content: `[SYSTEM_EVENT] [CHAT_ERROR] ${RAW}` }],
        [RAW],
      ),
    ).toBe(true);
  });

  /**
   * station#3769. This case used to carry `ephemeral: true`, so it matched
   * through the ephemeral branch and proved nothing about the projected row —
   * the durable shape (an ordinary assistant message, no ephemeral flag) was
   * untested, and the banner really did double up on it in the product.
   * Ownership follows the projection's own `runtimeError` flag.
   */
  test('matches a projected error row carried in contentParts', () => {
    expect(
      transcriptCarriesFailureText(
        [
          {
            content: '',
            contentParts: [{ content: `⚠️ ${RAW}`, runtimeError: true }],
          },
        ],
        [RAW],
      ),
    ).toBe(true);
  });

  test('an unmarked row carrying the same text is not a failure surface', () => {
    expect(
      transcriptCarriesFailureText(
        [{ content: '', contentParts: [{ content: `⚠️ ${RAW}` }] }],
        [RAW],
      ),
    ).toBe(false);
  });

  test('matches through ANY supplied needle — the translated body counts too', () => {
    expect(
      transcriptCarriesFailureText(
        [
          {
            content: 'Error: translated sentence about the stream.',
            ephemeral: true,
          },
        ],
        [RAW, 'translated sentence about the stream.'],
      ),
    ).toBe(true);
  });

  test('a transcript that says nothing about the failure does not match (the banner keeps its cold-arrival job, station#3213)', () => {
    expect(
      transcriptCarriesFailureText(
        [{ content: 'summarize this repo' }, { content: 'Sure — here it is.' }],
        [RAW],
      ),
    ).toBe(false);
  });

  test('empty needles never match anything', () => {
    expect(transcriptCarriesFailureText([{ content: 'anything' }], [''])).toBe(
      false,
    );
    expect(transcriptCarriesFailureText([{ content: 'anything' }], [])).toBe(
      false,
    );
  });
});
