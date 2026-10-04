import {
  chmodSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  type BrokerIceAuthority,
  BrokerIceService,
  type BrokerTurnProvider,
} from '../broker-ice-service.js';
import {
  CloudflareTurnProvider,
  loadCloudflareBrokerIce,
} from '../cloudflare-turn-provider.js';

const scope = {
  stationId: 'station-12345678',
  enrollmentId: 'enroll-12345678',
  routingGeneration: 1,
};
const servers = [
  {
    urls: ['turns:turn.example:443?transport=tcp'],
    username: 'short-lived-user',
    credential: 'end-user-secret',
  },
];
const signal = () => new AbortController().signal;
const authority = (subject = 'owner-1'): BrokerIceAuthority => ({
  scope,
  subject,
  assertCurrent() {},
});

describe.runIf(process.platform !== 'win32')('bounded TURN issuer', () => {
  const makeTempDir = trackTempDirs();
  test('failed issuer attempts survive restart and enforce global and per-owner budgets', async () => {
    const root = makeTempDir('station-ice-budget-');
    const path = join(root, 'budget.sqlite');
    const provider: BrokerTurnProvider = {
      issue: vi.fn(async () => {
        throw new Error('private-upstream-error');
      }),
    };
    let service = new BrokerIceService(
      path,
      provider,
      { maxAttemptsPerDay: 2, maxAttemptsPerSubject: 1 },
      () => 1000,
    );
    try {
      await expect(service.issue(authority(), signal())).rejects.toThrow(
        'ice_unavailable',
      );
      service.close();
      service = new BrokerIceService(
        path,
        provider,
        { maxAttemptsPerDay: 2, maxAttemptsPerSubject: 1 },
        () => 1000,
      );
      await expect(service.issue(authority(), signal())).rejects.toThrow(
        'ice_issuance_limit',
      );
      await expect(
        service.issue(authority('owner-2'), signal()),
      ).rejects.toThrow('ice_unavailable');
      await expect(
        service.issue(authority('owner-3'), signal()),
      ).rejects.toThrow('ice_issuance_limit');
      expect(provider.issue).toHaveBeenCalledTimes(2);
    } finally {
      service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('seven configuration requests reuse one credential, but restart retains the issuance limit', async () => {
    const root = makeTempDir('station-ice-reuse-');
    const path = join(root, 'budget.sqlite');
    const provider: BrokerTurnProvider = { issue: vi.fn(async () => servers) };
    let current = true;
    const owner: BrokerIceAuthority = {
      ...authority(),
      assertCurrent() {
        if (!current) throw new Error('broker_credential_refused');
      },
    };
    let service = new BrokerIceService(
      path,
      provider,
      { maxAttemptsPerDay: 1 },
      () => 1000,
    );
    try {
      for (let index = 0; index < 7; index++)
        expect((await service.issue(owner, signal())).issuedAt).toBe(1000);
      expect(provider.issue).toHaveBeenCalledOnce();
      current = false;
      await expect(service.issue(owner, signal())).rejects.toThrow(
        'broker_credential_refused',
      );
      current = true;
      service.close();
      service = new BrokerIceService(
        path,
        provider,
        { maxAttemptsPerDay: 1 },
        () => 1000,
      );
      await expect(service.issue(owner, signal())).rejects.toThrow(
        'ice_issuance_limit',
      );
      expect(provider.issue).toHaveBeenCalledOnce();
    } finally {
      service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('credentials below the minimum peer lifetime are refreshed rather than reused', async () => {
    const root = makeTempDir('station-ice-refresh-');
    let now = 1000;
    const provider: BrokerTurnProvider = { issue: vi.fn(async () => servers) };
    const service = new BrokerIceService(
      join(root, 'budget.sqlite'),
      provider,
      {},
      () => now,
    );
    try {
      const first = await service.issue(authority(), signal());
      now = first.expiresAt - 119_999;
      expect((await service.issue(authority(), signal())).issuedAt).toBe(now);
      expect(provider.issue).toHaveBeenCalledTimes(2);
    } finally {
      service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('cancelled provider work retains its concurrency slot and cannot publish a late result', async () => {
    const root = makeTempDir('station-ice-cancel-');
    let complete!: (value: typeof servers) => void;
    const provider: BrokerTurnProvider = {
      issue: vi.fn(
        () =>
          new Promise<typeof servers>((resolve) => {
            complete = resolve;
          }),
      ),
    };
    const service = new BrokerIceService(
      join(root, 'budget.sqlite'),
      provider,
      { maxConcurrent: 1 },
      () => 1000,
    );
    const controller = new AbortController();
    try {
      const pending = service.issue(authority(), controller.signal);
      await Promise.resolve();
      controller.abort();
      await expect(pending).rejects.toThrow('ice_unavailable');
      await expect(
        service.issue(authority('owner-2'), signal()),
      ).rejects.toThrow('ice_issuance_limit');
      expect(provider.issue).toHaveBeenCalledOnce();
      complete(servers);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('bounds provider TTL by the native grant and checks retirement after issuance', async () => {
    const root = makeTempDir('station-ice-current-');
    let current = true;
    const provider: BrokerTurnProvider = {
      issue: vi.fn(async () => {
        current = false;
        return servers;
      }),
    };
    const service = new BrokerIceService(
      join(root, 'budget.sqlite'),
      provider,
      {},
      () => 1000,
    );
    try {
      await expect(
        service.issue(
          {
            ...authority(),
            grantExpiresAt: 181000,
            assertCurrent() {
              if (!current) throw new Error('broker_credential_refused');
            },
          },
          signal(),
        ),
      ).rejects.toThrow('broker_credential_refused');
      expect(provider.issue).toHaveBeenCalledWith(
        expect.objectContaining({ ttlSeconds: 180 }),
      );
      await expect(
        service.issue({ ...authority(), grantExpiresAt: 120999 }, signal()),
      ).rejects.toThrow('ice_authority_expiring');
      expect(provider.issue).toHaveBeenCalledOnce();
    } finally {
      service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('ledger replacement fences cached credentials and symlinks cannot select another database', async () => {
    const root = makeTempDir('station-ice-ledger-pin-');
    const path = join(root, 'budget.sqlite');
    const provider: BrokerTurnProvider = { issue: vi.fn(async () => servers) };
    const service = new BrokerIceService(path, provider, {}, () => 1000);
    try {
      await service.issue(authority(), signal());
      renameSync(path, join(root, 'retained.sqlite'));
      writeFileSync(path, 'foreign-file-unchanged', { mode: 0o600 });
      await expect(service.issue(authority(), signal())).rejects.toThrow(
        'ice_custody_refused',
      );
      expect(provider.issue).toHaveBeenCalledOnce();
      expect(readFileSync(path, 'utf8')).toBe('foreign-file-unchanged');
      const link = join(root, 'link.sqlite');
      symlinkSync(path, link);
      expect(() => new BrokerIceService(link, provider)).toThrow(
        'ice_custody_refused',
      );
      expect(readFileSync(path, 'utf8')).toBe('foreign-file-unchanged');
    } finally {
      service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('private operator configuration cannot weaken hard issuer limits', () => {
    const root = makeTempDir('station-ice-config-');
    const file = join(root, 'private.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 'station-broker-cloudflare-turn/v1',
        keyId: 'example-key',
        apiToken: 'X'.repeat(32),
        ledgerPath: join(root, 'budget.sqlite'),
        policy: {
          ttlSeconds: 600,
          maxAttemptsPerDay: 101,
          maxAttemptsPerSubject: 4,
          maxConcurrent: 4,
        },
      }),
      { mode: 0o600 },
    );
    try {
      expect(() => loadCloudflareBrokerIce(file)).toThrow('ice_policy_invalid');
      chmodSync(file, 0o644);
      expect(() => loadCloudflareBrokerIce(file)).toThrow(
        'ice_provider_config_invalid',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('Cloudflare adapter uses a fixed server endpoint, bounded TTL and only end-user TURN output', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, ...servers],
        },
        { status: 201 },
      ),
    );
    const provider = new CloudflareTurnProvider(
      'example-key',
      'X'.repeat(32),
      request,
    );
    expect(
      await provider.issue({
        ttlSeconds: 600,
        usageKey: 'a'.repeat(64),
        signal: signal(),
      }),
    ).toEqual(servers);
    expect(request).toHaveBeenCalledWith(
      'https://rtc.live.cloudflare.com/v1/turn/keys/example-key/credentials/generate-ice-servers',
      expect.objectContaining({
        redirect: 'error',
        credentials: 'omit',
        body: JSON.stringify({ ttl: 600, customIdentifier: 'a'.repeat(64) }),
      }),
    );
    expect(JSON.stringify(provider)).not.toContain('X'.repeat(32));
    request.mockImplementationOnce(
      async () => new Response('X'.repeat(16 * 1024 + 1)),
    );
    await expect(
      provider.issue({
        ttlSeconds: 600,
        usageKey: 'a'.repeat(64),
        signal: signal(),
      }),
    ).rejects.toThrow('ice_provider_response_invalid');
  });
});
