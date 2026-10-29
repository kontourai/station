/**
 * #1796 G1: a refusal's `details` is read from an untrusted envelope, and
 * the device name in it is chosen by whoever paired the device.
 */
import { describe, expect, test } from 'vitest';
import {
  GROUP_LIMITED_CLI_MAX_LENGTH,
  groupLimitedCommandStep,
  groupLimitedPeopleSteps,
  parseApprovalFullAccessRefusalDetails,
  sanitizeRefusalDeviceName,
  sanitizeUntrustedDisplayText,
} from '../orchestration.js';

const HOSTILE =
  '[Grant here](https://evil.example) \x1b[31mRED\x1b[0m **bold**';

const deviceRefusal = (deviceName: string) => ({
  requested: 'never',
  requester: { kind: 'device', deviceId: 'e6f3f571', deviceName },
  station: { environmentId: 'env-1' },
  grant: {
    by: 'operator',
    scope: 'approval:full-access',
    uiSteps: ['Step one.'],
    cli: 'station environment access scope e6f3f571 --add approval:full-access',
  },
});

describe('sanitizeRefusalDeviceName', () => {
  test('removes control, format and separator characters and bounds the length', () => {
    expect(sanitizeRefusalDeviceName(HOSTILE)).toBe(
      '[Grant here](https://evil.example) [31mRED[0m **bold**',
    );
    expect(sanitizeRefusalDeviceName('a‮b c\tt')).toBe('ab c t');
    expect(sanitizeRefusalDeviceName('\x1b\x07')).toBe('this device');
    expect(Array.from(sanitizeRefusalDeviceName('x'.repeat(65)))).toHaveLength(
      64,
    );
  });
});

describe('sanitizeUntrustedDisplayText', () => {
  test('strips bidi overrides, isolates and zero-width characters, and bounds the length', () => {
    expect(
      sanitizeUntrustedDisplayText(
        '\u202Edliub eht xiF\u202C \u2066ops\u2069\u200B\u200D\u200E\uFEFF',
        256,
      ),
    ).toBe('dliub eht xiF ops');
    expect(sanitizeUntrustedDisplayText('\u200B\u2067\u2069', 256)).toBe('');
    expect(sanitizeUntrustedDisplayText('abc de', 4)).toBe('abc');
  });
});

describe('parseApprovalFullAccessRefusalDetails', () => {
  test('reads a device refusal, sanitizing the name again', () => {
    expect(
      parseApprovalFullAccessRefusalDetails(deviceRefusal(HOSTILE))?.requester,
    ).toEqual({
      kind: 'device',
      deviceId: 'e6f3f571',
      deviceName: '[Grant here](https://evil.example) [31mRED[0m **bold**',
    });
  });

  test('refuses what is not a refusal, or claims more than the contract', () => {
    expect(parseApprovalFullAccessRefusalDetails(undefined)).toBeUndefined();
    expect(
      parseApprovalFullAccessRefusalDetails({
        ...deviceRefusal('x'),
        requested: 'ask',
      }),
    ).toBeUndefined();
    expect(
      parseApprovalFullAccessRefusalDetails({
        ...deviceRefusal('x'),
        requester: { kind: 'device', deviceId: '<script>', deviceName: 'x' },
      }),
    ).toBeUndefined();
    // An Agent has no grant path; one that claims one is not a refusal.
    expect(
      parseApprovalFullAccessRefusalDetails({
        ...deviceRefusal('x'),
        requester: { kind: 'agent' },
      }),
    ).toBeUndefined();
    expect(
      parseApprovalFullAccessRefusalDetails({
        ...deviceRefusal('x'),
        requester: { kind: 'agent' },
        grant: null,
      }),
    ).toEqual({
      requested: 'never',
      requester: { kind: 'agent' },
      station: { environmentId: 'env-1' },
      grant: null,
    });
  });

  test('#3557: keeps a Member group limit and drops any other value', () => {
    const limited = (groupLimited: unknown) =>
      parseApprovalFullAccessRefusalDetails({
        ...deviceRefusal('Phone'),
        grant: { ...deviceRefusal('Phone').grant, groupLimited },
      })?.grant;
    expect(limited({ group: 'member' })?.groupLimited).toEqual({
      group: 'member',
    });
    expect(
      limited({ group: 'member', cli: 'station x' })?.groupLimited,
    ).toEqual({ group: 'member', cli: 'station x' });
    // A command past the bound, or not a string, is dropped, not trusted.
    // Literal: 256 minus the 34-character "Then, on the Station's host, run: ".
    expect(GROUP_LIMITED_CLI_MAX_LENGTH).toBe(222);
    expect(
      limited({ group: 'member', cli: 'x'.repeat(223) })?.groupLimited,
    ).toEqual({ group: 'member' });
    // At the bound, the refusal still parses with its appended step.
    const longest = 'x'.repeat(222);
    const parsed = parseApprovalFullAccessRefusalDetails({
      ...deviceRefusal('Phone'),
      grant: {
        ...deviceRefusal('Phone').grant,
        uiSteps: [
          'As the operator, open People.',
          groupLimitedCommandStep(longest),
        ],
        groupLimited: { group: 'member', cli: longest },
      },
    });
    expect(parsed?.grant?.groupLimited).toEqual({
      group: 'member',
      cli: longest,
    });
    expect(limited({ group: 'member', cli: 7 })?.groupLimited).toEqual({
      group: 'member',
    });
    for (const value of [{ group: 'admin' }, 'member', true, { group: 1 }])
      expect(limited(value)).not.toHaveProperty('groupLimited');
    expect(
      parseApprovalFullAccessRefusalDetails(deviceRefusal('Phone'))?.grant,
    ).not.toHaveProperty('groupLimited');
  });

  test('#3557: the People steps omit only the command step the Station appended', () => {
    const grant = (uiSteps: string[], cli?: string) => ({
      by: 'operator' as const,
      scope: 'approval:full-access' as const,
      uiSteps,
      groupLimited: { group: 'member' as const, ...(cli ? { cli } : {}) },
    });
    expect(
      groupLimitedPeopleSteps(
        grant(['A', groupLimitedCommandStep('run it')], 'run it'),
      ),
    ).toEqual(['A']);
    // A last step that is not that command stays.
    expect(groupLimitedPeopleSteps(grant(['A', 'B'], 'run it'))).toEqual([
      'A',
      'B',
    ]);
    expect(groupLimitedPeopleSteps(grant(['A']))).toEqual(['A']);
  });
});
