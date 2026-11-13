/**
 * #4828: the per-engine coverage of native web reads, as the integration
 * API serves it.
 */
import type { NativeWebReadCoverage } from '@kontourai/station-contracts/tool';
import { describe, expect, test, vi } from 'vitest';
import {
  CLAUDE_NATIVE_WEB_READ_TOOLS,
  CODEX_WEB_SEARCH_ITEM_TYPE,
} from '../../../services/plugins/native-web-read-marks.js';
import { createUntrustedContentRoutes } from '../untrusted-content-routes.js';

async function coverage(): Promise<NativeWebReadCoverage[]> {
  const app = createUntrustedContentRoutes({
    marks: () => undefined,
    authorizeOperator: vi.fn(),
    resolveRequestPrincipalId: () => undefined,
    onCleared: vi.fn(),
  });
  const response = await app.request('/untrusted-content/coverage');
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    success: boolean;
    data: { nativeWebReads: NativeWebReadCoverage[] };
  };
  expect(body.success).toBe(true);
  return body.data.nativeWebReads;
}

describe('GET /untrusted-content/coverage (#4828)', () => {
  test('lists Claude as covered by the tools its hook marks from', async () => {
    const claude = (await coverage()).find(
      (entry) => entry.engine === 'claude',
    );
    expect(claude).toMatchObject({ coverage: 'covered' });
    expect(claude?.signals.sort()).toEqual(
      [...CLAUDE_NATIVE_WEB_READ_TOOLS].sort(),
    );
    expect(claude?.signals).toEqual(
      expect.arrayContaining(['WebFetch', 'WebSearch']),
    );
  });

  test('lists Codex by the item type it marks from', async () => {
    const codex = (await coverage()).find((entry) => entry.engine === 'codex');
    expect(codex?.signals).toEqual([CODEX_WEB_SEARCH_ITEM_TYPE]);
    expect(CODEX_WEB_SEARCH_ITEM_TYPE).toBe('webSearch');
  });

  test('lists at least one engine as uncovered, with a reason, and none as safe', async () => {
    const entries = await coverage();
    const uncovered = entries.filter((entry) => entry.coverage === 'uncovered');
    expect(uncovered.length).toBeGreaterThan(0);
    for (const entry of uncovered) {
      expect(entry.signals).toEqual([]);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
    for (const entry of entries) {
      expect(['covered', 'partial', 'uncovered']).toContain(entry.coverage);
      expect(entry.reason).not.toMatch(/safe/i);
    }
    expect(new Set(entries.map((entry) => entry.engine))).toEqual(
      new Set(['station', 'claude', 'codex', 'acp', 'muse']),
    );
  });
});
