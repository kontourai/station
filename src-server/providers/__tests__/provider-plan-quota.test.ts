import { describe, expect, test } from 'vitest';
import {
  classifyProviderQuotaFailure,
  formatProviderQuotaEventText,
  formatProviderQuotaReasonDetail,
  PROVIDER_PLAN_QUOTA_EXHAUSTED_CODE,
  PROVIDER_PLAN_QUOTA_MESSAGE,
  providerQuotaEventDetails,
  providerQuotaFactsFromDetails,
} from '../provider-plan-quota.js';

/**
 * #2265: engine-neutral classifier tests. The quota fixture below is a
 * SYNTHETIC reconstruction of the known observed shape (76-char provider
 * sentence plus a short engine-side label prefix, 92 chars total) — never
 * copied from a private event window, which also carries unrelated
 * reasoning/output.
 */

const PROVIDER_SENTENCE =
  'Usage limit reached for 5 hour. Your limit will reset at 2026-09-21 18:55:29';

/** Synthetic OpenCode-side wrapper: label prefix + provider sentence. */
const OBSERVED_SHAPE = `quota: ${PROVIDER_SENTENCE}`;

function requestError(message: string, code = -32603): Error {
  return Object.assign(new Error(message), {
    name: 'RequestError',
    code,
  });
}

describe('provider-plan-quota classifier (#2265)', () => {
  test('classifies the observed wrapper + provider sentence into bounded facts', () => {
    const facts = classifyProviderQuotaFailure(requestError(OBSERVED_SHAPE));
    expect(facts).toEqual({
      quotaWindow: '5 hour',
      resetReported: '2026-09-21 18:55:29',
    });
  });

  test('classifies the bare provider sentence with no engine prefix', () => {
    expect(
      classifyProviderQuotaFailure(requestError(PROVIDER_SENTENCE)),
    ).toEqual({
      quotaWindow: '5 hour',
      resetReported: '2026-09-21 18:55:29',
    });
  });

  test('a transport failure with the quota sentence but no protocol code stays generic', () => {
    // Same text, wrong wrapper: 'ACP connection closed'-shaped errors
    // carry no numeric JSON-RPC code and must never classify.
    expect(
      classifyProviderQuotaFailure(new Error(OBSERVED_SHAPE)),
    ).toBeUndefined();
  });

  test('a non-Error rejection stays generic', () => {
    expect(classifyProviderQuotaFailure(OBSERVED_SHAPE)).toBeUndefined();
    expect(classifyProviderQuotaFailure(undefined)).toBeUndefined();
    expect(classifyProviderQuotaFailure({ code: -32603 })).toBeUndefined();
  });

  test('near-misses with extra text stay generic', () => {
    // Suffix: attacker/log text after the reset timestamp.
    expect(
      classifyProviderQuotaFailure(
        requestError(
          `${OBSERVED_SHAPE} https://example.invalid/reset?token=[REDACTED]`,
        ),
      ),
    ).toBeUndefined();
    // Prefix outside the bounded engine-label slot: bracketed log lines
    // and over-long labels are not the observed wrapper shape.
    expect(
      classifyProviderQuotaFailure(
        requestError(`[engine] ${PROVIDER_SENTENCE}`),
      ),
    ).toBeUndefined();
    expect(
      classifyProviderQuotaFailure(
        requestError(
          `a very long engine label that exceeds the slot: ${PROVIDER_SENTENCE}`,
        ),
      ),
    ).toBeUndefined();
    // Trailing credential/path text.
    expect(
      classifyProviderQuotaFailure(
        requestError(
          `${PROVIDER_SENTENCE} key=[REDACTED] at /private/var/user-notes/plan.md`,
        ),
      ),
    ).toBeUndefined();
    // Substring inside a longer body.
    expect(
      classifyProviderQuotaFailure(
        requestError(`upstream 429 body: {"msg":"${PROVIDER_SENTENCE}"}`, 429),
      ),
    ).toBeUndefined();
  });

  test('malformed timestamps stay generic', () => {
    expect(
      classifyProviderQuotaFailure(
        requestError(
          'quota: Usage limit reached for 5 hour. Your limit will reset at 2026-13-21 18:55:29',
        ),
      ),
    ).toBeUndefined();
    expect(
      classifyProviderQuotaFailure(
        requestError(
          'quota: Usage limit reached for 5 hour. Your limit will reset at 2026-09-21 25:55:29',
        ),
      ),
    ).toBeUndefined();
    expect(
      classifyProviderQuotaFailure(
        requestError(
          'quota: Usage limit reached for 5 hour. Your limit will reset at soon',
        ),
      ),
    ).toBeUndefined();
    expect(
      classifyProviderQuotaFailure(
        requestError(
          'quota: Usage limit reached for five hour. Your limit will reset at 2026-09-21 18:55:29',
        ),
      ),
    ).toBeUndefined();
  });

  test('an unrelated engine failure stays generic', () => {
    expect(
      classifyProviderQuotaFailure(requestError('Internal error')),
    ).toBeUndefined();
    expect(
      classifyProviderQuotaFailure(requestError('ACP connection closed')),
    ).toBeUndefined();
  });

  test('retry-after crosses only when genuinely supplied and validated', () => {
    const withRetry = classifyProviderQuotaFailure(
      requestError(OBSERVED_SHAPE),
      { retryAfterMs: 30 * 60_000 },
    );
    expect(withRetry?.retryAfterMs).toBe(30 * 60_000);
    // Absent by default: nothing on the observed wire supplies one.
    expect(
      classifyProviderQuotaFailure(requestError(OBSERVED_SHAPE))?.retryAfterMs,
    ).toBeUndefined();
    // Malformed values are dropped, never forwarded.
    for (const bad of [
      '1800',
      -5,
      0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      25 * 60 * 60_000,
    ]) {
      expect(
        classifyProviderQuotaFailure(requestError(OBSERVED_SHAPE), {
          retryAfterMs: bad,
        })?.retryAfterMs,
      ).toBeUndefined();
    }
  });

  test('details re-validation drops forged or malformed facts', () => {
    expect(
      providerQuotaFactsFromDetails({
        quotaWindow: '5 hour',
        resetReported: '2026-09-21 18:55:29',
        resetPrecision: 'unqualified',
      }),
    ).toEqual({
      quotaWindow: '5 hour',
      resetReported: '2026-09-21 18:55:29',
    });
    // Hostile smuggling attempts: URL, secret, path, and script text are
    // all outside the validated shapes, so the whole read fails closed.
    expect(
      providerQuotaFactsFromDetails({
        quotaWindow: '5 hour; curl https://example.invalid/x',
        resetReported: '2026-09-21 18:55:29',
      }),
    ).toBeUndefined();
    expect(
      providerQuotaFactsFromDetails({
        quotaWindow: '5 hour',
        resetReported: '2026-09-21 18:55:29 key=[REDACTED]',
      }),
    ).toBeUndefined();
    expect(
      providerQuotaFactsFromDetails({
        quotaWindow: '/private/var/user-notes/plan.md',
        resetReported: 'tomorrow',
      }),
    ).toBeUndefined();
    expect(providerQuotaFactsFromDetails(undefined)).toBeUndefined();
    expect(providerQuotaFactsFromDetails('5 hour')).toBeUndefined();
  });

  test('fixed copy carries no provider text and labels the reset unqualified', () => {
    const facts = {
      quotaWindow: '5 hour',
      resetReported: '2026-09-21 18:55:29',
    };
    expect(PROVIDER_PLAN_QUOTA_EXHAUSTED_CODE).toBe(
      'provider-plan-quota-exhausted',
    );
    expect(PROVIDER_PLAN_QUOTA_MESSAGE).not.toContain('Usage limit');
    const detail = formatProviderQuotaReasonDetail(facts);
    expect(detail).toContain('5 hour');
    expect(detail).toContain('2026-09-21 18:55:29');
    expect(detail).toMatch(/no timezone/i);
    expect(detail).not.toContain('Usage limit');
    // Guidance: wait/check then continue explicitly; no retry/switch/spend.
    expect(detail).toMatch(/did not retry/i);
    const eventText = formatProviderQuotaEventText(facts);
    expect(eventText).toContain('2026-09-21 18:55:29');
    expect(eventText).not.toContain('Usage limit');
    const details = providerQuotaEventDetails(facts);
    expect(details).toEqual({
      quotaWindow: '5 hour',
      resetReported: '2026-09-21 18:55:29',
      resetPrecision: 'unqualified',
    });
  });
});
