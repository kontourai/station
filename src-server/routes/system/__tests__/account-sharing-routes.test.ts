import fs, { existsSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { HandoffRequestOutcome } from '../../../runtime/bootstrap/supervisor-link.js';
import { ConsentChannelService } from '../../../services/consent/consent-channel.js';
import { FeaturePreviewRegistry } from '../../../services/feature-previews/feature-preview-registry.js';
import { accountSharingOriginOptions } from '../../../services/identity/account-sharing-origins.js';
import {
  accountSharingSettingPath,
  resolveAccountSharingAtBoot,
} from '../../../services/identity/account-sharing-setting.js';
import {
  ACCOUNT_SHARING_PREVIEW_ID,
  type AccountSharingRuntimeState,
  createAccountSharingRoutes,
} from '../account-sharing-routes.js';

const makeTempDir = trackTempDirs();

const OFFERED = 'https://station.tailnet.ts.net';
const OPERATOR = 'operator';

async function harness(
  options: {
    previewOff?: boolean;
    state?: Partial<AccountSharingRuntimeState>;
    supervised?: boolean;
    handoff?: HandoffRequestOutcome;
  } = {},
) {
  const homeDirectory = makeTempDir('station-sharing-route-');
  // The real registry, persisted in this home, as runtime composition binds it.
  const registry = new FeaturePreviewRegistry(homeDirectory, {
    debug() {},
    info() {},
    warn() {},
    error() {},
  } as never);
  const preview = registry.bind({
    id: ACCOUNT_SHARING_PREVIEW_ID,
    label: 'Project sharing setting',
    description: 'Fixture definition.',
  });
  if (!options.previewOff)
    await registry.setEnabled(ACCOUNT_SHARING_PREVIEW_ID, true);
  const requestHandoff = vi.fn(
    async (): Promise<HandoffRequestOutcome> =>
      options.handoff ?? { status: 'draining' },
  );
  const consentChannel = new ConsentChannelService();
  consentChannel.markListening(3144);
  const state: AccountSharingRuntimeState = {
    lockedBy: [],
    active: {
      projectSharing: false,
      localAccounts: false,
      externalProvider: false,
    },
    ...options.state,
  };
  const app = createAccountSharingRoutes({
    homeDirectory,
    consentChannel,
    // The production wiring passes `projectMembershipAuthority(...).operator()`;
    // runtime-routes-project-guest-admin covers that seam end to end.
    requireOperator: async (request) => {
      if (request.headers.get('x-test-caller') !== OPERATOR)
        throw new Error('forbidden');
    },
    state: () => state,
    preview,
    origins: async () =>
      accountSharingOriginOptions({
        allowedOrigins: [OFFERED, 'http://192.168.1.20:3000'],
        browserOrigins: [
          OFFERED,
          'http://192.168.1.20:3000',
          'http://localhost:3141',
          'http://localhost:3000',
          'http://127.0.0.1:3141',
          'http://[::1]:3141',
        ],
        apiPort: 3141,
        uiPort: 3000,
        tailscaleServeOrigins: [],
      }),
    supervised: () => options.supervised ?? true,
    requestHandoff,
  });
  const call = (method: 'GET' | 'PUT', body?: unknown, caller = OPERATOR) =>
    app.request('/', {
      method,
      headers: {
        host: 'localhost:3141',
        'x-test-caller': caller,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
  const file = accountSharingSettingPath(homeDirectory);
  const approve = async (response: Response) => {
    expect(response.status).toBe(202);
    const { data } = await response.json();
    const id = data.confirmation.id;
    const review = consentChannel.store.renderReview(
      consentChannel.tenantId,
      id,
      'consent-session',
    );
    if (!review.ok) throw new Error(`Review failed: ${review.reason}`);
    return consentChannel.store.decide(
      consentChannel.tenantId,
      id,
      'approved',
      review.nonce,
      'consent-session',
    );
  };
  return { homeDirectory, call, approve, requestHandoff, file, state };
}
const enable = { enabled: true, publicOrigin: OFFERED };

describe('Project sharing settings route (#4305)', () => {
  test('refuses approval when deployment authority changes after review was requested', async () => {
    const h = await harness();
    const response = await h.call('PUT', enable);
    h.state.lockedBy = ['STATION_PROJECT_SHARING'];
    expect(await h.approve(response)).toMatchObject({
      ok: false,
      reason: 'target_changed',
    });
    expect(existsSync(h.file)).toBe(false);
    expect(h.requestHandoff).not.toHaveBeenCalled();
  });
  test('with the Feature Preview off, both routes refuse with the preview envelope and nothing is staged', async () => {
    const h = await harness({ previewOff: true });
    for (const response of [await h.call('GET'), await h.call('PUT', enable)]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        success: false,
        error:
          'Enable Project sharing setting in Settings → Advanced → Feature previews.',
        code: 'feature_preview_disabled',
        previewId: ACCOUNT_SHARING_PREVIEW_ID,
        settingsPath:
          '/settings?view=feature-previews&highlight=feature-previews',
      });
    }
    expect(existsSync(h.file)).toBe(false);
    expect(h.requestHandoff).not.toHaveBeenCalled();
    // A caller that is not the operator still learns only that.
    const stranger = await h.call('GET', undefined, 'paired-device');
    expect((await stranger.json()).code).toBe('operator_required');
  });

  test('the operator reads the active state, stored choice and offered origins', async () => {
    const h = await harness();
    const response = await h.call('GET');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { data } = await response.json();
    expect(data).toMatchObject({
      source: 'setting',
      lockedBy: [],
      stored: { enabled: false },
      restart: 'supervised',
    });
    expect(data.origins).toContainEqual({
      origin: 'http://192.168.1.20:3000',
      sources: ['allowed-origin'],
      unavailable: 'requires-https',
    });
  });

  test('a caller that is not the operator can neither read nor change it, and nothing is staged', async () => {
    const h = await harness();
    for (const response of [
      await h.call('GET', undefined, 'paired-device'),
      await h.call('PUT', enable, 'paired-device'),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: 'operator_required',
      });
    }
    expect(existsSync(h.file)).toBe(false);
    expect(h.requestHandoff).not.toHaveBeenCalled();
  });

  test('an origin that is not offered, or not selectable, is refused before anything is staged', async () => {
    const h = await harness();
    for (const publicOrigin of [
      'http://192.168.1.20:3000',
      'https://station.tailnet.ts.net/',
      'http://localhost:3141',
      'javascript:alert(1)',
    ]) {
      const response = await h.call('PUT', { enabled: true, publicOrigin });
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('origin_not_offered');
    }
    for (const body of [
      '{',
      { enabled: true },
      { enabled: true, publicOrigin: OFFERED, modulePath: '/srv/a.mjs' },
      { enabled: 'yes' },
      'x'.repeat(5000),
    ]) {
      const response = await h.call('PUT', body);
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('invalid_request');
    }
    expect(existsSync(h.file)).toBe(false);
    expect(h.requestHandoff).not.toHaveBeenCalled();
  });

  test('a deployment-set Station shows the lock and refuses every change', async () => {
    const h = await harness({
      state: {
        lockedBy: ['STATION_PROJECT_SHARING', 'STATION_LOCAL_ACCOUNTS'],
        active: {
          projectSharing: true,
          localAccounts: true,
          externalProvider: false,
          publicOrigin: OFFERED,
        },
      },
    });
    const read = (await (await h.call('GET')).json()).data;
    expect(read).toMatchObject({
      source: 'deployment',
      lockedBy: ['STATION_PROJECT_SHARING', 'STATION_LOCAL_ACCOUNTS'],
      origins: [],
    });
    expect(read.stored).toBeUndefined();
    for (const body of [{ enabled: false }, enable]) {
      const response = await h.call('PUT', body);
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe('set_by_deployment');
    }
    expect(existsSync(h.file)).toBe(false);
  });

  test('an unsupervised Station refuses rather than half-applying', async () => {
    const h = await harness({ supervised: false });
    const response = await h.call('PUT', enable);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('restart_unavailable');
    expect(existsSync(h.file)).toBe(false);
  });

  test('a valid change is staged, then the supervisor hands off to the generation that tries it', async () => {
    const h = await harness();
    h.requestHandoff.mockImplementationOnce(async () => {
      // Staged before the handoff is asked for: the next generation reads it.
      expect(JSON.parse(readFileSync(h.file, 'utf8')).pending).toMatchObject({
        choice: enable,
        attempted: false,
      });
      return { status: 'draining' };
    });
    const response = await h.call('PUT', enable);
    expect(existsSync(h.file)).toBe(false);
    expect(await h.approve(response)).toMatchObject({
      ok: true,
      status: 'approved',
    });
    expect(h.requestHandoff).toHaveBeenCalledTimes(1);
    expect(resolveAccountSharingAtBoot(h.homeDirectory).choice).toEqual(enable);
    // The draining generation takes no second change.
    const again = await h.call('PUT', { enabled: false });
    expect(await h.approve(again)).toMatchObject({
      ok: false,
      reason: 'commit_refused',
    });
  });

  test('a refused or unanswered handoff withdraws the staged change', async () => {
    for (const handoff of [
      { status: 'refused', reason: 'busy' },
      { status: 'rolled-back' },
      { status: 'unanswered' },
    ] as const) {
      const h = await harness({ handoff });
      const response = await h.call('PUT', enable);
      expect(await h.approve(response)).toMatchObject({
        ok: false,
        reason: 'commit_refused',
      });
      const record = JSON.parse(readFileSync(h.file, 'utf8'));
      expect(record.pending).toBeUndefined();
      expect(record.committed).toEqual({ enabled: false });
      expect(record.lastApply.outcome).toBe('withdrawn');
      // The next boot does not try it.
      expect(resolveAccountSharingAtBoot(h.homeDirectory).applying).toBe(false);
      // And the route accepts another attempt.
      expect(await h.approve(await h.call('PUT', enable))).toMatchObject({
        ok: false,
        reason: 'commit_refused',
      });
    }
  });

  test('choosing what is already active changes nothing and restarts nothing', async () => {
    const h = await harness({
      state: {
        active: {
          projectSharing: true,
          localAccounts: true,
          externalProvider: false,
          publicOrigin: OFFERED,
        },
      },
    });
    const response = await h.call('PUT', enable);
    expect((await response.json()).data).toEqual({ changed: false });
    expect(h.requestHandoff).not.toHaveBeenCalled();
    expect(existsSync(h.file)).toBe(false);
  });
});

test('a published staging write with failed directory sync is never adopted', async () => {
  const h = await harness();
  const real = fs.fsyncSync;
  const response = await h.call('PUT', enable);
  let decision: Awaited<ReturnType<typeof h.approve>>;
  try {
    fs.fsyncSync = (fd) => {
      if (fs.fstatSync(fd).isDirectory())
        throw new Error('directory sync failed');
      return real(fd);
    };
    syncBuiltinESMExports();
    decision = await h.approve(response);
  } finally {
    fs.fsyncSync = real;
    syncBuiltinESMExports();
  }
  expect(decision!).toMatchObject({ ok: false, reason: 'commit_refused' });
  expect(h.requestHandoff).not.toHaveBeenCalled();
  expect(resolveAccountSharingAtBoot(h.homeDirectory).choice).toEqual({
    enabled: false,
  });
});

test('a failed withdrawal leaves a visible unarmed choice that boot will not adopt', async () => {
  const h = await harness({ handoff: { status: 'refused', reason: 'busy' } });
  const real = fs.renameSync;
  let calls = 0;
  const response = await h.call('PUT', enable);
  let decision: Awaited<ReturnType<typeof h.approve>>;
  try {
    fs.renameSync = (...args) => {
      if (++calls === 2) throw new Error('withdrawal failed');
      return real(...args);
    };
    syncBuiltinESMExports();
    decision = await h.approve(response);
  } finally {
    fs.renameSync = real;
    syncBuiltinESMExports();
  }
  expect(decision!).toMatchObject({ ok: false, reason: 'commit_refused' });
  expect(decision!.ok ? '' : decision!.detail).toMatch(
    /pending change needs reconciliation/,
  );
  expect((await (await h.call('GET')).json()).data.pending).toEqual({
    choice: enable,
    ready: false,
  });
  expect(resolveAccountSharingAtBoot(h.homeDirectory).choice).toEqual({
    enabled: false,
  });
});

test('an indeterminate arm publication is reported as uncertain rather than failed', async () => {
  const h = await harness();
  const real = fs.fsyncSync;
  let directories = 0;
  const response = await h.call('PUT', enable);
  let decision: Awaited<ReturnType<typeof h.approve>>;
  try {
    fs.fsyncSync = (fd) => {
      if (fs.fstatSync(fd).isDirectory() && ++directories === 2)
        throw new Error('arm directory sync failed');
      return real(fd);
    };
    syncBuiltinESMExports();
    decision = await h.approve(response);
  } finally {
    fs.fsyncSync = real;
    syncBuiltinESMExports();
  }
  expect(decision!).toMatchObject({ ok: true, status: 'approved' });
  expect(resolveAccountSharingAtBoot(h.homeDirectory).choice).toEqual(enable);
});
