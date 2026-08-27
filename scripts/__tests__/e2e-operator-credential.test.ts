import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  e2eOperatorAuthorizationHeaders,
  readE2EOperatorCredential,
} from '../../tests/helpers/e2e-operator-credential';

const roots: string[] = [];
const OPERATOR_CREDENTIAL = 'a'.repeat(43);

function stationHome(record: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'station-e2e-credential-'));
  roots.push(home);
  mkdirSync(join(home, 'security'));
  writeFileSync(
    join(home, 'security', 'environment.json'),
    JSON.stringify(record),
  );
  return home;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('nested Station E2E operator credential', () => {
  test('reads the exact disposable home and authenticates protected readiness', () => {
    const credential = readE2EOperatorCredential(
      stationHome({ credential: OPERATOR_CREDENTIAL }),
    );

    expect(credential).toBe(OPERATOR_CREDENTIAL);
    expect(e2eOperatorAuthorizationHeaders(credential)).toEqual({
      Authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
    });
  });

  test.each([{}, { credential: '' }, { credential: 'malformed' }])(
    'fails closed for an invalid nested-home record %#',
    (record) => {
      expect(() => readE2EOperatorCredential(stationHome(record))).toThrow(
        'did not publish a valid operator credential',
      );
    },
  );
});
