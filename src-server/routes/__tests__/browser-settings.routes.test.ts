/**
 * #90 D4: the per-Project `browserEvaluate` permission defaults OFF, and only
 * operator or Project-admin standing can change it — never a request that
 * is plainly an agent's, whatever standing that request's credential
 * carries (Station's internal token authorizes as the operator).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { BrowserProjectAuthorizer } from '../../services/browser/browser-access.js';
import { BrowserProjectSettingsStore } from '../../services/browser/browser-project-settings.js';
import { createBrowserRoutes } from '../browser.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function harness() {
  const stationHome = mkdtempSync(join(tmpdir(), 'station-browser-settings-'));
  homes.push(stationHome);
  const settings = new BrowserProjectSettingsStore(stationHome);
  const who = (request: Request) => request.headers.get('x-test-role');
  const authorizeProject: BrowserProjectAuthorizer = async (
    request,
    projectId,
  ) => {
    // The agent's internal credential authorizes as the operator, which is
    // exactly why standing alone must not decide this permission.
    if (who(request) === 'operator' || who(request) === 'agent')
      return { kind: 'operator' };
    if (who(request) === 'admin' && projectId === 'p-alpha')
      return { kind: 'project-admin', principalId: 'human:deployment:admin' };
    return undefined;
  };
  const app = createBrowserRoutes({
    registry: {} as never,
    acquisition: {} as never,
    localTargets: {} as never,
    listeners: () => ({ ports: [], hostnames: [] }) as never,
    suggestLocalTargets: async () => ({}) as never,
    authorizeProject,
    authorizeOperator: async (request) => who(request) === 'operator',
    resolveProject: (slug) =>
      slug === 'alpha' ? { id: 'p-alpha', slug: 'alpha' } : undefined,
    isRequestPrincipalCurrent: () => true,
    projectSettings: settings,
    isAgentRequest: (request) => who(request) === 'agent',
    isStationInternalRequest: () => false,
  });
  const put = (role: string, body: unknown) =>
    app.request('/projects/alpha/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-role': role },
      body: JSON.stringify(body),
    });
  return { settings, app, put, stationHome };
}

describe('browser Project settings (D4)', () => {
  test('evaluation is off by default, and an unreadable store grants nothing', async () => {
    const h = harness();
    expect(h.settings.evaluateAllowed('p-alpha')).toBe(false);
    const read = await h.app.request('/projects/alpha/settings', {
      headers: { 'x-test-role': 'admin' },
    });
    expect(await read.json()).toMatchObject({
      success: true,
      data: { browserEvaluate: false },
    });
    mkdirSync(join(h.stationHome, 'browser'), { recursive: true });
    writeFileSync(
      join(h.stationHome, 'browser', 'project-settings.json'),
      '{"version":1,"projects":{"p-alpha":{"browserEvaluate":"true"}}}',
    );
    expect(
      new BrowserProjectSettingsStore(h.stationHome).evaluateAllowed('p-alpha'),
    ).toBe(false);
  });

  test('an agent request is refused even though its credential stands as the operator', async () => {
    const h = harness();
    const response = await h.put('agent', { browserEvaluate: true });
    expect(response.status).toBe(403);
    expect(h.settings.evaluateAllowed('p-alpha')).toBe(false);
  });

  test('a contributor or stranger is refused', async () => {
    const h = harness();
    expect((await h.put('contributor', { browserEvaluate: true })).status).toBe(
      403,
    );
    expect(h.settings.evaluateAllowed('p-alpha')).toBe(false);
  });

  test('the operator or a Project admin turns it on and off, attributed', async () => {
    const h = harness();
    const on = await h.put('admin', { browserEvaluate: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({
      data: {
        browserEvaluate: true,
        updatedBy: 'principal:human:deployment:admin',
      },
    });
    expect(h.settings.evaluateAllowed('p-alpha')).toBe(true);
    // Persisted: a new store over the same home reads it back.
    expect(
      new BrowserProjectSettingsStore(h.stationHome).evaluateAllowed('p-alpha'),
    ).toBe(true);
    const off = await h.put('operator', { browserEvaluate: false });
    expect(off.status).toBe(200);
    expect(h.settings.evaluateAllowed('p-alpha')).toBe(false);
  });

  test('only a literal boolean is accepted', async () => {
    const h = harness();
    expect((await h.put('operator', { browserEvaluate: 'yes' })).status).toBe(
      400,
    );
    expect(
      (await h.put('operator', { browserEvaluate: true, extra: 1 })).status,
    ).toBe(400);
    expect(h.settings.evaluateAllowed('p-alpha')).toBe(false);
  });
});
