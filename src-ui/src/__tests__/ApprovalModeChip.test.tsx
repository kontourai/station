// @vitest-environment jsdom

import { ENGINE_CAPABILITY_MATRICES } from '@kontourai/station-contracts/engine-capability-matrix';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { ApprovalModeChip } from '../components/badges/ApprovalModeChip';

/**
 * The chip's picker is a `ComposerModeSheet` (a `ResponsiveDialogSurface`) now
 * rather than a native `<select>`, so these specs drive the trigger button and
 * the sheet's `radio` rows. The archive#727 invariants they exist to pin are unchanged:
 * effective-mode resolution, the pending-apply state, and — above all — that
 * escalating to full access takes a second explicit confirmation and that
 * backing out never applies it.
 */
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      media: '',
      onchange: null,
    })),
  });
});

/** The chip trigger, whose accessible name carries the effective mode. */
function trigger() {
  return screen.getByRole('button', { name: /^Approval mode:/ });
}

/** The sheet is lazy-loaded, so its content arrives after a microtask. */
async function openSheet() {
  fireEvent.click(trigger());
  await screen.findByRole('radiogroup', { name: 'Approval mode' });
}

/**
 * An option row's accessible name is its label AND its description text, and
 * the chip's own label carries a source suffix — so every query here matches on
 * a pattern rather than an exact string.
 */
function option(name: RegExp) {
  return screen.getByRole('radio', { name });
}

describe('ApprovalModeChip', () => {
  test('projects producer matrices: ACP is partial while Station is fully bound', () => {
    const { rerender } = render(
      <ApprovalModeChip
        engineConnectionId="acp"
        toolPolicyDelivery={ENGINE_CAPABILITY_MATRICES.acp.toolPolicy}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('note').getAttribute('title')).toContain(
      'Station approvals partly apply',
    );

    rerender(
      <ApprovalModeChip
        engineConnectionId="station"
        toolPolicyDelivery={ENGINE_CAPABILITY_MATRICES.station.toolPolicy}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('note').getAttribute('title')).toContain(
      'before every tool call',
    );
  });

  test('discloses pre-tool grant delivery alongside a supported engine approval mode', () => {
    const { rerender } = render(
      <ApprovalModeChip
        engineConnectionId="claude"
        toolPolicyDelivery={ENGINE_CAPABILITY_MATRICES.claude.toolPolicy}
        sessionOverride="ask"
        onChange={vi.fn()}
      />,
    );

    const claudeChip = screen.getByRole('button', {
      name: /approval mode: ask every time\. engine approval control\. station approvals/i,
    });
    expect(claudeChip.getAttribute('title')).toContain(
      'Station approvals partly apply',
    );
    expect(claudeChip.getAttribute('title')).toContain('own approval flow');

    rerender(
      <ApprovalModeChip
        engineConnectionId="codex"
        toolPolicyDelivery={ENGINE_CAPABILITY_MATRICES.codex.toolPolicy}
        sessionOverride="ask"
        onChange={vi.fn()}
      />,
    );

    const codexChip = screen.getByRole('button', {
      name: /approval mode: ask every time\. engine approval control\. station approvals/i,
    });
    expect(codexChip.getAttribute('title')).toContain(
      'Station approvals do not apply',
    );
  });
  test('the trigger names the effective mode for a knob-supporting runtime', async () => {
    render(
      <ApprovalModeChip
        engineConnectionId="codex"
        sessionOverride={undefined}
        connectionDefault="ask"
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: /^Approval mode: Ask every time/ }),
    ).toBeTruthy();
  });

  test('the open sheet marks the effective mode as the checked option', async () => {
    render(
      <ApprovalModeChip
        engineConnectionId="codex"
        sessionOverride={undefined}
        connectionDefault="ask"
        onChange={vi.fn()}
      />,
    );

    await openSheet();
    expect(option(/^Ask every time/).getAttribute('aria-checked')).toBe('true');
    expect(option(/^Auto/).getAttribute('aria-checked')).toBe('false');
  });

  test('a session override takes priority over the connection default', async () => {
    render(
      <ApprovalModeChip
        engineConnectionId="claude"
        sessionOverride="never"
        connectionDefault="ask"
        onChange={vi.fn()}
      />,
    );

    await openSheet();
    expect(
      option(/Never ask \(full access\)/).getAttribute('aria-checked'),
    ).toBe('true');
  });

  test('an untouched Codex connection (#727 review item 2) resolves to the never/full-access default, not the connection-default placeholder', async () => {
    render(
      <ApprovalModeChip
        engineConnectionId="codex"
        sessionOverride={undefined}
        connectionDefault={undefined}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', {
        name: /^Approval mode: Never ask \(full access\) — default\./,
      }),
    ).toBeTruthy();
    await openSheet();
    expect(
      option(/Never ask \(full access\)/).getAttribute('aria-checked'),
    ).toBe('true');
  });

  test('selecting a non-escalating value emits the override immediately, with no confirm step', async () => {
    const onChange = vi.fn();
    render(
      <ApprovalModeChip
        engineConnectionId="codex"
        sessionOverride="ask"
        connectionDefault={undefined}
        onChange={onChange}
      />,
    );

    await openSheet();
    fireEvent.click(option(/^Auto/));

    expect(onChange).toHaveBeenCalledWith('auto');
// The sheet closes on a non-escalating pick.
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  test('#727 review item 3 (HIGH): escalating to never requires a second confirming click before onChange fires', async () => {
    const onChange = vi.fn();
    render(
      <ApprovalModeChip
        engineConnectionId="codex"
        sessionOverride="ask"
        connectionDefault={undefined}
        onChange={onChange}
      />,
    );

    await openSheet();
    fireEvent.click(option(/Never ask \(full access\)/));

// Picking 'never' does not apply it yet — the option list is replaced by an
// explicit confirm step.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    const confirmButton = screen.getByRole('button', {
      name: 'Enable full access',
    });

    fireEvent.click(confirmButton);
    expect(onChange).toHaveBeenCalledWith('never');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('#727 review item 3: backing out of the confirm never applies the escalation', async () => {
    const onChange = vi.fn();
    render(
      <ApprovalModeChip
        engineConnectionId="codex"
        sessionOverride="ask"
        connectionDefault={undefined}
        onChange={onChange}
      />,
    );

    await openSheet();
    fireEvent.click(option(/Never ask \(full access\)/));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onChange).not.toHaveBeenCalled();
// Back to the option list, still showing the pre-escalation value — the
// mode never silently changed.
    expect(option(/^Ask every time/).getAttribute('aria-checked')).toBe('true');
  });

  test('dismissing the sheet mid-escalation leaves the mode untouched', async () => {
    const onChange = vi.fn();
    render(
      <ApprovalModeChip
        engineConnectionId="codex"
        sessionOverride="ask"
        connectionDefault={undefined}
        onChange={onChange}
      />,
    );

    await openSheet();
    fireEvent.click(option(/Never ask \(full access\)/));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: /^Approval mode: Ask every time/ }),
    ).toBeTruthy();
  });

  test('downgrading FROM never applies immediately with no confirm step', async () => {
    const onChange = vi.fn();
    render(
      <ApprovalModeChip
        engineConnectionId="codex"
        sessionOverride="never"
        connectionDefault={undefined}
        onChange={onChange}
      />,
    );

    await openSheet();
    fireEvent.click(option(/^Ask every time/));

    expect(onChange).toHaveBeenCalledWith('ask');
  });

  test('re-affirming an already-never mode does not require confirmation', async () => {
    const onChange = vi.fn();
    render(
      <ApprovalModeChip
        engineConnectionId="codex"
        sessionOverride="never"
        connectionDefault={undefined}
        onChange={onChange}
      />,
    );

    await openSheet();
    fireEvent.click(option(/Never ask \(full access\)/));

    expect(onChange).toHaveBeenCalledWith('never');
    expect(
      screen.queryByRole('button', { name: 'Enable full access' }),
    ).toBeNull();
  });

  test('#727 review round 3, item 1 (HIGH): a confirmed never override with no confirmation yet from the adapter shows a pending state, not a plain apply', async () => {
    render(
      <ApprovalModeChip
        engineConnectionId="codex"
        sessionOverride="never"
        connectionDefault={undefined}
        lastAppliedApprovalMode="ask"
        onChange={vi.fn()}
      />,
    );

    const chip = screen.getByRole('button', {
      name: /^Approval mode: Full access · pending — takes effect next turn\./,
    });
    expect(chip.className).toContain('chat-input__approval-chip--pending');
  });

  test('with no lastAppliedApprovalMode reported at all yet, a never override is still shown as pending rather than assumed applied', async () => {
    render(
      <ApprovalModeChip
        engineConnectionId="codex"
        sessionOverride="never"
        connectionDefault={undefined}
        lastAppliedApprovalMode={undefined}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', {
        name: /^Approval mode: Full access · pending — takes effect next turn\./,
      }),
    ).toBeTruthy();
  });

  test('a turn.started confirming never clears the pending state', async () => {
    render(
      <ApprovalModeChip
        engineConnectionId="codex"
        sessionOverride="never"
        connectionDefault={undefined}
        lastAppliedApprovalMode="never"
        onChange={vi.fn()}
      />,
    );

    const chip = screen.getByRole('button', {
      name: /^Approval mode: Never ask \(full access\)\./,
    });
    expect(chip.className).not.toContain('chat-input__approval-chip--pending');
    expect(screen.queryByText(/pending next turn/)).toBeNull();
  });

  test('a rejected escalation (override reverted away from never) shows no pending state', async () => {
    render(
      <ApprovalModeChip
        engineConnectionId="codex"
        sessionOverride="ask"
        connectionDefault={undefined}
        lastAppliedApprovalMode="ask"
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByText(/pending next turn/)).toBeNull();
  });

  test('other modes never show a pending state, even with a stale lastAppliedApprovalMode', async () => {
    render(
      <ApprovalModeChip
        engineConnectionId="codex"
        sessionOverride="auto"
        connectionDefault={undefined}
        lastAppliedApprovalMode="never"
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByText(/pending next turn/)).toBeNull();
    expect(trigger().className).toContain(
      'chat-input__approval-chip--override',
    );
  });

  test('#727 review item 4: auto is provider-aware in its description, and never mentions "safe"', async () => {
    render(
      <ApprovalModeChip
        engineConnectionId="codex"
        sessionOverride="ask"
        connectionDefault={undefined}
        onChange={vi.fn()}
      />,
    );

    await openSheet();
// The description is visible text in the sheet now, not an <option> title —
// it was previously reachable only by hovering a native select option.
    const autoDescription =
      'Agent asks at its own discretion; file writes sandboxed to the workspace.';
    expect(screen.getByText(autoDescription)).toBeTruthy();
// `option` now resolves the native `<input type="radio">` itself (real
// radio semantics, archive#996) — a leaf element with no text-node
// children of its own; the visible label/description text lives in
// sibling `<span>`s inside the same `<label>` row. `.closest('label')`
// is the equivalent "same option row" scope the original `.textContent`
// check on the (then content-bearing) `<button>` was expressing.
    expect(option(/^Auto/).closest('label')?.textContent).toContain(
      autoDescription,
    );
    expect(autoDescription.toLowerCase()).not.toContain('safe');
  });

  test('renders read-only for a provider with no native approval knob', async () => {
    render(
      <ApprovalModeChip
        engineConnectionId="acp"
        sessionOverride={undefined}
        connectionDefault={undefined}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Set by engine')).toBeTruthy();
  });

  test('narrowing the visible chip does not narrow what it discloses', async () => {
// The policy half is hidden below 480px because the two labels together
// overflowed the composer row on a phone (archive#3151). That is only
// defensible while the full pairing survives in the accessible name and
// the tooltip — approvals are a security-relevant readout, and a user
// deciding whether to let an engine run unattended has to be able to
// reach "Station is not the thing governing this". So: the element may
// shrink, the disclosure may not.
    render(
      <ApprovalModeChip
        engineConnectionId="acp"
        sessionOverride={undefined}
        connectionDefault={undefined}
        toolPolicyDelivery={{
          state: 'partial',
          permissionHook: 'requestPermission',
          evidence: 'sharedStagedPolicy',
          adapterModule: 'acp-adapter',
        }}
        onChange={vi.fn()}
      />,
    );

    const chip = screen.getByRole('note');
    expect(chip.getAttribute('aria-label')).toContain(
      'Station approvals partly apply',
    );
    expect(chip.getAttribute('title')).toContain(
      'Station approvals partly apply',
    );
// The class the media query keys off has to exist, or the rule targets
// nothing and the overflow returns silently.
    expect(
      chip.querySelector('.chat-input__approval-chip-policy'),
    ).toBeTruthy();
  });

  test('renders read-only when no engineConnectionId is known at all', async () => {
    render(
      <ApprovalModeChip
        sessionOverride="ask"
        connectionDefault={undefined}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Set by engine')).toBeTruthy();
  });

/**
* archive#1010. `config.approvalMode` is a generic connection-config bag
* field with no server-side gate (nothing restricts it to the two adapters
* that read it), so a no-knob connection carrying one used to make the inert
* chip announce a governing posture — "Ask every time — default" — that the
* adapter provably ignores. An inert control asserting a security posture
* nothing enforces is worse than one asserting nothing.
*/
  test('an inert chip never reports a mode, even when the connection carries an approvalMode default', async () => {
    render(
      <ApprovalModeChip
        engineConnectionId="kiro"
        sessionOverride={undefined}
        connectionDefault="ask"
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/Ask every time/)).toBeNull();
    expect(screen.getByText('Set by engine')).toBeTruthy();
  });

  test('a session override on a no-knob engine is not reported as an applied posture', async () => {
    render(
      <ApprovalModeChip
        engineConnectionId="kiro"
        sessionOverride="never"
        connectionDefault={undefined}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByText(/Never ask/)).toBeNull();
    expect(screen.queryByText(/Full access/)).toBeNull();
    expect(screen.getByText('Set by engine')).toBeTruthy();
  });

  test('the inert chip explains why it is inert rather than leaving it a mystery', async () => {
    render(<ApprovalModeChip engineConnectionId="kiro" onChange={vi.fn()} />);

    const note = screen.getByRole('note');
    expect(note.getAttribute('title')).toContain(
      'Station cannot set approvals for this engine',
    );
    expect(note.getAttribute('aria-label')).toContain(
      'Station cannot set approvals for this engine',
    );
// Inert treatment is what makes the absence of a click safe to ship: it
// must not be a button, and it must not advertise a popup.
    expect(note.tagName).toBe('SPAN');
    expect(note.getAttribute('aria-haspopup')).toBeNull();
  });

/**
* archive#1010. The pill is ~150px of a 390px composer; the descriptive
* label clipped its own caret at that width. The short form goes in the
* pill, the full label stays on the accessible name.
*/
  test('the chip shows a short label while the accessible name keeps the full one', async () => {
    render(
      <ApprovalModeChip
        engineConnectionId="codex"
        sessionOverride="never"
        connectionDefault={undefined}
        lastAppliedApprovalMode="never"
        onChange={vi.fn()}
      />,
    );

    const chip = screen.getByRole('button', { name: /^Approval mode:/ });
    expect(chip.getAttribute('aria-label')).toContain(
      'Approval mode: Never ask (full access). Engine approval control.',
    );
    const pill = chip.querySelector('.chat-input__approval-chip-label');
    expect(pill?.textContent).toBe('Full access');
    expect(pill?.textContent).not.toContain('Never ask');
  });

  test('the default-source chip drops the redundant "— default" suffix from the pill only', async () => {
    render(
      <ApprovalModeChip
        engineConnectionId="claude"
        sessionOverride={undefined}
        connectionDefault={undefined}
        onChange={vi.fn()}
      />,
    );

    const chip = screen.getByRole('button', { name: /^Approval mode:/ });
    expect(chip.getAttribute('aria-label')).toContain(
      'Approval mode: Ask every time — default. Engine approval control.',
    );
    expect(
      chip.querySelector('.chat-input__approval-chip-label')?.textContent,
    ).toBe('Ask');
  });

// WCAG 2.5.3 Label in Name: a speech-input user says what they see, so the
// visible pill text has to appear in the accessible name. Shortening the pill
 // (archive#1010) broke this for the pending state — visible "Full access ·
// pending" was not a substring of "Never ask (full access) — pending next
// turn" — and no assertion noticed, because every test pinned one string or
// the other rather than their relationship.
  for (const [name, sessionOverride] of [
    ['default', undefined],
    ['override', 'auto'],
    ['pending', 'never'],
  ] as const) {
    test(`the ${name} chip's visible text is contained in its accessible name`, () => {
      render(
        <ApprovalModeChip
          engineConnectionId="claude"
          sessionOverride={sessionOverride}
          connectionDefault={undefined}
          onChange={vi.fn()}
        />,
      );

      const chip = screen.getByRole('button', { name: /^Approval mode:/ });
      const visible =
        chip.querySelector('.chat-input__approval-chip-label')?.textContent ??
        '';
      expect(visible.length).toBeGreaterThan(0);
      expect((chip.getAttribute('aria-label') ?? '').toLowerCase()).toContain(
        visible.toLowerCase(),
      );
    });
  }
});
