import {
  REVIEW_EVIDENCE_OPERATOR_OPERATIONS,
  REVIEW_EVIDENCE_OPERATOR_SURFACE,
} from '@kontourai/station-contracts/review-evidence';
import { describe, expect, test } from 'vitest';
import { actionsFor } from '../help.js';

describe('independent review surface parity', () => {
  test('CLI and station-control names derive from the canonical operator contract', () => {
    expect(actionsFor('review')).toEqual([
      ...REVIEW_EVIDENCE_OPERATOR_OPERATIONS,
    ]);
    expect(
      Object.values(REVIEW_EVIDENCE_OPERATOR_SURFACE).map(({ cli }) => cli),
    ).toEqual([...REVIEW_EVIDENCE_OPERATOR_OPERATIONS]);
    expect(
      Object.values(REVIEW_EVIDENCE_OPERATOR_SURFACE).map(({ mcp }) => mcp),
    ).toEqual([
      'run_independent_review',
      'get_review_request',
      'list_review_receipts',
      'get_review_receipt',
    ]);
  });
});
