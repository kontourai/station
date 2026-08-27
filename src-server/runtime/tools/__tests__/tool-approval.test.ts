import { describe, expect, test } from 'vitest';
import { builtinStationControlServerPath } from '../../bootstrap/station-control-runtime-env.js';
import {
  canonicalizeExternalToolName,
  isAutoApproved,
  isAutoApprovedExternalTool,
} from '../tool-approval.js';

// The genuine built-in station-control server as it appears in a resolved
// agent's toolServers (command 'node' + the exact built-in server path that
// `isBuiltinStationControl` pins on — the same identity #1157 uses to gate the
// internal token).
const GENUINE_STATION_CONTROL = {
  id: 'station-control',
  command: 'node',
  args: [builtinStationControlServerPath()],
};
// A same-id impostor: a user/plugin integration reusing the reserved id but a
// different command target. `isBuiltinStationControl` rejects it.
const IMPOSTOR_STATION_CONTROL = {
  id: 'station-control',
  command: 'node',
  args: ['/tmp/impostor-station-control.js'],
};

describe('tool-approval', () => {
  test('isAutoApproved supports exact, wildcard, and full wildcard patterns', () => {
    expect(isAutoApproved('tool_read', ['tool_read'])).toBe(true);
    expect(isAutoApproved('tool_read', ['tool_*'])).toBe(true);
    expect(isAutoApproved('tool_read', ['*'])).toBe(true);
    expect(isAutoApproved('tool_read', ['other_*'])).toBe(false);
  });

  describe('canonicalizeExternalToolName', () => {
    test('rewrites mcp__<server>__<tool> into the Station-engine <server>_<tool> shape', () => {
      expect(
        canonicalizeExternalToolName('mcp__station-control__list_agents'),
      ).toBe('station-control_list_agents');
    });

    test('leaves a non-mcp__ tool name unchanged', () => {
      expect(canonicalizeExternalToolName('Bash')).toBe('Bash');
      expect(canonicalizeExternalToolName('Read')).toBe('Read');
    });

    test('leaves a malformed mcp__ name (no second delimiter) unchanged', () => {
      expect(canonicalizeExternalToolName('mcp__station-control')).toBe(
        'mcp__station-control',
      );
    });
  });

  describe('isAutoApprovedExternalTool', () => {
    test("station-voice's actual pattern (station-control_*) matches the external mcp__station-control__* tool name for the GENUINE built-in with an authentic name", () => {
      expect(
        isAutoApprovedExternalTool(
          'mcp__station-control__list_agents',
          ['station-control_*'],
          [GENUINE_STATION_CONTROL],
          'authentic',
        ),
      ).toBe(true);
    });

    test('also matches when the pattern is authored directly against the mcp__ form (genuine built-in, authentic name)', () => {
      expect(
        isAutoApprovedExternalTool(
          'mcp__station-control__list_agents',
          ['mcp__station-control__*'],
          [GENUINE_STATION_CONTROL],
          'authentic',
        ),
      ).toBe(true);
    });

    test('a non-matching tool is not auto-approved', () => {
      expect(
        isAutoApprovedExternalTool('mcp__other-server__do_thing', [
          'station-control_*',
        ]),
      ).toBe(false);
    });

    test('empty or absent patterns never auto-approve', () => {
      expect(
        isAutoApprovedExternalTool('mcp__station-control__list_agents', []),
      ).toBe(false);
      expect(
        isAutoApprovedExternalTool(
          'mcp__station-control__list_agents',
          undefined,
        ),
      ).toBe(false);
    });

    // Reserved-built-in-name IDENTITY guard (security review, #1049 Q1 HIGH):
    // a `station-control_*` pattern must NOT silently auto-approve a same-id
    // impostor server, and must fail closed when the delivered identity is
    // unknown — even with an authentic name.
    test('an impostor server reusing the reserved id `station-control` is NOT auto-approved (even with an authentic name)', () => {
      expect(
        isAutoApprovedExternalTool(
          'mcp__station-control__list_agents',
          ['station-control_*'],
          [IMPOSTOR_STATION_CONTROL],
          'authentic',
        ),
      ).toBe(false);
    });

    test('a reserved-name match with no resolved toolServers fails closed (no auto-approve)', () => {
      expect(
        isAutoApprovedExternalTool(
          'mcp__station-control__list_agents',
          ['station-control_*'],
          undefined,
          'authentic',
        ),
      ).toBe(false);
      expect(
        isAutoApprovedExternalTool(
          'mcp__station-control__list_agents',
          ['station-control_*'],
          [],
          'authentic',
        ),
      ).toBe(false);
    });

    test('the reserved-name guard also covers a pattern authored against the mcp__ form for an impostor', () => {
      expect(
        isAutoApprovedExternalTool(
          'mcp__station-control__list_agents',
          ['mcp__station-control__*'],
          [IMPOSTOR_STATION_CONTROL],
          'authentic',
        ),
      ).toBe(false);
    });

    // Reserved-built-in-name PROVENANCE guard (security review, #1049 Q1 round-2
    // Probe A): even the GENUINE built-in legitimately in the session must NOT
    // auto-approve when the tool name is self-reported (ACP) — the name is
    // chosen by the less-trusted external agent and can't be trusted for a
    // privileged decision.
    test('a self-reported (ACP) tool name never takes the reserved-name shortcut, even with the genuine built-in present', () => {
      expect(
        isAutoApprovedExternalTool(
          'station-control_definitely_not_real',
          ['station-control_*'],
          [GENUINE_STATION_CONTROL],
          'self-reported',
        ),
      ).toBe(false);
      // Provenance defaults to self-reported (fail-closed) when unspecified.
      expect(
        isAutoApprovedExternalTool(
          'mcp__station-control__list_agents',
          ['station-control_*'],
          [GENUINE_STATION_CONTROL],
        ),
      ).toBe(false);
    });

    test('when the reserved id appears twice, the ENTRY THAT WINS DELIVERY (last) decides — genuine last approves, impostor last does not', () => {
      // Delivery is last-write-wins on the server-id key
      // (claude-mcp-passthrough.ts), so the guard must key on the last entry.
      expect(
        isAutoApprovedExternalTool(
          'mcp__station-control__list_agents',
          ['station-control_*'],
          [IMPOSTOR_STATION_CONTROL, GENUINE_STATION_CONTROL],
          'authentic',
        ),
      ).toBe(true);
      expect(
        isAutoApprovedExternalTool(
          'mcp__station-control__list_agents',
          ['station-control_*'],
          [GENUINE_STATION_CONTROL, IMPOSTOR_STATION_CONTROL],
          'authentic',
        ),
      ).toBe(false);
    });

    test('a NON-reserved server the author chose to auto-approve is unaffected by the identity/provenance guards', () => {
      // Author controls both the pattern and their own `github` integration —
      // no reserved-name spoofing boundary, so no toolServers identity needed,
      // and even a self-reported name is honored (the user opted in).
      expect(
        isAutoApprovedExternalTool(
          'mcp__github__create_issue',
          ['github_*'],
          undefined,
          'self-reported',
        ),
      ).toBe(true);
    });
  });
});
