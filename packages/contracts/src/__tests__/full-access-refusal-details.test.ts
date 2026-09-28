/**
 * #1796 G1: a refusal's `details` is read from an untrusted envelope, and
 * the device name in it is chosen by whoever paired the device.
 */
import { describe, expect, test } from 'vitest';
import {
  parseApprovalFullAccessRefusalDetails,
  sanitizeRefusalDeviceName,
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
});
