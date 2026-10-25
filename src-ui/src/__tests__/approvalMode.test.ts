import { describe, expect, test } from 'vitest';
import {
  APPROVAL_MODE_OPTIONS,
  acpApprovalFor,
  adapterDefaultApprovalMode,
  approvalModeChipLabel,
  approvalModeDescription,
  approvalModeKnobSupported,
  foldApprovalPosture,
  resolveEffectiveApprovalMode,
  sessionApprovalOverride,
} from '../utils/approvalMode';

describe('approvalModeKnobSupported', () => {
  test('clean codex, claude and muse engine identities expose the knob', () => {
    expect(approvalModeKnobSupported('codex')).toBe(true);
    expect(approvalModeKnobSupported('claude')).toBe(true);
    // #2452: `muse serve` applies the mode (muse-serve-session.ts).
    expect(approvalModeKnobSupported('muse')).toBe(true);
  });

  test('#3290: opencode, the ACP engine Station sets approval rules for, has the knob', () => {
    expect(approvalModeKnobSupported('opencode')).toBe(true);
  });

  test('acp, bedrock, ollama, station-agent, and an absent runtime have no knob', () => {
    expect(approvalModeKnobSupported('acp')).toBe(false);
    expect(approvalModeKnobSupported('bedrock-runtime')).toBe(false);
    expect(approvalModeKnobSupported('ollama-runtime')).toBe(false);
    expect(approvalModeKnobSupported('station-agent')).toBe(false);
    expect(approvalModeKnobSupported(undefined)).toBe(false);
    expect(approvalModeKnobSupported(null)).toBe(false);
  });
});

describe('adapterDefaultApprovalMode', () => {
  test('claude and codex no longer guess Ask/Never — inherit the engine config (station#1950)', () => {
    expect(adapterDefaultApprovalMode('codex')).toBeUndefined();
    expect(adapterDefaultApprovalMode('claude')).toBeUndefined();
  });

  test('no-knob or unknown runtimes have no known adapter default', () => {
    expect(adapterDefaultApprovalMode('acp')).toBeUndefined();
    expect(adapterDefaultApprovalMode(undefined)).toBeUndefined();
  });
});

describe('APPROVAL_MODE_OPTIONS copy', () => {
  test('the never option label and copy never use the word "safe" and are legible about full access', () => {
    const never = APPROVAL_MODE_OPTIONS.find(
      (option) => option.value === 'never',
    );
    expect(never?.label).toBe('Never ask (full access)');
    expect(never?.description.toLowerCase()).not.toContain('safe');
    for (const option of APPROVAL_MODE_OPTIONS) {
      expect(option.label.toLowerCase()).not.toContain('safe');
      expect(option.description.toLowerCase()).not.toContain('safe');
    }
  });
});

describe('full-access copy does not overstate what a start without a grant gets', () => {
  // Full access turns off approval prompts where the engine allows it. A
  // start that carries no full-access grant (a webhook start;
  // `approval-posture.ts` applicableMode) gets a narrower setting, and which
  // one depends on the engine and on what happens at start: Codex keeps
  // `never` inside its sandbox, Claude Code may fall back to Auto with no
  // confinement (`fallbackConfinementRecord`), and an ACP engine such as
  // OpenCode is lowered to Auto, where reads and other non-edit requests
  // follow the engine's own rules. So the copy promises none of those
  // details: not "no sandbox" (#3918 pinned the same for the Default
  // approval mode setting), not "still runs inside" confinement, and not
  // "only file edits" run on their own. Detail lives in
  // docs/guides/acp.md#which-side-decides-which-calls-ask.
  const FORBIDDEN = [/no sandbox/i, /still runs inside/i, /only file edits/i];

  test('the generic never option says a start without a grant gets a narrower setting', () => {
    const never = APPROVAL_MODE_OPTIONS.find(
      (option) => option.value === 'never',
    );
    expect(never?.description).toBe(
      'Turns off approval prompts where the engine allows it. Without a full-access grant, Station applies a narrower setting, so some actions may still ask.',
    );
  });

  test('no never description, generic or per engine, makes a forbidden promise', () => {
    const descriptions = [
      ...APPROVAL_MODE_OPTIONS.filter((o) => o.value === 'never').map(
        (o) => o.description,
      ),
      ...['codex', 'claude', 'opencode', 'acp', undefined].map((engine) =>
        approvalModeDescription('never', engine),
      ),
    ];
    for (const description of descriptions) {
      for (const pattern of FORBIDDEN) expect(description).not.toMatch(pattern);
    }
  });

  test('the OpenCode never copy is conditional on the grant', () => {
    expect(approvalModeDescription('never', 'opencode')).toBe(
      'With full access granted, permitted actions run without approval prompts. Questions, plan exits and network-host requests may still ask. Without a grant, Station applies Auto, so some actions still ask. Plan mode still blocks most edits.',
    );
  });
});

describe('approvalModeChipLabel (#1010 item 2)', () => {
  test('every mode has a chip label short enough for the pill', () => {
    for (const option of APPROVAL_MODE_OPTIONS) {
      const short = approvalModeChipLabel(option.value);
      expect(short.length).toBeGreaterThan(0);
      // "Never ask (full access) — default" was 33 characters and clipped its
      // own caret at 390px. Keep every chip label comfortably under that.
      expect(short.length).toBeLessThanOrEqual(12);
      // 'Auto' is already short enough to be its own chip label, so this is
      // "never longer than", not "always shorter than".
      expect(short.length).toBeLessThanOrEqual(option.label.length);
    }
  });

  test('the full-access mode stays legible about what it grants', () => {
    // Shortening must not launder the severity into something bland.
    expect(approvalModeChipLabel('never')).toBe('Full access');
  });

  test('chip labels are distinct so the pill is never ambiguous', () => {
    const labels = APPROVAL_MODE_OPTIONS.map((option) =>
      approvalModeChipLabel(option.value),
    );
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('approvalModeDescription', () => {
  test('auto is provider-aware: Codex mentions workspace-sandboxed writes', () => {
    expect(approvalModeDescription('auto', 'codex')).toBe(
      "Agent requests approval at its own discretion; Codex's configured reviewer may approve sandbox escalations automatically. File writes stay sandboxed to the workspace.",
    );
  });

  test('auto is provider-aware: Claude mentions auto-approved file edits', () => {
    expect(approvalModeDescription('auto', 'claude')).toBe(
      'File edits auto-approved; other actions still ask.',
    );
  });

  test('auto falls back to generic copy for an unrecognized/absent runtime', () => {
    expect(approvalModeDescription('auto', undefined)).toBe(
      'Runs some actions automatically; the exact boundary depends on the engine.',
    );
  });

  test('ask is provider-aware for Claude: names whose settings can skip an approval (#1545)', () => {
    // Station adds no approval floor over Claude's own permission flow in this
    // mode, so the copy has to say which rules can still allow a call without
    // one. Station also sets no `settingSources`, so a trusted workspace's
    // checked-in settings are among them — the copy must not narrow the claim
    // to the operator's own file, which an earlier draft did while the
    // (now-reverted) narrowing was in place.
    expect(approvalModeDescription('ask', 'claude')).toBe(
      "Claude asks before tool calls its own rules don't already allow — your Claude settings and a trusted workspace's both count.",
    );
    expect(approvalModeDescription('ask', 'claude')).not.toMatch(/every time/i);
    expect(approvalModeDescription('ask', 'claude')).not.toMatch(/only your/i);
  });

  test('Codex Ask distinguishes untrusted-command prompts from the escalation reviewer', () => {
    expect(approvalModeDescription('ask', 'codex')).toBe(
      'Codex asks about untrusted commands; its configured reviewer may approve sandbox escalations automatically.',
    );
  });

  test('ask falls back to generic copy that still claims no floor', () => {
    for (const engineId of [undefined, 'acp']) {
      expect(approvalModeDescription('ask', engineId)).toBe(
        'Asks before actions the engine does not already allow on its own.',
      );
    }
  });

  test('never is not provider-aware', () => {
    expect(approvalModeDescription('never', 'codex')).toBe(
      approvalModeDescription('never', 'claude'),
    );
  });
});

describe('resolveEffectiveApprovalMode', () => {
  test('a concrete session override wins over the Agent default and the adapter default', () => {
    expect(
      resolveEffectiveApprovalMode({
        engineConnectionId: 'codex',
        sessionOverride: 'ask',
        agentDefault: 'never',
      }),
    ).toEqual({
      mode: 'ask',
      label: 'Ask first',
      source: 'session override',
    });
  });

  test('an absent session override falls back to the Agent default, named as such', () => {
    expect(
      resolveEffectiveApprovalMode({
        engineConnectionId: 'claude',
        sessionOverride: undefined,
        agentDefault: 'never',
      }),
    ).toEqual({
      mode: 'never',
      label: 'Never ask (full access) (agent default)',
      source: 'agent default',
    });
  });

  test('an explicit connection-default session override also falls back to the Agent default', () => {
    expect(
      resolveEffectiveApprovalMode({
        engineConnectionId: 'codex',
        sessionOverride: 'connection-default',
        agentDefault: 'auto',
      }),
    ).toEqual({
      mode: 'auto',
      label: 'Auto (agent default)',
      source: 'agent default',
    });
  });

  test('a new chat’s Project layer sits below the Agent default and above the personal and Station defaults', () => {
    const projectDefault = {
      approvalMode: 'auto' as const,
      source: 'last-used' as const,
    };
    expect(
      resolveEffectiveApprovalMode({
        engineConnectionId: 'claude',
        projectDefault,
        personalDefault: 'ask',
        stationDefault: 'ask',
      }),
    ).toEqual({
      mode: 'auto',
      label: 'Auto (last used in project)',
      source: 'project last used',
    });
    expect(
      resolveEffectiveApprovalMode({
        engineConnectionId: 'claude',
        projectDefault: { approvalMode: 'ask', source: 'fixed' },
        stationDefault: 'auto',
      }),
    ).toMatchObject({ mode: 'ask', source: 'project default' });
    expect(
      resolveEffectiveApprovalMode({
        engineConnectionId: 'claude',
        agentDefault: 'ask',
        projectDefault,
      }),
    ).toMatchObject({ mode: 'ask', source: 'agent default' });
    // A Project that does not decide leaves the personal default in place.
    expect(
      resolveEffectiveApprovalMode({
        engineConnectionId: 'claude',
        projectDefault: { source: 'none', fallback: 'no-history' },
        personalDefault: 'ask',
      }),
    ).toMatchObject({ mode: 'ask', source: 'account default' });
    // An engine with no approval knob is never told a Project posture.
    expect(
      resolveEffectiveApprovalMode({
        engineConnectionId: 'ollama',
        projectDefault,
      }),
    ).toMatchObject({ mode: 'connection-default' });
  });

  test('an explicit Default pick resolves as the server does: Agent, then Station, no Project or personal layer', () => {
    expect(
      resolveEffectiveApprovalMode({
        engineConnectionId: 'claude',
        sessionOverride: 'connection-default',
        projectDefault: { approvalMode: 'auto', source: 'fixed' },
        personalDefault: 'never',
        stationDefault: 'ask',
      }),
    ).toMatchObject({ mode: 'ask', source: 'station default' });
    expect(
      resolveEffectiveApprovalMode({
        engineConnectionId: 'claude',
        sessionOverride: 'connection-default',
        projectDefaultUnavailable: true,
        agentDefault: 'auto',
      }),
    ).toMatchObject({ mode: 'auto', source: 'agent default' });
  });

  test('an unreadable Project layer says the mode is set at start instead of guessing', () => {
    expect(
      resolveEffectiveApprovalMode({
        engineConnectionId: 'claude',
        projectDefaultUnavailable: true,
        personalDefault: 'never',
        stationDefault: 'ask',
      }),
    ).toEqual({
      mode: 'connection-default',
      label: 'Set when the chat starts',
      source: 'project unavailable',
    });
    // The Agent's own default still applies first, as on the server.
    expect(
      resolveEffectiveApprovalMode({
        engineConnectionId: 'claude',
        agentDefault: 'ask',
        projectDefaultUnavailable: true,
      }),
    ).toMatchObject({ mode: 'ask', source: 'agent default' });
  });

  test('an untouched Claude or Codex connection does not invent Ask/Never (station#1950)', () => {
    expect(
      resolveEffectiveApprovalMode({ engineConnectionId: 'codex' }),
    ).toEqual({
      mode: 'connection-default',
      label: 'Connection default',
      source: 'adapter default',
    });
    expect(
      resolveEffectiveApprovalMode({ engineConnectionId: 'claude' }),
    ).toEqual({
      mode: 'connection-default',
      label: 'Connection default',
      source: 'adapter default',
    });
  });

  test('a no-knob/unrecognized runtime has no adapter default to fall back to, so it resolves to the connection-default placeholder itself', () => {
    expect(resolveEffectiveApprovalMode({})).toEqual({
      mode: 'connection-default',
      label: 'Connection default',
      source: 'adapter default',
    });
    expect(resolveEffectiveApprovalMode({ engineConnectionId: 'acp' })).toEqual(
      {
        mode: 'connection-default',
        label: 'Connection default',
        source: 'adapter default',
      },
    );
  });

  /**
   * #2144 slice 6 added `AppConfig.defaultApprovalMode` as a FOURTH layer,
   * between the Agent default and the adapter default. Each case below
   * pins one boundary of the order, and the last two pin where the Station
   * value must NOT apply.
   */
  describe('the Station default (#2144 slice 6)', () => {
    test('a session override wins over it', () => {
      expect(
        resolveEffectiveApprovalMode({
          engineConnectionId: 'codex',
          sessionOverride: 'ask',
          stationDefault: 'never',
        }),
      ).toEqual({
        mode: 'ask',
        label: 'Ask first',
        source: 'session override',
      });
    });

    test('the Agent default wins over it', () => {
      expect(
        resolveEffectiveApprovalMode({
          engineConnectionId: 'codex',
          agentDefault: 'auto',
          stationDefault: 'never',
        }),
      ).toEqual({
        mode: 'auto',
        label: 'Auto (agent default)',
        source: 'agent default',
      });
    });

    test('it wins over the adapter default when nothing above it is set', () => {
      expect(
        resolveEffectiveApprovalMode({
          engineConnectionId: 'codex',
          stationDefault: 'auto',
        }),
      ).toEqual({
        mode: 'auto',
        label: 'Auto — default',
        source: 'station default',
      });
    });

    test('an engine with no approval knob ignores it', () => {
      // `acp` is in no branch of `approvalModeKnobSupported`, so a Station
      // posture here would be a claim nothing applies.
      expect(
        resolveEffectiveApprovalMode({
          engineConnectionId: 'acp',
          stationDefault: 'never',
        }),
      ).toEqual({
        mode: 'connection-default',
        label: 'Connection default',
        source: 'adapter default',
      });
      // The same value on a supporting engine DOES resolve — without this
      // half, the assertion above would pass for a resolver that ignored the
      // Station layer entirely.
      expect(
        resolveEffectiveApprovalMode({
          engineConnectionId: 'claude',
          stationDefault: 'never',
        }).source,
      ).toBe('station default');
    });

    test('connection-default stored at Station scope states no posture', () => {
      expect(
        resolveEffectiveApprovalMode({
          engineConnectionId: 'codex',
          stationDefault: 'connection-default',
        }),
      ).toEqual({
        mode: 'connection-default',
        label: 'Connection default',
        source: 'adapter default',
      });
    });

    test('an unrecognized Station value is ignored, not surfaced as-is', () => {
      expect(
        resolveEffectiveApprovalMode({
          engineConnectionId: 'codex',
          stationDefault: 'yolo',
        }).source,
      ).toBe('adapter default');
    });
  });

  test('an unrecognized override/default value is ignored, not surfaced as-is', () => {
    expect(
      resolveEffectiveApprovalMode({
        engineConnectionId: 'codex',
        sessionOverride: 'yolo',
        agentDefault: 'also-not-real',
      }),
    ).toEqual({
      mode: 'connection-default',
      label: 'Connection default',
      source: 'adapter default',
    });
  });
});

describe('acpApprovalFor (#3290)', () => {
  test('an ACP connection that launches OpenCode is Station-governed, wherever the binary lives', () => {
    for (const command of [
      'opencode',
      '/opt/homebrew/bin/opencode',
      'C:\\Tools\\OpenCode.exe',
    ]) {
      expect(acpApprovalFor({ command, name: 'OpenCode' })).toEqual({
        control: 'station',
        engineId: 'opencode',
        engineName: 'OpenCode',
      });
    }
  });

  test('any other ACP command decides for itself, whatever the connection is called', () => {
    expect(acpApprovalFor({ command: 'kiro-cli' })).toEqual({
      control: 'engine',
      engineId: null,
    });
    expect(acpApprovalFor({ command: 'npx', name: 'opencode' })).toEqual({
      control: 'engine',
      engineId: null,
      engineName: 'opencode',
    });
  });

  test('no ACP connection is no ACP answer', () => {
    expect(acpApprovalFor(undefined)).toBeUndefined();
    expect(acpApprovalFor(null)).toBeUndefined();
  });
});

describe('a new decision clears a stale takeover failure (#3290, finding 7)', () => {
  test('a newly recorded decision (a re-pick of the same mode included) is not marked not-applied', () => {
    const failed = {
      approvalPosture: 'ask' as const,
      approvalPostureSequence: 4,
      approvalTakeoverFailed: true,
    };
    const folded = { ...failed, ...foldApprovalPosture(failed, 'auto', 5) };
    expect(sessionApprovalOverride(folded)).toEqual({
      mode: 'auto',
      state: 'requested',
    });
    // A re-pick of the same mode is a new decision too.
    const repicked = { ...failed, ...foldApprovalPosture(failed, 'ask', 6) };
    expect(sessionApprovalOverride(repicked)?.state).toBe('requested');
    // The same decision folded again keeps the failure it already had.
    expect(foldApprovalPosture(failed, 'ask', 4)).toEqual({});
  });
});

describe('sessionApprovalOverride: a pick the engine could not take (#3290)', () => {
  test('is not-applied, not requested', () => {
    expect(
      sessionApprovalOverride({
        approvalPosture: 'ask',
        approvalTakeoverFailed: true,
      }),
    ).toEqual({ mode: 'ask', state: 'not-applied' });
    expect(sessionApprovalOverride({ approvalPosture: 'ask' })).toEqual({
      mode: 'ask',
      state: 'requested',
    });
  });
});
