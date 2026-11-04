/**
 * #4470: the seed an error entry point's facts become. It must never carry a
 * token, a query string or a stack, and must always fit the host's limits.
 */
import {
  MAX_TROUBLESHOOT_SEED_CONVERSATION_ID_LENGTH,
  MAX_TROUBLESHOOT_SEED_ROUTE_LENGTH,
  MAX_TROUBLESHOOT_SEED_TURN_ID_LENGTH,
} from '@kontourai/station-contracts/troubleshoot';
import { describe, expect, test } from 'vitest';
import {
  buildTroubleshootSeed,
  TROUBLESHOOT_SUMMARY_LENGTH,
} from '../troubleshootSeed';

const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

describe('buildTroubleshootSeed', () => {
  test('keeps the code and the first message line, and drops the stack', () => {
    const seed = buildTroubleshootSeed(
      {
        code: 'HTTP 500',
        message:
          'Request failed\n    at fetch (/Users/alice/app.js:1:2)\n    at run',
      },
      '/settings',
    );
    expect(seed).toEqual({
      route: '/settings',
      errorSummary: 'HTTP 500: Request failed',
    });
  });

  test('skips a stack frame that comes first and uses the message line after it', () => {
    expect(
      buildTroubleshootSeed(
        { message: '    at x (y.js:1:2)\nReal failure' },
        '/',
      ).errorSummary,
    ).toBe('Real failure');
  });

  test('removes credentials, URLs with their query strings, and home paths', () => {
    const { errorSummary } = buildTroubleshootSeed(
      {
        code: 'fetch-failed',
        message: `GET https://station.example/api?token=s3cret failed with ${GITHUB_TOKEN} reading /Users/alice/.station/config.json`,
      },
      '/',
    );
    expect(errorSummary).toBeDefined();
    expect(errorSummary).not.toContain('s3cret');
    expect(errorSummary).not.toContain(GITHUB_TOKEN);
    expect(errorSummary).not.toContain('alice');
    expect(errorSummary).not.toContain('station.example');
  });

  test('bounds the summary well under the host limit', () => {
    const { errorSummary } = buildTroubleshootSeed(
      { message: 'x'.repeat(5_000) },
      '/',
    );
    expect(TROUBLESHOOT_SUMMARY_LENGTH).toBe(300);
    expect(errorSummary!.length).toBeLessThanOrEqual(
      TROUBLESHOOT_SUMMARY_LENGTH,
    );
  });

  test('omits a route the host would refuse instead of failing the start', () => {
    expect(
      buildTroubleshootSeed(
        { code: 'x' },
        `/${'r'.repeat(MAX_TROUBLESHOOT_SEED_ROUTE_LENGTH)}`,
      ).route,
    ).toBeUndefined();
    const atLimit = `/${'r'.repeat(MAX_TROUBLESHOOT_SEED_ROUTE_LENGTH - 1)}`;
    expect(buildTroubleshootSeed({ code: 'x' }, atLimit).route).toBe(atLimit);
    expect(
      buildTroubleshootSeed({ code: 'x' }, '//evil.example').route,
    ).toBeUndefined();
  });

  test('keeps ids within the host bounds and omits ones it would refuse', () => {
    const conversationId = 'c'.repeat(
      MAX_TROUBLESHOOT_SEED_CONVERSATION_ID_LENGTH,
    );
    const turnId = 't'.repeat(MAX_TROUBLESHOOT_SEED_TURN_ID_LENGTH);
    expect(
      buildTroubleshootSeed({ conversationId, turnId }, '/'),
    ).toMatchObject({ conversationId, turnId });
    const over = buildTroubleshootSeed(
      { conversationId: `${conversationId}c`, turnId: 'turn 1' },
      '/',
    );
    expect(over.conversationId).toBeUndefined();
    expect(over.turnId).toBeUndefined();
  });

  test('keeps pairing codes and stack frames out of the summary', () => {
    const seed = buildTroubleshootSeed(
      {
        code: 'E_PAIR\n    at pair (/Users/alice/station/src/pair.ts:10:5)',
        message: 'pairing failed manualCode=23456789AB',
      },
      '/settings',
    );
    expect(seed.errorSummary).not.toContain('23456789AB');
    expect(seed.errorSummary).not.toContain(' at ');
    expect(seed.errorSummary).not.toContain('pair.ts');
    expect(seed.errorSummary?.startsWith('E_PAIR: ')).toBe(true);
  });
});
