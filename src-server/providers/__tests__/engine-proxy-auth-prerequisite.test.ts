import type { Prerequisite } from '@kontourai/station-contracts/tool';
import { describe, expect, test } from 'vitest';
import { applyEngineProxyAuthPrerequisite } from '../adapters/engine-proxy-auth-prerequisite.js';

function authCell(
  command: string,
  overrides: Partial<Prerequisite> = {},
): Prerequisite {
  return {
    id: `${command}-auth`,
    name: `${command} login`,
    description: 'CLI credentials are present on this Station.',
    status: 'installed',
    category: 'required',
    ...overrides,
  };
}

const CLI_CELL: Prerequisite = {
  id: 'codex-cli',
  name: 'Codex CLI',
  description: 'Required to launch the Codex runtime.',
  status: 'installed',
  category: 'required',
};

describe('applyEngineProxyAuthPrerequisite', () => {
  test('names the route as the auth basis for the engine it is told about', () => {
    const result = applyEngineProxyAuthPrerequisite(
      [CLI_CELL, authCell('codex', { status: 'missing' })],
      'codex',
      'CLI Proxy (bmedia)',
    );

    expect(result.find((item) => item.id === 'codex-auth')).toMatchObject({
      name: 'Proxy key',
      status: 'installed',
      description:
        'A key is saved for CLI Proxy (bmedia). Check the connection to verify an answer.',
    });
    // Claiming a saved key must not claim a verified answer: that is the
    // smoke's question, not this read's.
    expect(
      result.find((item) => item.id === 'codex-auth')?.description,
    ).toContain('Check the connection to verify an answer.');
  });

  test('leaves every other prerequisite untouched', () => {
    const result = applyEngineProxyAuthPrerequisite(
      [CLI_CELL, authCell('codex')],
      'codex',
      'CLI Proxy (bmedia)',
    );

    expect(result[0]).toEqual(CLI_CELL);
    expect(result).toHaveLength(2);
  });

  test('rewrites only the auth cell of the command it was given', () => {
    // The inventory this replaced rewrote a literal id list; keying on the
    // caller's own command is what keeps one engine's route out of another's
    // cell when a list carries both.
    const result = applyEngineProxyAuthPrerequisite(
      [authCell('claude'), authCell('codex', { status: 'missing' })],
      'codex',
      'CLI Proxy (bmedia)',
    );

    expect(result[0]?.description).toBe(
      'CLI credentials are present on this Station.',
    );
    expect(result[1]).toMatchObject({
      status: 'installed',
      description:
        'A key is saved for CLI Proxy (bmedia). Check the connection to verify an answer.',
    });
  });

  test('returns the prerequisites unchanged when the connection has no route', () => {
    const input = [CLI_CELL, authCell('codex', { status: 'missing' })];
    const result = applyEngineProxyAuthPrerequisite(input, 'codex', undefined);

    expect(result).toEqual(input);
    expect(result[1]?.status).toBe('missing');
  });
});
