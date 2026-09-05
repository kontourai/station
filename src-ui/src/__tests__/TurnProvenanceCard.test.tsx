/**
 * @vitest-environment jsdom
 */

import type { TurnProvenanceEnvelope } from '@kontourai/station-contracts/turn-provenance';
import type { TurnProvenanceContextInjection } from '@kontourai/station-contracts/turn-provenance-context';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextInjectionDisclosure } from '../components/chat/ContextInjectionDisclosure';
import { TurnProvenanceCard } from '../components/chat/TurnProvenanceCard';

/**
 * Every assertion here reads the RENDERED HUMAN TEXT, not a structured
 * payload: the failure this card exists to prevent (a gap presented as a
 * zero, a success, or nothing at all) only ever shows up in what a person
 * sees.
 *
 * archive#1802 redesign: the headline is the takeaway (engine/model/cost),
 * the badge only ever names something that can differ between two answers
 * (never Station's own backlog), and the four row kinds — earned claim,
 * meaningful absence, Station's own gap, and correlation id — must be
 * checkably distinct, both in text and in class.
 */

const gap = { state: 'unavailable', reason: 'not-reported-by-engine' } as const;
const stationGap = {
  state: 'unavailable',
  reason: 'not-captured-by-station',
} as const;

function envelope(
  overrides: Partial<TurnProvenanceEnvelope> = {},
): TurnProvenanceEnvelope {
  return {
    envelopeVersion: 1,
    sessionId: 'thread-1',
    turnId: 'turn-1',
    outcome: 'completed',
    observedAt: '2026-08-01T00:00:00.000Z',
    engine: {
      state: 'observed',
      value: { provider: 'claude' },
      observedFrom: [{ eventId: 'e1', method: 'turn.completed' }],
    },
    requestedModel: gap,
    reportedModel: gap,
    tools: gap,
    usage: gap,
    routingReceipt: stationGap,
    sources: stationGap,
    trustReport: stationGap,
    ...overrides,
  };
}

function expand() {
  fireEvent.click(screen.getByRole('button'));
}

/** The rendered value sitting next to a given detail label. */
function valueFor(label: string): string {
  return screen.getByText(label).nextElementSibling?.textContent ?? '';
}

/** The Turn row's id text alone, excluding the Copy button's own label. */
function turnIdText(): string {
  const dd = screen.getByText('Turn').nextElementSibling;
  return dd?.querySelector('span')?.textContent ?? '';
}

describe('TurnProvenanceCard', () => {
  it('renders nothing when a row carries no envelope at all', () => {
    const { container } = render(<TurnProvenanceCard provenance={undefined} />);
    expect(container.innerHTML).toBe('');
  });

  // archive#1802 — the collapsed line is the whole point: a reader who never
  // expands must still learn the engine, the model, and what this turn cost.
  it('renders the earned facts on the collapsed line: engine, model, and usage', () => {
    render(
      <TurnProvenanceCard
        provenance={envelope({
          reportedModel: {
            state: 'observed',
            value: 'claude-opus-5',
            observedFrom: [{ eventId: 'e2', method: 'turn.completed' }],
          },
          usage: {
            state: 'observed',
            value: { inputTokens: 2, outputTokens: 22, totalTokens: 24 },
            observedFrom: [{ eventId: 'e3', method: 'token-usage.updated' }],
          },
        })}
      />,
    );

    const summary = screen.getByRole('button');
    // the product name people know, not Station's internal slug.
    expect(summary.textContent).toContain('Claude Code');
    expect(summary.textContent).toContain('claude-opus-5');
    // The engine's own reported total, not a rebuilt in/out sentence — see
    // headlineUsageText's docblock for why total wins over a breakdown here.
    expect(summary.textContent).toContain('24 tokens');
  });

  it('collapses to a bare label and expands on click when the row already stated everything', () => {
    render(<TurnProvenanceCard provenance={envelope()} />);

    const summary = screen.getByRole('button');
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(summary.textContent).toContain('Claude Code');
    expect(screen.queryByText('Engine')).toBeNull();

    fireEvent.click(summary);
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Engine')).toBeTruthy();
  });

  // product vocabulary up front, raw identifier still checkable.
  it('renders the engine by product name and keeps the raw slug available', () => {
    render(<TurnProvenanceCard provenance={envelope()} />);

    expect(screen.getByRole('button').getAttribute('title')).toBe(
      'Engine: claude',
    );
    expand();
    expect(valueFor('Engine')).toBe('Claude Code (claude)');
  });

  it('falls back to the raw slug for an engine with no product name yet', () => {
    render(
      <TurnProvenanceCard
        provenance={envelope({
          engine: {
            state: 'observed',
            value: { provider: 'some-new-engine' },
            observedFrom: [{ eventId: 'e1', method: 'turn.completed' }],
          },
        })}
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('some-new-engine');
    expand();
    // No invented label — the identifier is the honest answer.
    expect(valueFor('Engine')).toBe('some-new-engine');
  });

  // N6 — many cards per transcript must not share one label.
  it('labels each card with its own turn', () => {
    render(<TurnProvenanceCard provenance={envelope({ turnId: 'turn-9' })} />);
    expect(
      screen.getByLabelText('Answer provenance for turn turn-9'),
    ).toBeTruthy();
  });

  it('names the model the runtime reported over the one Station requested', () => {
    render(
      <TurnProvenanceCard
        provenance={envelope({
          requestedModel: {
            state: 'observed',
            value: 'sonnet-latest',
            observedFrom: [{ eventId: 'e2', method: 'turn.started' }],
          },
          reportedModel: {
            state: 'observed',
            value: 'sonnet-9-20260701',
            observedFrom: [{ eventId: 'e3', method: 'turn.completed' }],
          },
        })}
      />,
    );

    expect(screen.getByRole('button').textContent).toContain(
      'Claude Code · sonnet-9-20260701',
    );
    expand();
    // Both are shown, separately labelled — the disagreement is the point.
    expect(valueFor('Model requested')).toContain('sonnet-latest');
    expect(valueFor('Model reported by engine')).toContain('sonnet-9-20260701');
  });

  // archive#1802: a REQUESTED model is not a confirmed
  // report. When the engine never echoed what it actually ran, the headline
  // must not present the requested value as if it were confirmed — that is
  // indistinguishable from an earned claim once this line is "the takeaway".
  it('never presents a requested-but-unconfirmed model as the model that ran, on the headline', () => {
    render(
      <TurnProvenanceCard
        provenance={envelope({
          requestedModel: {
            state: 'observed',
            value: 'sonnet-latest',
            observedFrom: [{ eventId: 'e2', method: 'turn.started' }],
          },
          // The engine never reported back what it actually used.
          reportedModel: gap,
        })}
      />,
    );

    // The headline must not name the requested model at all — it is
    // omitted, not presented unqualified as though it were confirmed.
    expect(screen.getByRole('button').textContent).not.toContain(
      'sonnet-latest',
    );

    // The expanded detail is unaffected: both slots still render honestly,
    // separately labelled, exactly as before.
    expand();
    expect(valueFor('Model requested')).toContain('sonnet-latest');
    expect(valueFor('Model reported by engine')).toBe(
      'Not reported by this engine',
    );
  });

  // the sharp one.
  it('shows missing usage and tools as named gaps, never 0 (AC2)', () => {
    render(<TurnProvenanceCard provenance={envelope()} />);
    expand();

    const gapLabels = ['Usage', 'Tools'];
    for (const label of gapLabels) {
      expect(valueFor(label)).toMatch(
        /^Not (reported by this engine|captured by Station yet)$/,
      );
    }

    // No digit anywhere in a gap's rendered value: no `0`, no count, no
    // "1 source", nothing a reader could take for a measurement.
    expect(gapLabels.map(valueFor).join(' ')).not.toMatch(/\d/);
    expect(
      screen.getByText('Usage').closest('dl')?.textContent ?? '',
    ).not.toContain('tokens');
  });

  // #1536 B3: the no-omission rule still binds — every Station-backlog slot
  // is NAMED — but as one sentence rather than a row each repeating one fact
  // under a heading that had already said it.
  it('names every Station-backlog slot in one sentence, not a row each', () => {
    const { container } = render(
      <TurnProvenanceCard provenance={envelope()} />,
    );
    expand();

    const sentence = container.querySelector('.turn-provenance__not-captured');
    expect(sentence?.textContent).toBe(
      'Routing receipt, sources and trust report are not captured by Station yet.',
    );
    // Said once, not four times.
    expect(
      (container.textContent ?? '').split('not captured by Station yet')
        .length - 1,
    ).toBe(1);
    expect(screen.queryByText('Not yet captured by Station')).toBeNull();
  });

  it('never renders an unreported tool count as "0 tools" (AC2)', () => {
    render(<TurnProvenanceCard provenance={envelope()} />);
    expand();

    expect(valueFor('Tools')).toBe('Not reported by this engine');
    expect(screen.queryByText(/0 tools/)).toBeNull();
  });

  it('reports only the usage fields the engine actually sent', () => {
    render(
      <TurnProvenanceCard
        provenance={envelope({
          usage: {
            state: 'observed',
            value: { totalTokens: 400 },
            observedFrom: [{ eventId: 'e4', method: 'token-usage.updated' }],
          },
        })}
      />,
    );
    expand();

    const usage = valueFor('Usage');
    // archive#4196: for a provider DECLARED 'disjoint' (claude), the engine's
    // reported total is input + output by protocol — the detail row names it
    // "in+out" so it cannot contradict a cache-inclusive collapsed line.
    expect(usage).toBe('400 in+out tokens');
    // Absent input/output are simply not named — never printed as "0 in".
    // (Regex with a boundary: the label "400 in+out" itself contains the
    // substring "0 in", which is not an invented zero figure.)
    expect(usage).not.toMatch(/\b0 in\b/);
    expect(usage).not.toMatch(/\b0 out\b/);
  });

  // archive#4196: the collapsed line said "N tokens" from a total that is
  // input + output only — cache-exclusive under a cache-inclusive label,
  // right above a detail row listing thousands of cache tokens.
  it('includes cache in the collapsed-line total when the declared inclusivity backs the sum', () => {
    render(
      <TurnProvenanceCard
        provenance={envelope({
          usage: {
            state: 'observed',
            value: {
              inputTokens: 30,
              outputTokens: 100,
              totalTokens: 130,
              cacheReadTokens: 9400,
              cacheWriteTokens: 700,
            },
            observedFrom: [{ eventId: 'e4', method: 'token-usage.updated' }],
          },
        })}
      />,
    );

    const summary = screen.getByRole('button');
    // Claude is declared 'disjoint', so 130 + 9400 + 700 is an honest total —
    // rendered compact (#765 A8) with the exact figure in the tooltip.
    expect(summary.textContent).toContain('10.2k tokens');
    expect(summary.textContent).toContain('incl. context');
    expect(summary.getAttribute('title')).toContain('10,230 tokens');
    expect(summary.textContent).not.toMatch(/\b130 tokens/);

    // The detail row keeps naming the components — the headline sum does
    // not replace the checkable breakdown.
    expand();
    const usage = valueFor('Usage');
    expect(usage).toContain('9400 cache read');
    expect(usage).toContain('700 cache write');
  });

  it("keeps an 'unverified' provider's own total unsummed on the collapsed line", () => {
    render(
      <TurnProvenanceCard
        provenance={envelope({
          engine: {
            state: 'observed',
            value: { provider: 'codex' },
            observedFrom: [{ eventId: 'e1', method: 'turn.completed' }],
          },
          usage: {
            state: 'observed',
            value: {
              inputTokens: 22,
              outputTokens: 13,
              totalTokens: 35,
              cacheReadTokens: 4,
            },
            observedFrom: [{ eventId: 'e4', method: 'token-usage.updated' }],
          },
        })}
      />,
    );

    const summary = screen.getByRole('button');
    // Whether codex's cachedInputTokens is already inside inputTokens is
    // unverified, so Station must not build 35 + 4 = 39 — the provider's
    // own figure stands and the detail row discloses the cache component.
    expect(summary.textContent).toContain('35 tokens');
    expect(summary.textContent).not.toContain('39 tokens');
  });

  it('says so plainly when the engine reports usage per session, not per answer', () => {
    render(
      <TurnProvenanceCard
        provenance={envelope({
          usage: {
            state: 'unavailable',
            reason: 'reported-only-at-session-scope',
          },
        })}
      />,
    );
    expand();

    expect(valueFor('Usage')).toBe(
      'This engine reports it per session, not per answer',
    );
    expect(valueFor('Usage')).not.toMatch(/\d/);
  });

  it('names observed tools and discloses failures and omitted names', () => {
    render(
      <TurnProvenanceCard
        provenance={envelope({
          tools: {
            state: 'observed',
            value: {
              uses: [
                {
                  name: 'read_file',
                  started: 2,
                  succeeded: 2,
                  failed: 0,
                  cancelled: 0,
                },
                {
                  name: 'bash',
                  started: 1,
                  succeeded: 0,
                  failed: 1,
                  cancelled: 0,
                },
              ],
              omittedNames: 3,
            },
            observedFrom: [{ eventId: 'e5', method: 'tool.completed' }],
          },
        })}
      />,
    );
    expand();

    expect(valueFor('Tools')).toBe('read_file, bash (1 failed) — and 3 more');
  });

  // drill-down into the existing trust surface, only when a reference exists.
  it('links to the referenced trust report, naming the exact bundle', () => {
    render(
      <TurnProvenanceCard
        provenance={envelope({
          trustReport: {
            state: 'referenced',
            ref: {
              kind: 'surface-trust-bundle',
              projectSlug: 'atlas',
              bundleId: 'veritas-readiness',
            },
            observedFrom: [{ eventId: 'e6', method: 'turn.completed' }],
          },
        })}
      />,
    );
    expand();

    expect(valueFor('Trust report')).toContain('atlas / veritas-readiness');
    // the label names where the link actually lands. There is no
    // per-bundle deep link, so "Open trust report" over-promised.
    expect(
      screen
        .getByRole('link', { name: 'Open project trust panel' })
        .getAttribute('href'),
    ).toBe('/projects/atlas');
  });

  it('offers no trust drill-down when the reference is a gap', () => {
    render(<TurnProvenanceCard provenance={envelope()} />);
    expand();
    expect(
      screen.queryByRole('link', { name: 'Open project trust panel' }),
    ).toBeNull();
  });

  // a reason string from a newer Station must not render as a blank.
  it('names an unrecognized unavailable reason instead of rendering a blank', () => {
    render(
      <TurnProvenanceCard
        provenance={envelope({
          usage: {
            state: 'unavailable',
            // Shape-valid, meaning unknown to this build.
            reason: 'quantum-decoherence' as never,
          },
        })}
      />,
    );
    expand();

    expect(valueFor('Usage')).toBe(
      "Reported unavailable for a reason this version doesn't recognize",
    );
    expect(valueFor('Usage')).not.toBe('');
  });

  // a reason that collides with an Object.prototype key.
  it.each(['toString', 'constructor', 'hasOwnProperty', '__proto__'])(
    'does not render a prototype-chain value for the reason %s',
    (reason) => {
      render(
        <TurnProvenanceCard
          provenance={envelope({
            usage: { state: 'unavailable', reason: reason as never },
          })}
        />,
      );
      expand();

      expect(valueFor('Usage')).toBe(
        "Reported unavailable for a reason this version doesn't recognize",
      );
      // Never a stringified function, and never blank.
      expect(valueFor('Usage')).not.toContain('function');
      expect(valueFor('Usage')).not.toBe('');
    },
  );

  // an engine whose usage scope nobody declared.
  it('says the engine has not declared its usage scope', () => {
    render(
      <TurnProvenanceCard
        provenance={envelope({
          usage: { state: 'unavailable', reason: 'usage-scope-undeclared' },
        })}
      />,
    );
    expand();

    expect(valueFor('Usage')).toBe(
      'This engine has not declared whether its figures are per answer',
    );
    expect(valueFor('Usage')).not.toMatch(/\d/);
  });

  // archive#1423 — a reference this VIEWER may not dereference. The share
  // projection is the only producer of this reason, and the copy has to say
  // that the record exists: every other reason here means "Station has
  // nothing", and telling a share viewer that about a trust report Station
  // demonstrably holds would be false.
  it('distinguishes a viewer restriction from a Station or engine gap', () => {
    render(
      <TurnProvenanceCard
        provenance={envelope({
          trustReport: {
            state: 'unavailable',
            reason: 'restricted-for-this-viewer',
          },
        })}
      />,
    );
    expand();

    expect(valueFor('Trust report')).toBe(
      'Recorded, but this share does not authorize opening it',
    );
    expect(valueFor('Trust report')).not.toBe('Not captured by Station yet');
    expect(valueFor('Trust report')).not.toMatch(/\d/);
    // No drill-down link is offered for something the viewer may not open.
    expect(screen.queryByRole('link')).toBeNull();
  });

  // --- archive#1802: the badge is per-answer standing, not a backlog tally ---

  it('shows no badge for a healthy, unremarkable turn — even with three Station gaps present', () => {
    const { container } = render(
      <TurnProvenanceCard provenance={envelope()} />,
    );
    // The default fixture carries three `not-captured-by-station` gaps
    // (routing receipt, sources, trust report). None of them is per-answer
    // information, so none of them may produce a badge.
    expect(container.querySelector('.turn-provenance__badge')).toBeNull();
    expect(screen.queryByText(/gap/i)).toBeNull();
  });

  it('badges an aborted turn — a fact that can actually differ between answers', () => {
    render(
      <TurnProvenanceCard provenance={envelope({ outcome: 'aborted' })} />,
    );
    expect(screen.getByText('Aborted')).toBeTruthy();
  });

  it('badges a turn with failed tool calls, and never mentions Station’s own gaps in it', () => {
    const { container } = render(
      <TurnProvenanceCard
        provenance={envelope({
          tools: {
            state: 'observed',
            value: {
              uses: [
                {
                  name: 'bash',
                  started: 2,
                  succeeded: 0,
                  failed: 1,
                  cancelled: 1,
                },
              ],
              omittedNames: 0,
            },
            observedFrom: [{ eventId: 'e7', method: 'tool.completed' }],
          },
        })}
      />,
    );
    const badge = container.querySelector('.turn-provenance__badge');
    expect(badge?.textContent).toBe('2 tool issues');
    expect(badge?.textContent).not.toMatch(/captured/i);
  });

  // Review finding (archive#1802, lower-severity item, addressed alongside
  //): a tool call this turn started but never resolved is a genuine
  // per-answer anomaly by turnFindings' own stated rule, distinct from a
  // reported failure/cancellation.
  it('badges a turn with a tool call that started but never resolved', () => {
    const { container } = render(
      <TurnProvenanceCard
        provenance={envelope({
          tools: {
            state: 'observed',
            value: {
              uses: [
                {
                  name: 'bash',
                  started: 2,
                  succeeded: 1,
                  failed: 0,
                  cancelled: 0,
                },
              ],
              omittedNames: 0,
            },
            observedFrom: [{ eventId: 'e9', method: 'tool.completed' }],
          },
        })}
      />,
    );
    const badge = container.querySelector('.turn-provenance__badge');
    expect(badge?.textContent).toBe('1 tool call unresolved');
  });

  // --- archive#1802: the four row kinds must be checkably distinct ---

  it('renders an engine-didn’t-report row and a Station-hasn’t-built-it row with different classes and in different sections', () => {
    render(<TurnProvenanceCard provenance={envelope()} />);
    expand();

    // "Tools" is a meaningful absence — a property of the engine — and stays
    // in the checkable facts list.
    const toolsValue = screen.getByText('Tools').nextElementSibling;
    expect(toolsValue?.className).toContain('turn-provenance__value--absence');
    expect(toolsValue?.className).not.toContain(
      'turn-provenance__value--not-captured',
    );
    expect(toolsValue?.closest('.turn-provenance__facts--backlog')).toBeNull();

    // "Routing receipt" is Station's own gap and is demoted out of the
    // checkable facts entirely, into the collapsed backlog sentence (#1536 B3).
    expect(screen.queryByText('Routing receipt')).toBeNull();
    const backlog = screen.getByText(/Routing receipt, sources and trust/);
    expect(backlog.className).toContain('turn-provenance__not-captured');
    expect(backlog.closest('.turn-provenance__facts')).toBeNull();
  });

  it('renders an earned claim with its own class, distinct from either gap kind', () => {
    render(
      <TurnProvenanceCard
        provenance={envelope({
          usage: {
            state: 'observed',
            value: { totalTokens: 10 },
            observedFrom: [{ eventId: 'e8', method: 'token-usage.updated' }],
          },
        })}
      />,
    );
    expand();

    const usageValue = screen.getByText('Usage').nextElementSibling;
    expect(usageValue?.className).toContain('turn-provenance__value--earned');
    expect(usageValue?.className).not.toContain(
      'turn-provenance__value--absence',
    );
    expect(usageValue?.className).not.toContain(
      'turn-provenance__value--not-captured',
    );
  });

  // --- archive#1802: correlation ids are metadata, behind the disclosure ---

  it('correlates the card to its exact turn, only after expanding, under Metadata', () => {
    render(<TurnProvenanceCard provenance={envelope({ turnId: 'turn-42' })} />);

    // Collapsed: the id is nowhere on screen.
    expect(screen.queryByText('turn-42')).toBeNull();

    expand();
    expect(screen.getByText('Metadata')).toBeTruthy();
    expect(turnIdText()).toBe('turn-42');
  });

  it('copies the turn id to the clipboard and confirms the copy', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <TurnProvenanceCard provenance={envelope({ turnId: 'turn-copy-me' })} />,
    );
    expand();

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('turn-copy-me');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('does not claim a copy that the browser refused', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error('denied');
        }),
      },
    });

    render(<TurnProvenanceCard provenance={envelope({ turnId: 'turn-9' })} />);
    expand();

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(
      await screen.findByRole('button', { name: 'Copy failed' }),
    ).toBeTruthy();
  });

  // an envelope this build cannot read degrades honestly.
  //
  // The versioned-but-truncated cases are the sharp ones (MB2): the card
  // reads `slot.state` on every field, so an envelope that passes a header
  // check but is missing slots would throw on `undefined.state` and take the
  // whole chat view down through RouteViewBoundary. Each of these was a
  // crash before the guard validated every slot.
  it.each([
    ['a newer envelope version', { ...envelope(), envelopeVersion: 99 }],
    ['a truncated payload', { envelopeVersion: 1 }],
    ['a non-object payload', 'not-an-envelope'],
    ['an unexpected outcome', { ...envelope(), outcome: 'exploded' }],
    [
      'all six header fields present but every slot missing',
      {
        envelopeVersion: 1,
        sessionId: 'thread-1',
        turnId: 'turn-1',
        outcome: 'completed',
        observedAt: '2026-08-01T00:00:00.000Z',
        engine: {
          state: 'observed',
          value: { provider: 'claude' },
          observedFrom: [{ eventId: 'e1', method: 'turn.completed' }],
        },
        usage: { state: 'unavailable', reason: 'not-reported-by-engine' },
      },
    ],
    [
      'a single missing slot among otherwise valid ones',
      (() => {
        const { tools, ...rest } = envelope();
        void tools;
        return rest;
      })(),
    ],
    ['an empty engine value', { ...envelope(), engine: {} }],
    [
      'an engine slot observing nothing',
      {
        ...envelope(),
        engine: { state: 'observed', value: {}, observedFrom: [] },
      },
    ],
    [
      // archive#1456 — a slot claiming `observed` with a well-formed value but zero
      // backing pointers is a vacuous observation: a confident fact with
      // nothing behind it. This is distinct from the case above (which fails
      // on the empty engine VALUE, not the pointer list) — here the value is
      // perfectly valid and only `observedFrom` is empty.
      'an observed slot with a valid value but no observation pointers (vacuous observation)',
      {
        ...envelope(),
        engine: {
          state: 'observed',
          value: { provider: 'claude' },
          observedFrom: [],
        },
      },
    ],
    [
      'a slot with no state at all',
      { ...envelope(), requestedModel: { reason: 'not-reported-by-engine' } },
    ],
    [
      'an unavailable slot with no reason',
      { ...envelope(), sources: { state: 'unavailable' } },
    ],
    [
      'a tool summary that is not a summary',
      {
        ...envelope(),
        tools: { state: 'observed', value: { uses: 'lots' }, observedFrom: [] },
      },
    ],
  ])(
    'degrades to an honest unavailable state for %s (AC5)',
    (_label, value) => {
      render(<TurnProvenanceCard provenance={value} />);

      expect(
        screen.getByText(
          /cannot read\. Nothing about this answer is being claimed/,
        ),
      ).toBeTruthy();
      // Nothing is decoded out of it — no engine, no counts, no gap tally.
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.queryByText('Engine')).toBeNull();
      expect(screen.queryByText(/gap/)).toBeNull();
    },
  );

  it('keeps the surrounding transcript intact when the envelope is unreadable (AC5)', () => {
    render(
      <div>
        <p>The answer text.</p>
        <TurnProvenanceCard provenance={{ envelopeVersion: 99 }} />
      </div>,
    );
    expect(screen.getByText('The answer text.')).toBeTruthy();
  });

  describe('injected-context disclosure (#236 item 2)', () => {
    const stationEngine: TurnProvenanceEnvelope['engine'] = {
      state: 'observed',
      value: { provider: 'station-agent' },
      observedFrom: [{ eventId: 'e1', method: 'turn.completed' }],
    };

    it('reuses the expanded provenance surface for a real context receipt', async () => {
      render(
        <TurnProvenanceCard
          provenance={envelope({
            engine: stationEngine,
            contextInjection: {
              state: 'observed',
              value: {
                knowledge: {
                  chunkCount: 3,
                  sources: ['guide.md', 'api.md'],
                  omittedSources: 0,
                  approxTokens: 120,
                },
                guidelines: { reinforce: 2, avoid: 1, approxTokens: 40 },
              },
              observedFrom: [{ eventId: 'ec', method: 'turn.completed' }],
            },
          })}
        />,
      );
      expand();

      const contextSummary = await screen.findByRole('button', {
        name: /Injected context · 2 blocks/,
      });
      expect(contextSummary.getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByText('Project knowledge')).toBeNull();
    });

    it('states the earned fact for an observed-empty receipt', async () => {
      render(
        <TurnProvenanceCard
          provenance={envelope({
            engine: stationEngine,
            contextInjection: {
              state: 'observed',
              value: {},
              observedFrom: [{ eventId: 'ec', method: 'turn.completed' }],
            },
          })}
        />,
      );
      expand();
      await Promise.resolve();
      // An OBSERVED record with no blocks means Station composed nothing —
      // a fact the pipeline earned, distinct from the `unavailable` slot
      // that means nothing was recorded either way. Rendering nothing would
      // discard the distinction and make the two indistinguishable.
      expect(
        await screen.findByText(
          'Station composed no additional context for this turn.',
        ),
      ).toBeTruthy();
    });

    it('renders nothing at all when the receipt is unavailable', async () => {
      render(
        <TurnProvenanceCard
          provenance={envelope({
            engine: stationEngine,
            contextInjection: gap,
          })}
        />,
      );
      await Promise.resolve();
      expect(
        screen.queryByLabelText('Injected context for this turn'),
      ).toBeNull();
    });

    it('derives one row per injected block and truthfully qualifies server estimates', () => {
      render(
        <ContextInjectionDisclosure
          contextInjection={{
            knowledge: {
              chunkCount: 3,
              sources: ['guide.md', 'api.md'],
              omittedSources: 2,
              approxTokens: 121,
            },
            projectRules: { approxTokens: 15 },
            guidelines: { reinforce: 2, avoid: 1, approxTokens: 40 },
            workflowSteering: { approxTokens: 17 },
            conversationFeedback: { flaggedMessages: 1, approxTokens: 23 },
            ambient: { approxTokens: 9 },
          }}
        />,
      );

      const summary = screen.getByRole('button', {
        name: /Injected context · 6 blocks/,
      });
      expect(summary.tagName).toBe('BUTTON');
      expect(summary.getAttribute('aria-expanded')).toBe('false');
      const detailsId = summary.getAttribute('aria-controls');
      expect(detailsId).toBeTruthy();
      expect(document.getElementById(detailsId!)).toBeNull();
      expect(screen.queryByText('Project knowledge')).toBeNull();

      summary.focus();
      expect(document.activeElement).toBe(summary);
      fireEvent.click(summary);

      expect(summary.getAttribute('aria-expanded')).toBe('true');
      expect(document.getElementById(detailsId!)).toBeTruthy();
      expect(screen.getAllByRole('term')).toHaveLength(6);
      expect(screen.getByText('Project knowledge')).toBeTruthy();
      expect(screen.getByText('Project rules')).toBeTruthy();
      expect(screen.getByText('Behavior guidelines')).toBeTruthy();
      expect(screen.getByText('Workflow steering')).toBeTruthy();
      expect(screen.getByText('Conversation feedback')).toBeTruthy();
      expect(screen.getByText('Ambient context')).toBeTruthy();
      expect(
        screen.getByText('3 chunks from guide.md, api.md — and 2 more'),
      ).toBeTruthy();
      expect(screen.getByText('~121 tokens')).toBeTruthy();
      expect(screen.queryByText('121 tokens')).toBeNull();
      // Both caveats: the numbers are estimates, AND the record is not a
      // census of the whole model input. Without the second, "N blocks"
      // reads as everything Station sent.
      const qualification = screen.getByText(/Token figures are approximate/);
      expect(qualification.textContent).toContain(
        'derived from the injected text size',
      );
      expect(qualification.textContent).toContain(
        "not the agent's system prompt, its tools, or the conversation history",
      );
    });

    it('does not turn an absent size into zero or a guessed token count', () => {
      const missingSize = {
        projectRules: {},
      } as unknown as TurnProvenanceContextInjection;
      render(<ContextInjectionDisclosure contextInjection={missingSize} />);
      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('Project rules')).toBeTruthy();
      expect(screen.queryByText(/^~?\d+ tokens$/)).toBeNull();
      expect(screen.queryByText(/\b0\b/)).toBeNull();
    });

    it('closes by removing its region from the accessible tree', () => {
      render(
        <ContextInjectionDisclosure
          contextInjection={{ ambient: { approxTokens: 9 } }}
        />,
      );
      const summary = screen.getByRole('button');
      fireEvent.click(summary);
      expect(screen.getByText('Ambient context')).toBeTruthy();
      fireEvent.click(summary);
      expect(summary.getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByText('Ambient context')).toBeNull();
    });
  });

  it('shows only a consumed boundary as an exact omitted-context fact', () => {
    render(
      <TurnProvenanceCard
        provenance={envelope({
          contextBoundary: {
            state: 'observed',
            value: {
              boundaryId: 'boundary-a',
              policy: 'empty-next-cold-start',
              priorTranscriptInjected: false,
            },
            observedFrom: [{ eventId: 'terminal-a', method: 'turn.completed' }],
          },
        })}
      />,
    );
    expand();
    expect(valueFor('Conversation boundary')).toBe(
      'Prior transcript omitted from this engine context',
    );
  });
});
