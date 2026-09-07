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
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function exchangeBlock(workflowName: string, endMarker: string): string {
  const workflow = readFileSync(
    join(root, '.github/workflows', workflowName),
    'utf8',
  );
  return workflow.slice(
    workflow.indexOf('oidc/token/exchange/package/'),
    workflow.indexOf(endMarker),
  );
}

const workflows = [
  {
    name: 'publish-packages',
    block: exchangeBlock('publish-packages.yml', 'Trusted publisher confirmed'),
  },
  {
    name: 'nightly CLI',
    block: exchangeBlock('nightly.yml', "echo 'trusted_publisher=true'"),
  },
] as const;

describe('npm OIDC exchange preflight (station#1744)', () => {
  it('accepts any 2xx from the npm token exchange, not only 200', () => {
    for (const workflow of workflows)
      expect(
        workflow.block,
        `${workflow.name} must accept 2xx: npm returns 201 Created, and pinning 200 fails a working trusted publisher`,
      ).toMatch(/2\[0-9\]\[0-9\]\)/);
  });

  it('does not gate the exchange on equality with 200', () => {
    for (const workflow of workflows)
      expect(
        workflow.block,
        `${workflow.name} regressed to an equality check on HTTP 200 (station#1744)`,
      ).not.toMatch(/\[ "\$status" != "200" \]/);
  });

  it('still proves a usable token came back, which is the real precondition', () => {
    expect(
      workflows[0].block,
      'the structural token check is what makes the preflight meaningful; a status alone proves nothing about the publish',
    ).toContain('returned no token; the publish would proceed unauthenticated');
  });
});
