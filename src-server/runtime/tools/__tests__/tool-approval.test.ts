import { describe, expect, test } from 'vitest';
import {
  builtinStationControlServerPath,
  isBuiltinStationControl,
} from '../../bootstrap/station-control-runtime-env.js';
import {
  canonicalizeExternalToolName,
  isAutoApproved,
  isAutoApprovedExternalTool,
} from '../tool-approval.js';

// The genuine built-in station-control server as it appears in a resolved
// agent's toolServers (command 'node' + the exact built-in server path that
// `isBuiltinStationControl` pins on — the same identity archive#1157 uses to gate the
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

    // Reserved-built-in-name IDENTITY guard (security review, archive#1049 Q1 HIGH):
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

    // Reserved-built-in-name PROVENANCE guard (security review, archive#1049 Q1 round-2
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

    test('#2584: notify_user is granted only by exact identity: the raw built-in name, authentic, genuine server delivered', () => {
      const notify = 'mcp__station-control__notify_user';
      expect(
        isAutoApprovedExternalTool(
          notify,
          [],
          [GENUINE_STATION_CONTROL],
          'authentic',
        ),
      ).toBe(true);
      expect(
        isAutoApprovedExternalTool(
          notify,
          undefined,
          [GENUINE_STATION_CONTROL],
          'authentic',
        ),
      ).toBe(true);
      // ACP names are self-reported: never the intrinsic grant.
      expect(
        isAutoApprovedExternalTool(
          notify,
          [],
          [GENUINE_STATION_CONTROL],
          'self-reported',
        ),
      ).toBe(false);
      expect(
        isAutoApprovedExternalTool(
          notify,
          [],
          [IMPOSTOR_STATION_CONTROL],
          'authentic',
        ),
      ).toBe(false);
      // A mutating station-control tool still needs an authored pattern.
      expect(
        isAutoApprovedExternalTool(
          'mcp__station-control__delete_agent',
          [],
          [GENUINE_STATION_CONTROL],
          'authentic',
        ),
      ).toBe(false);
    });

    test('#2614: a definition with the genuine command/args but an http transport or an endpoint is not the built-in, and gets no grant', () => {
      const httpTransport = {
        ...GENUINE_STATION_CONTROL,
        transport: 'streamable-http' as const,
        endpoint: 'http://127.0.0.1:9/mcp',
      };
      const endpointOnly = {
        ...GENUINE_STATION_CONTROL,
        endpoint: 'http://127.0.0.1:9/mcp',
      };
      for (const server of [httpTransport, endpointOnly]) {
        expect(
          isBuiltinStationControl(server.id, { ...server, kind: 'mcp' }),
        ).toBe(false);
        expect(
          isAutoApprovedExternalTool(
            'mcp__station-control__notify_user',
            [],
            [server],
            'authentic',
          ),
        ).toBe(false);
        expect(
          isAutoApprovedExternalTool(
            'mcp__station-control__list_agents',
            ['station-control_*'],
            [server],
            'authentic',
          ),
        ).toBe(false);
      }
      // Control: explicit stdio is still genuine.
      expect(
        isAutoApprovedExternalTool(
          'mcp__station-control__notify_user',
          [],
          [{ ...GENUINE_STATION_CONTROL, transport: 'stdio' as const }],
          'authentic',
        ),
      ).toBe(true);
    });

    test('#2584 review: split-name impostors that canonicalize to station-control_notify_user are refused', () => {
      // Server `station-control_notify`, tool `user`: canonicalizes to
      // `station-control_notify_user`.
      const split = 'mcp__station-control_notify__user';
      const impostorServer = {
        id: 'station-control_notify',
        command: 'node',
        args: ['/tmp/station-control_notify.js'],
      };
      // ACP agent with no configuration at all.
      expect(isAutoApprovedExternalTool(split, [], [], 'self-reported')).toBe(
        false,
      );
      expect(
        isAutoApprovedExternalTool(
          'station-control_notify_user',
          [],
          [GENUINE_STATION_CONTROL],
          'self-reported',
        ),
      ).toBe(false);
      // Claude, with the genuine built-in AND the impostor delivered.
      expect(
        isAutoApprovedExternalTool(
          split,
          [],
          [GENUINE_STATION_CONTROL, impostorServer],
          'authentic',
        ),
      ).toBe(false);
    });

    test('a split name borrowing the reserved prefix (mcp__station-control_x__y) cannot dodge the reserved-server checks for an authored station-control_* pattern', () => {
      const split = 'mcp__station-control_x__y';
      const borrower = {
        id: 'station-control_x',
        command: 'node',
        args: ['/tmp/station-control_x.js'],
      };
      expect(
        isAutoApprovedExternalTool(
          split,
          ['station-control_*'],
          [GENUINE_STATION_CONTROL, borrower],
          'authentic',
        ),
      ).toBe(false);
      expect(
        isAutoApprovedExternalTool(
          split,
          ['station-control_*'],
          [GENUINE_STATION_CONTROL],
          'self-reported',
        ),
      ).toBe(false);
      // Control: the genuine name under the same pattern is still approved.
      expect(
        isAutoApprovedExternalTool(
          'mcp__station-control__list_agents',
          ['station-control_*'],
          [GENUINE_STATION_CONTROL, borrower],
          'authentic',
        ),
      ).toBe(true);
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

describe('station-browser approval (#90 N2)', () => {
  const click = 'mcp__station-browser__browser_click';
  const snapshot = 'mcp__station-browser__browser_snapshot';
  const status = 'mcp__station-browser__browser_status';

  test('a wildcard or station-* pattern never covers a tool that reads or drives a page', () => {
    for (const pattern of ['*', 'station-*', 'mcp__*', 'station-browser*']) {
      for (const tool of [click, snapshot])
        expect(
          isAutoApprovedExternalTool(tool, [pattern], [], 'authentic'),
        ).toBe(false);
    }
  });

  test('only a pattern that names station-browser itself approves it, on an authentic name, with no squatting integration', () => {
    expect(
      isAutoApprovedExternalTool(click, ['station-browser_*'], [], 'authentic'),
    ).toBe(true);
    expect(
      isAutoApprovedExternalTool(
        snapshot,
        ['station-browser_browser_snapshot'],
        [],
        'authentic',
      ),
    ).toBe(true);
    expect(
      isAutoApprovedExternalTool(
        click,
        ['mcp__station-browser__*'],
        [],
        'authentic',
      ),
    ).toBe(true);
    // An ACP self-reported name is never trusted for it.
    expect(
      isAutoApprovedExternalTool(
        click,
        ['station-browser_*'],
        [],
        'self-reported',
      ),
    ).toBe(false);
    // An authored integration reusing the id is not the built-in.
    expect(
      isAutoApprovedExternalTool(
        click,
        ['station-browser_*'],
        [{ id: 'station-browser', command: 'node', args: ['/tmp/x.js'] }],
        'authentic',
      ),
    ).toBe(false);
  });

  test('browser_status, a read of Station records, follows ordinary patterns', () => {
    expect(isAutoApprovedExternalTool(status, ['*'], [], 'authentic')).toBe(
      true,
    );
    expect(isAutoApprovedExternalTool(status, [], [], 'authentic')).toBe(false);
  });
});
