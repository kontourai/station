// @vitest-environment jsdom
/**
 * The answer's Basis chip face. Surface derives every standing and label here
 * (real `buildBasisPanelViewModel` over projections composed by Surface's own
 * composer); only the SDK read is replaced, so each case states exactly what
 * the read returned.
 */
import { buildBasisPanelViewModel } from '@kontourai/surface/basis/view';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  AnswerBasisAffordance,
  answerBasisChipCue,
} from '../AnswerBasisAffordance';
import {
  type AnswerBasisStandingFixture,
  answerBasisProjection,
} from './fixtures/answer-basis-standing';

const query = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk/answer-basis', () => ({
  useAnswerBasisQuery: query,
}));

const ANSWER = 'the answer “Here is the answer.”';

function renderChip(enabled = true) {
  const onOpen = vi.fn();
  render(
    <AnswerBasisAffordance
      sessionId="agent:1792425046978"
      turnId="turn-7"
      enabled={enabled}
      answerName={ANSWER}
      onOpen={onOpen}
    />,
  );
  return { button: screen.getByRole('button'), onOpen };
}

beforeEach(() => {
  query.mockReset();
});
afterEach(cleanup);

describe('AnswerBasisAffordance', () => {
  test('an unassessed answer stays plain "Basis" and names its standing only for assistive tech', () => {
    query.mockReturnValue({
      data: answerBasisProjection('execution-only'),
      error: null,
    });
    const { button } = renderChip();
    expect(button.textContent).toBe('Basis');
    expect(button.getAttribute('aria-label')).toBe(
      `Basis for ${ANSWER}: Unassessed`,
    );
  });

  test.each([
    ['policy-met', 'Policy met'],
    ['assessed-with-gaps', 'Assessed with gaps'],
    ['unresolved', 'Temporarily unavailable'],
  ] as const)(
    'a notable standing (%s) shows Surface’s own label',
    (standing, label) => {
      const projection = answerBasisProjection(standing);
      // The label is Surface's, not a string this package spells.
      expect(buildBasisPanelViewModel(projection).standing.label).toBe(label);
      query.mockReturnValue({ data: projection, error: null });
      const { button } = renderChip();
      expect(button.textContent).toBe(`Basis · ${label}`);
      expect(button.getAttribute('aria-label')).toBe(
        `Basis · ${label} for ${ANSWER}`,
      );
    },
  );

  test('while unread, loading or failed it stays plain and still opens', () => {
    for (const result of [
      { data: undefined, error: null },
      { data: undefined, error: new Error('private identity') },
    ]) {
      query.mockReturnValue(result);
      const { button, onOpen } = renderChip();
      expect(button.textContent).toBe('Basis');
      expect(button.getAttribute('aria-label')).toBe(`Basis for ${ANSWER}`);
      expect(document.body.textContent).not.toContain('private identity');
      fireEvent.click(button);
      expect(onOpen).toHaveBeenCalledWith(button);
      cleanup();
    }
  });

  test('reads only while enabled, and never re-reads a cached standing on its own', () => {
    query.mockReturnValue({ data: undefined, error: null });
    renderChip(false);
    expect(query).toHaveBeenLastCalledWith(
      'agent:1792425046978',
      'turn-7',
      expect.objectContaining({
        enabled: false,
        staleTime: Number.POSITIVE_INFINITY,
      }),
    );
  });

  test('the notable list is closed: an unknown code stays plain', () => {
    const fixtures: AnswerBasisStandingFixture[] = [
      'execution-only',
      'policy-met',
      'assessed-with-gaps',
      'unresolved',
    ];
    expect(
      fixtures.map((fixture) =>
        answerBasisChipCue(
          buildBasisPanelViewModel(answerBasisProjection(fixture)).standing,
        ),
      ),
    ).toEqual([
      null,
      'Policy met',
      'Assessed with gaps',
      'Temporarily unavailable',
    ]);
    expect(
      answerBasisChipCue({
        code: 'future-standing' as never,
        label: 'Future',
        description: '',
        tone: 'neutral',
        unresolvedReason: null,
      }),
    ).toBeNull();
    expect(answerBasisChipCue(null)).toBeNull();
  });
});
