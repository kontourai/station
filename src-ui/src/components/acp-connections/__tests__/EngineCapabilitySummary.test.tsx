/** @vitest-environment jsdom */

import {
  ENGINE_CAPABILITY_MATRICES,
  UNKNOWN_EXTERNAL_ENGINE_MATRIX,
} from '@kontourai/station-contracts/engine-capability-matrix';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  deriveCapabilityChips,
  deriveGatingSummary,
  deriveToolControlSummary,
  deriveToolsOwnership,
  EngineCapabilitySummary,
} from '../EngineCapabilitySummary';

// archive#3722: every rendered word traces to a matrix cell. These
// tests read the REAL matrices, so a cell changing state changes the chips
// here too — the surface cannot drift from the delivery truth.
describe('EngineCapabilitySummary derivations', () => {
  it('chips render only cells the matrix delivers (custom engines: no prompt, no skills)', () => {
    const chips = deriveCapabilityChips(ENGINE_CAPABILITY_MATRICES.acp);
    expect(chips).toContain('Tool servers');
    expect(chips).toContain('Model selection');
    expect(chips).not.toContain('System prompt');
    expect(chips).not.toContain('Skills');
    expect(chips).not.toContain('Commands');
  });

  it('the Station engine claims Station-supplied tools; an unenumerated engine asserts NO inventory, not even existence', () => {
    expect(
      deriveToolsOwnership(ENGINE_CAPABILITY_MATRICES.station, 'Station'),
    ).toBe('Runs the tools Station supplies to the agent.');
    const external = deriveToolsOwnership(
      ENGINE_CAPABILITY_MATRICES.acp,
      'Kiro',
    );
 // archive#3728: "Runs its own built-in tools" asserted built-ins EXIST,
// which Station cannot establish for an unenumerated engine. The
// conditional form claims only the absence of an inventory.
    expect(external).toContain(
      'Station cannot enumerate any built-in tools Kiro may provide.',
    );
    expect(external).not.toContain('Runs its own built-in tools');
// archive#3726: the supply clause composes with the
// toolServers cell so the chip row and this sentence cannot diverge.
    expect(external).not.toContain('does not choose');
    expect(external).toContain(
      'Station can additionally supply the tool servers configured here.',
    );
  });

// archive#3722 audit: the documented cell answers the owner's original
// question in user words, from evidence the matrix cites.
  it('a documented toolbox names EXACTLY its audited categories — Claude Code claims no file editing (#3728 review)', () => {
    const sentence = deriveToolsOwnership(
      ENGINE_CAPABILITY_MATRICES.claude,
      'Claude Code',
    );
    expect(sentence).toContain('shell commands');
    expect(sentence).toContain('file reading');
// The cited evidence (adapter tests) observes Bash and Read only; no
// test observes a Write/Edit identity, so the cell must not claim it.
    expect(sentence).not.toContain('file editing');
    expect(sentence).not.toContain('cannot enumerate');
// Codex's evidence DOES observe fileChange→apply_patch, so its sentence
// may claim editing.
    expect(
      deriveToolsOwnership(ENGINE_CAPABILITY_MATRICES.codex, 'Codex'),
    ).toContain('file editing');
  });

  it('the control sentence earns the absolute form only where built-ins are PROVEN (#3728 review)', () => {
// Documented toolboxes: the absolute statement is supported.
    for (const matrix of [
      ENGINE_CAPABILITY_MATRICES.claude,
      ENGINE_CAPABILITY_MATRICES.codex,
    ]) {
      expect(deriveToolControlSummary(matrix)).toBe(
        'Its built-in tools cannot be switched off from Station.',
      );
    }
// Unenumerated engines: conditional wording — the absolute form would
// assert the very inventory the tools row says Station cannot establish.
    for (const matrix of [
      ENGINE_CAPABILITY_MATRICES.muse,
      ENGINE_CAPABILITY_MATRICES.acp,
    ]) {
      expect(deriveToolControlSummary(matrix)).toBe(
        'Station cannot switch off any built-in tools it may provide.',
      );
    }
// The Station engine's tools ARE the configuration; a second sentence
// would restate the ownership row.
    expect(
      deriveToolControlSummary(ENGINE_CAPABILITY_MATRICES.station),
    ).toBeNull();
  });

  it('an engine with NO tool-server delivery gets no supply clause', () => {
    const matrix = {
      ...ENGINE_CAPABILITY_MATRICES.acp,
      toolServers: { state: 'unsupported' as const },
    };
    const sentence = deriveToolsOwnership(matrix, 'Bare CLI');
    expect(sentence).toContain(
      'cannot enumerate any built-in tools Bare CLI may provide',
    );
    expect(sentence).not.toContain('additionally supply');
  });

  it('the gating row carries the tool-policy coverage limit VERBATIM — paraphrased limits get overstated', () => {
    const summary = deriveGatingSummary(ENGINE_CAPABILITY_MATRICES.acp);
    const policy = ENGINE_CAPABILITY_MATRICES.acp.toolPolicy;
    expect(policy.state).toBe('partial');
    if (policy.state === 'partial' && policy.coverageLimit) {
      expect(summary).toContain(policy.coverageLimit);
    }
    expect(summary).toContain('can require your approval');
  });

  it('the unknown-engine default matrix renders the honest floor, not a guess', () => {
    const { container } = render(
      <EngineCapabilitySummary
        matrix={UNKNOWN_EXTERNAL_ENGINE_MATRIX}
        connectionName="Mystery"
      />,
    );
    expect(container.textContent).toContain('cannot enumerate');
    expect(container.textContent).toContain(
      "does not gate this engine's tool calls",
    );
    expect(
      container.querySelectorAll('.engine-capability-summary__chip'),
    ).toHaveLength(0);
  });

// archive#3726: presence checks let swapped labels, dropped
// sentences, and stray chips survive — assert each row's COMPOSITION.
  it('each row contains exactly its own derived content', () => {
    const { container } = render(
      <EngineCapabilitySummary
        matrix={ENGINE_CAPABILITY_MATRICES.acp}
        connectionName="Kiro"
      />,
    );
    const rows = container.querySelectorAll('.engine-capability-summary__row');
    expect(rows).toHaveLength(2);
    const [canDo, gates] = Array.from(rows);

    expect(
      canDo.querySelector('.engine-capability-summary__label')?.textContent,
    ).toBe('What it can do');
    const chipTexts = Array.from(
      canDo.querySelectorAll('.engine-capability-summary__chip'),
    ).map((chip) => chip.textContent);
// Exactly the derivation's output — a stray chip rendered outside
// deriveCapabilityChips fails this.
    expect(chipTexts).toEqual(
      deriveCapabilityChips(ENGINE_CAPABILITY_MATRICES.acp),
    );
    expect(canDo.textContent).toContain(
      deriveToolsOwnership(ENGINE_CAPABILITY_MATRICES.acp, 'Kiro'),
    );

    expect(
      gates.querySelector('.engine-capability-summary__label')?.textContent,
    ).toBe('What Station gates');
    expect(gates.textContent).toContain(
      deriveGatingSummary(ENGINE_CAPABILITY_MATRICES.acp),
    );
// The gating sentence lives in ITS row, not the other.
    expect(canDo.textContent).not.toContain('approval');
    expect(
      gates.querySelectorAll('.engine-capability-summary__chip'),
    ).toHaveLength(0);
  });
});
