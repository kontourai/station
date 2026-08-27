import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildOpenApiSpec } from '../../src-server/openapi/spec.js';
import {
  cliAuthority,
  publicDocContractExampleFindings,
  routeAuthority,
} from '../public-doc-contract-examples.mjs';

const admitted = [{ source: 'fixture.md' }];

function findings(text: string) {
  return publicDocContractExampleFindings([{ ...admitted[0], text }]);
}

describe('public documentation contract examples', () => {
  it('accepts every currently admitted public document', () => {
    const manifest = JSON.parse(
      readFileSync('docs/pages/public-docs.json', 'utf8'),
    ) as { documents: Array<{ source: string }> };
    expect(publicDocContractExampleFindings(manifest.documents)).toEqual([]);
  });

  it('binds documented Station commands to both the registry and help authority', () => {
    const commands = cliAuthority();
    for (const command of ['start', 'stop', 'doctor', 'secret-bindings'])
      expect(commands).toContain(command);
    expect(
      findings('```sh\nstation renamed-command\n./station doctor "$@"\n```'),
    ).toEqual(["fixture.md:1 unknown Station CLI command 'renamed-command'."]);
    expect(findings('```sh\nstation start --instance="$unsafe"\n```')).toEqual([
      'fixture.md:1 has an unapproved Station shell placeholder.',
    ]);
  });

  it('rejects deleted Just recipes and npm scripts without running either command', () => {
    expect(
      findings('```sh\njust deleted-recipe\nnpm run deleted:script\n```'),
    ).toEqual([
      "fixture.md:1 unknown Just recipe 'deleted-recipe'.",
      "fixture.md:2 unknown npm script 'deleted:script'.",
    ]);
  });

  it('rejects method and path drift against the generated route inventory', () => {
    expect(
      JSON.parse(readFileSync('docs/reference/openapi.json', 'utf8')),
    ).toEqual(buildOpenApiSpec());
    expect(routeAuthority()).toContain('GET /agents');
    expect(findings('```sh\nPATCH /agents\nGET /agents/:deleted\n```')).toEqual(
      [
        "fixture.md:1 unknown HTTP route 'PATCH /agents'.",
        "fixture.md:2 unknown HTTP route 'GET /agents/:deleted'.",
      ],
    );
  });
});
