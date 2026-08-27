import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * station#1744: the trusted-publishing preflight pinned the OIDC exchange to
 * `HTTP 200`, but npm answers it with `201 Created`. That turned a WORKING
 * trusted publisher into "no trusted publisher is configured" and failed every
 * real publish — observed live on run 31523902617, which reported
 * `HTTP 201` for `@kontourai/station-contracts` after the exchange had
 * succeeded. The status is a proxy; whether npm returned a usable token is the
 * fact, and the structural token check is what establishes it.
 *
 * These assertions exist so a tidying pass cannot restore the equality check.
 */
const workflow = readFileSync(
  join(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
    '.github/workflows/publish-packages.yml',
  ),
  'utf8',
);

const exchangeBlock = workflow.slice(
  workflow.indexOf('oidc/token/exchange/package/'),
  workflow.indexOf('Trusted publisher confirmed'),
);

describe('publish-packages OIDC exchange preflight (station#1744)', () => {
  it('accepts any 2xx from the npm token exchange, not only 200', () => {
    expect(
      exchangeBlock,
      'the OIDC exchange preflight must accept 2xx: npm returns 201 Created, and pinning 200 fails every publish against a working trusted publisher',
    ).toMatch(/2\[0-9\]\[0-9\]\)/);
  });

  it('does not gate the exchange on equality with 200', () => {
    expect(
      exchangeBlock,
      'the OIDC exchange preflight regressed to an equality check on HTTP 200 (station#1744)',
    ).not.toMatch(/\[ "\$status" != "200" \]/);
  });

  it('still proves a usable token came back, which is the real precondition', () => {
    expect(
      exchangeBlock,
      'the structural token check is what makes the preflight meaningful; a status alone proves nothing about the publish',
    ).toContain('returned no token; the publish would proceed unauthenticated');
  });
});
