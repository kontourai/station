/**
 * #4518 / #4570 delta review: which errors the routes answer with the managed
 * 403. A refusal the ceiling settled is a 403 carrying its own reason; one
 * nested under an indeterminate start is not, so the caller's indeterminate
 * answer wins.
 */
import {
  MANAGED_POLICY_APPROVAL_CEILING_CODE,
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { managedApprovalCeilingFailure } from '../../routes/orchestration/approval-authority.js';
import { SessionStartIndeterminateError } from '../../services/orchestration/session-turn-boundary-binding.js';
import {
  installManagedApprovalCeiling,
  ManagedApprovalCeilingRefusedError,
  ManagedApprovalCeilingStartRefusedError,
  managedApprovalCeilingFailureBody,
} from '../managed-approval-ceiling.js';

const SUPPORT_URL = 'https://help.acme.example/station';
const REASON = 'This engine runs here without approval prompts (Auto).';

beforeEach(() => {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    supportUrl: SUPPORT_URL,
    limits: { maxApprovalMode: 'ask' },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  installManagedApprovalCeiling({
    summary: summarizeManagedPolicy(parsed.document),
  });
});
afterEach(() => installManagedApprovalCeiling(null));

describe('managedApprovalCeilingFailureBody', () => {
  test('a settled start refusal answers with its own reason and the support link', () => {
    const body = managedApprovalCeilingFailureBody(
      new Error('dispatch failed', {
        cause: new ManagedApprovalCeilingStartRefusedError(REASON),
      }),
    );
    // The wrapper carries no code, so the refusal underneath is matched.
    expect(body).toMatchObject({
      success: false,
      code: MANAGED_POLICY_APPROVAL_CEILING_CODE,
    });
    expect(body?.error).toContain(REASON);
    expect(body?.error).toContain(SUPPORT_URL);
  });

  test('a refusal with no reason answers the managed sentence itself', () => {
    expect(
      managedApprovalCeilingFailureBody(
        new ManagedApprovalCeilingRefusedError(),
      ),
    ).toEqual({
      success: false,
      code: MANAGED_POLICY_APPROVAL_CEILING_CODE,
      error: `Acme's policy manages approval modes: the broadest allowed is Ask first. For help, visit ${SUPPORT_URL}`,
    });
  });

  test('an indeterminate start wrapping the refusal is not answered as one', () => {
    const refusal = new ManagedApprovalCeilingStartRefusedError(REASON);
    expect(
      managedApprovalCeilingFailureBody(
        new SessionStartIndeterminateError(refusal),
      ),
    ).toBeUndefined();
    // Any error reached first whose metadata says indeterminate wins too.
    for (const marker of [
      { kind: 'indeterminate' },
      { failurePhase: 'indeterminate' },
      { outcome: 'indeterminate' },
    ])
      expect(
        managedApprovalCeilingFailureBody(
          Object.assign(new Error('wrapped', { cause: refusal }), marker),
        ),
      ).toBeUndefined();
    // An indeterminate error BELOW the managed refusal does not hide it.
    expect(
      managedApprovalCeilingFailureBody(
        Object.assign(
          new Error(REASON),
          { code: MANAGED_POLICY_APPROVAL_CEILING_CODE },
          { cause: new SessionStartIndeterminateError() },
        ),
      )?.code,
    ).toBe(MANAGED_POLICY_APPROVAL_CEILING_CODE);
  });

  test('an error without the managed code is not a managed refusal', () => {
    expect(
      managedApprovalCeilingFailureBody(new Error('engine went away')),
    ).toBeUndefined();
  });
});

describe('managedApprovalCeilingFailure (route helper)', () => {
  const route = (error: unknown) => {
    const app = new Hono();
    app.get(
      '/',
      (c) => managedApprovalCeilingFailure(c, error) ?? c.text('none'),
    );
    return app.request('http://station.test/');
  };

  test('answers the 403 with the reason intact, and defers to an indeterminate start', async () => {
    const refusal = new ManagedApprovalCeilingStartRefusedError(REASON);
    const refused = await route(refusal);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      success: false,
      code: MANAGED_POLICY_APPROVAL_CEILING_CODE,
      error: refusal.message,
    });
    const indeterminate = await route(
      new SessionStartIndeterminateError(refusal),
    );
    expect(indeterminate.status).toBe(200);
    expect(await indeterminate.text()).toBe('none');
  });
});
