import { describe, expect, test } from 'vitest';
import {
  APPROVAL_MODE_OPTIONS,
  adapterDefaultApprovalMode,
  approvalModeChipLabel,
  approvalModeDescription,
  approvalModeKnobSupported,
  approvalModeLabel,
  resolveEffectiveApprovalMode,
} from '../utils/approvalMode';

describe('approvalModeKnobSupported', () => {
  test('clean codex and claude engine identities expose the knob', () => {
    expect(approvalModeKnobSupported('codex')).toBe(true);
    expect(approvalModeKnobSupported('claude')).toBe(true);
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

describe('approvalModeLabel', () => {
  test('every option in APPROVAL_MODE_OPTIONS round-trips through its own label', () => {
    for (const option of APPROVAL_MODE_OPTIONS) {
      expect(approvalModeLabel(option.value)).toBe(option.label);
    }
  });

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
      'Agent asks at its own discretion; file writes sandboxed to the workspace.',
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

  test('ask falls back to generic copy that still claims no floor', () => {
    for (const engineId of [undefined, 'codex', 'acp']) {
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
