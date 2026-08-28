/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import {
  STATUS_GLYPH_BY_STATE,
  StatusGlyph,
} from '../components/status/StatusGlyph';

describe('StatusGlyph', () => {
  test('pins the accessible glyph and color for every lifecycle state', () => {
    // Accessible names are the USER's vocabulary (lifecycleLabelText rule,
    // archive#1783): 'Unanswerable' is the system's internal term and must
    // never be spoken to a screen reader.
    const cases = [
      ['Needs attention', 'Needs attention', '!', 'attention'],
      ['Failed', 'Failed', '×', 'danger'],
      ['Stopped', 'Stopped', '■', 'muted'],
      ['Running', 'Running', '●', 'active'],
      ['Ready', 'Ready', '○', 'muted'],
      ['Unanswerable', "Can't answer here", '?', 'warning'],
      ['Completed', 'Completed', '✓', 'success'],
    ] as const;
    expect(Object.keys(STATUS_GLYPH_BY_STATE)).toEqual(
      cases.map(([state]) => state),
    );

    for (const [state, accessibleName, glyphText, color] of cases) {
      const rendered = render(<StatusGlyph state={state} />);
      const glyph = screen.getByRole('img', { name: accessibleName });
      expect(glyph.textContent).toBe(glyphText);
      expect(glyph.classList.contains(`status-glyph--${color}`)).toBe(true);
      expect(glyph.getAttribute('data-lifecycle-state')).toBe(state);
      rendered.unmount();
    }
  });
});
