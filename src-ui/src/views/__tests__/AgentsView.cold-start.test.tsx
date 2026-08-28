/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * archive#3751 — the cold-start readiness window.
 *
 * `/api/agents` serves the LAST STABLE catalog while the runtime is
 * mid-reconciliation and marks it `catalogState: 'reconciling'` (archive#1574).
 * Those rows are real, but their readiness was computed for a configuration
 * that may already be gone: an agent bound to a MISSING engine reads "Ready".
 * `isLoading` cannot see it — the bytes arrived — and the SDK used to drop the
 * flag, so nothing downstream could tell.
 *
 * What is withheld is the state WORD, not the rail. Blanking the whole pane
 * was the first cut and a live E2E caught it: a catalog that reconciles for a
 * while leaves the Agents page showing nothing, which is a bigger lie than a
 * stale badge.
 */
let reconciling = false;
vi.mock('../../contexts/AgentsContext', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../contexts/AgentsContext',
  );
  return { ...actual, useAgentCatalogReconciling: () => reconciling };
});

import { buildAgentsViewItems } from '../agent-editor/agentsViewHelpers';

/** An agent the server has NOT said anything about; `agentRunnability` reads
*  an absent `available` as runnable, which is the "provisional Ready". */
const AGENT = {
  slug: 'writer',
  name: 'Writer',
  enable: true,
} as never;

function badgeOf(readinessKnown: boolean) {
  const [item] = buildAgentsViewItems([AGENT], [], undefined, undefined, {
    readinessKnown,
  });
  render(<div data-testid="badge">{item?.badge}</div>);
  return screen.getByTestId('badge').textContent ?? '';
}

describe('the Agents rail during the cold-start readiness window', () => {
  beforeEach(() => {
    reconciling = false;
    document.body.innerHTML = '';
  });

  test('a settled catalog states the readiness', () => {
    expect(badgeOf(true)).toContain('Ready');
  });

  test('a reconciling catalog states no readiness at all', () => {
// The whole point: no state word from a projection the server has not
// recomputed for the runtime as it is now.
    expect(badgeOf(false)).not.toContain('Ready');
  });

  test('the row itself survives — the word is withheld, not the rail', () => {
    const items = buildAgentsViewItems([AGENT], [], undefined, undefined, {
      readinessKnown: false,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBe('Writer');
  });

  test('an omitted option keeps the settled behaviour', () => {
    const [withOptions] = buildAgentsViewItems(
      [AGENT],
      [],
      undefined,
      undefined,
      {},
    );
    render(<div data-testid="default">{withOptions?.badge}</div>);
    expect(screen.getByTestId('default').textContent).toContain('Ready');
  });
});
