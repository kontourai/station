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
  test('codex defaults to never (full access) — its actual pre-#727 hardcoded behavior', () => {
    expect(adapterDefaultApprovalMode('codex')).toBe('never');
  });

  test('claude defaults to ask — its actual pre-#727 default permission mode', () => {
    expect(adapterDefaultApprovalMode('claude')).toBe('ask');
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

  test('non-auto modes are not provider-aware', () => {
    expect(approvalModeDescription('never', 'codex')).toBe(
      approvalModeDescription('never', 'claude'),
    );
  });
});

describe('resolveEffectiveApprovalMode', () => {
  test('a concrete session override wins over the connection default and the adapter default', () => {
    expect(
      resolveEffectiveApprovalMode({
        engineConnectionId: 'codex',
        sessionOverride: 'ask',
        connectionDefault: 'never',
      }),
    ).toEqual({
      mode: 'ask',
      label: 'Ask every time',
      source: 'session override',
    });
  });

  test('an absent session override falls back to the connection default, suffixed as a default', () => {
    expect(
      resolveEffectiveApprovalMode({
        engineConnectionId: 'claude',
        sessionOverride: undefined,
        connectionDefault: 'never',
      }),
    ).toEqual({
      mode: 'never',
      label: 'Never ask (full access) — default',
      source: 'connection default',
    });
  });

  test('an explicit connection-default session override also falls back to the connection default', () => {
    expect(
      resolveEffectiveApprovalMode({
        engineConnectionId: 'codex',
        sessionOverride: 'connection-default',
        connectionDefault: 'auto',
      }),
    ).toEqual({
      mode: 'auto',
      label: 'Auto — default',
      source: 'connection default',
    });
  });

  test('#727 review item 2 (CRITICAL): an untouched Codex connection reads as never/full-access, not the connection-default placeholder', () => {
    expect(
      resolveEffectiveApprovalMode({ engineConnectionId: 'codex' }),
    ).toEqual({
      mode: 'never',
      label: 'Never ask (full access) — default',
      source: 'adapter default',
    });
  });

  test('an untouched Claude connection reads as ask, not the connection-default placeholder', () => {
    expect(
      resolveEffectiveApprovalMode({ engineConnectionId: 'claude' }),
    ).toEqual({
      mode: 'ask',
      label: 'Ask every time — default',
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

  test('an unrecognized override/default value is ignored, not surfaced as-is', () => {
    expect(
      resolveEffectiveApprovalMode({
        engineConnectionId: 'codex',
        sessionOverride: 'yolo',
        connectionDefault: 'also-not-real',
      }),
    ).toEqual({
      mode: 'never',
      label: 'Never ask (full access) — default',
      source: 'adapter default',
    });
  });
});
