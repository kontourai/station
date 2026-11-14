import { describe, expect, test } from 'vitest';
import {
  DUPLICATE_REPORT_WINDOW_MS,
  focusReportFindings,
} from '../../tests/live/helpers/focus-report-budget.mjs';

const DOC = 'cf7fe06e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';
const OTHER = 'b84eb478-1f2a-4b3c-8d4e-5f6a7b8c9d0e';

/** The request the reporter sends: header and body both name the document. */
function report(document: string, state: string, seq: number, at: number) {
  return {
    at,
    headers: {
      'content-type': 'application/json',
      'x-station-client-session': document,
    },
    postData: JSON.stringify({ clientSessionId: document, state, seq }),
  };
}

describe('fresh-home walkthrough focus report count', () => {
  test('the window is the reporter’s 1 s debounce and minimum retry', () => {
    expect(DUPLICATE_REPORT_WINDOW_MS).toBe(1_000);
  });

  test('flags the three-reports-per-load defect: hidden from pagehide and again from visibilitychange', () => {
    // Timings observed on a real page load before the client fix.
    expect(
      focusReportFindings([
        report(DOC, 'focused', 1, 0),
        report(DOC, 'hidden', 2, 1_127),
        report(DOC, 'hidden', 3, 1_128),
      ]),
    ).toEqual([
      'document cf7fe06e reported hidden twice 1 ms apart (seq 2, 3)',
    ]);
  });

  test('one focused and one hidden per load passes, across many documents', () => {
    expect(
      focusReportFindings([
        report(DOC, 'focused', 1, 0),
        report(DOC, 'hidden', 2, 1_521),
        report(OTHER, 'focused', 1, 2_913),
        report(OTHER, 'hidden', 2, 4_011),
      ]),
    ).toEqual([]);
  });

  test('a retry after the 1 s floor, or hide-show-hide, is not a duplicate', () => {
    expect(
      focusReportFindings([
        report(DOC, 'focused', 1, 0),
        report(DOC, 'focused', 2, 1_000),
        report(DOC, 'hidden', 3, 1_200),
        report(DOC, 'focused', 4, 1_300),
        report(DOC, 'hidden', 5, 1_400),
      ]),
    ).toEqual([]);
  });

  test('orders by seq, not arrival, and keeps documents apart', () => {
    expect(
      focusReportFindings([
        report(DOC, 'hidden', 3, 10),
        report(OTHER, 'hidden', 1, 5),
        report(DOC, 'hidden', 2, 9),
      ]),
    ).toEqual([
      'document cf7fe06e reported hidden twice 1 ms apart (seq 2, 3)',
    ]);
  });

  test('a body it cannot read is a finding, not a silent pass', () => {
    expect(
      focusReportFindings([{ at: 0, headers: {}, postData: null }]),
    ).toEqual(['focus report with an unreadable body']);
  });
});
