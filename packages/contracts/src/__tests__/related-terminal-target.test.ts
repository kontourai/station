import { describe, expect, it } from 'vitest';
import { decodeRelatedTerminalOpenRequest } from '../workspace-pane-host-contract.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('decodeRelatedTerminalOpenRequest', () => {
  it('accepts an existing terminal or a new one on a session binding', () => {
    expect(
      decodeRelatedTerminalOpenRequest({
        kind: 'terminal',
        binding: 'project',
        terminalId: ID,
      }),
    ).toEqual({
      kind: 'terminal',
      binding: 'project',
      terminalId: ID,
    });
    expect(
      decodeRelatedTerminalOpenRequest({
        kind: 'terminal',
        binding: 'thread:t_42',
        new: {},
      }),
    ).toEqual({
      kind: 'terminal',
      binding: 'thread:t_42',
      new: {},
    });
    expect(
      decodeRelatedTerminalOpenRequest({
        kind: 'terminal',
        binding: 'project',
        new: { profile: 'zsh' },
      }),
    ).toEqual({
      kind: 'terminal',
      binding: 'project',
      new: { profile: 'zsh' },
    });
  });

  it('refuses a working directory or any field the contract does not define', () => {
    expect(
      decodeRelatedTerminalOpenRequest({
        kind: 'terminal',
        binding: 'project',
        new: {},
        cwd: '/',
      }),
    ).toBeNull();
    expect(
      decodeRelatedTerminalOpenRequest({
        kind: 'terminal',
        binding: 'project',
        new: { cwd: '/etc' },
      }),
    ).toBeNull();
    expect(
      decodeRelatedTerminalOpenRequest({
        kind: 'terminal',
        binding: 'project',
        new: { profile: 'zsh', shell: '/bin/sh' },
      }),
    ).toBeNull();
  });

  it('requires exactly one of terminalId and new', () => {
    expect(
      decodeRelatedTerminalOpenRequest({
        kind: 'terminal',
        binding: 'project',
      }),
    ).toBeNull();
    expect(
      decodeRelatedTerminalOpenRequest({
        kind: 'terminal',
        binding: 'project',
        terminalId: ID,
        new: {},
      }),
    ).toBeNull();
  });

  it('refuses malformed bindings, ids and profiles rather than trimming them', () => {
    for (const binding of [
      '',
      'worktree:/tmp/x',
      'thread:',
      'project ',
      'thread:a/b',
      `thread:${'x'.repeat(201)}`,
    ])
      expect(
        decodeRelatedTerminalOpenRequest({
          kind: 'terminal',
          binding,
          new: {},
        }),
        binding,
      ).toBeNull();
    expect(
      decodeRelatedTerminalOpenRequest({
        kind: 'terminal',
        binding: 'project',
        terminalId: 'legacy-1',
      }),
    ).toBeNull();
    expect(
      decodeRelatedTerminalOpenRequest({
        kind: 'terminal',
        binding: 'project',
        new: { profile: '../sh' },
      }),
    ).toBeNull();
    expect(
      decodeRelatedTerminalOpenRequest({
        kind: 'pane',
        binding: 'project',
        new: {},
      }),
    ).toBeNull();
    expect(decodeRelatedTerminalOpenRequest(null)).toBeNull();
    expect(decodeRelatedTerminalOpenRequest([])).toBeNull();
  });
});
