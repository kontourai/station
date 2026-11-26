import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ApiBaseSource, ParsedCoreArgs } from '../commands/core-api.js';

// The plugin source was the fixed shared name `/tmp/demo` -- a path in a
// world-writable directory this test does not own, passed as an argument and
// asserted in a request body (#1790). `install()` does stat it
// (`install.ts:39-40`), but for an ABSOLUTE source `resolve(INVOKED_CWD, source)`
// equals `source`, so both branches of that ternary return the same string and
// the stat's result is unobservable: no file appearing at `/tmp/demo` could have
// changed these outcomes. The reason to own the path is therefore hygiene and
// consistency with the rest of the suite, not a live failure mode.
const TEST_TEMP_ROOT = mkdtempSync(join(tmpdir(), 'station-install-test-'));
const PLUGIN_SOURCE = join(TEST_TEMP_ROOT, 'demo');

afterAll(() => {
  rmSync(TEST_TEMP_ROOT, { force: true, recursive: true });
});

const authenticatedFetch = vi.hoisted(() => vi.fn());
const listPlugins = vi.hoisted(() => vi.fn());
const target = vi.hoisted(() => ({
  apiBase: 'http://127.0.0.1:3141',
  source: 'loopback' as ApiBaseSource,
  station: undefined as string | undefined,
}));

vi.mock('@kontourai/station-sdk/client', async (importOriginal) => ({
  authenticatedFetch,
  listPlugins,
  // The real class: the commands tell a deadline miss from a refused
  // connection with `instanceof` (#369).
  StationRequestTimeoutError: (
    await importOriginal<typeof import('@kontourai/station-sdk/client')>()
  ).StationRequestTimeoutError,
}));

vi.mock('../commands/core-api.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../commands/core-api.js')>();
  return {
    ...actual,
    configureApiCredential: vi.fn(),
    resolveApiBase: vi.fn(() => 'http://127.0.0.1:3141'),
    resolveApiBaseDetailed: vi.fn(() => ({ ...target })),
  };
});

const parsed: ParsedCoreArgs = {
  flags: {},
  positionals: [],
  repeatedFlags: {},
};

/**
 * The operator's answer, injected. `install` prompts through `promptYN` by
 * default, which needs a TTY; passing the answer keeps both branches — the
 * approval AND the refusal — reachable from a test.
 */
const approve = async () => true;
const decline = async () => false;

describe('plugin CLI API authority', () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
    listPlugins.mockReset();
    target.apiBase = 'http://127.0.0.1:3141';
    target.source = 'loopback';
    target.station = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  test.each(['parent', 'dependency'])(
    'refuses a preview with a missing %s permission revision before installation',
    async (missing) => {
      authenticatedFetch.mockResolvedValueOnce(
        Response.json({
          valid: true,
          manifest: { name: 'demo', version: '1' },
          components: [],
          contentDigest: 'sha256:reviewed',
          ...(missing === 'parent' ? {} : { grantRevision: 'parent-revision' }),
          permissions: { required: [], autoGranted: [], pendingConsent: [] },
          dependencies:
            missing === 'dependency'
              ? [
                  {
                    id: 'child',
                    consent: {
                      contentDigest: 'sha256:child',
                      permissions: [],
                      dependencies: [],
                      pendingConsent: [],
                    },
                  },
                ]
              : [],
        }),
      );
      const { install } = await import('../commands/install.js');
      await expect(install(PLUGIN_SOURCE, [], parsed, approve)).rejects.toThrow(
        /permission revision/,
      );
      expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    },
  );

  test('reports a stale permission decision refusal without retrying the install', async () => {
    authenticatedFetch
      .mockResolvedValueOnce(
        Response.json({
          valid: true,
          manifest: { name: 'demo', version: '1' },
          components: [],
          contentDigest: 'sha256:reviewed',
          grantRevision: 'stale-revision',
          permissions: { required: [], autoGranted: [], pendingConsent: [] },
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: 'Permission decision changed; preview again' },
          { status: 409 },
        ),
      );
    const { install } = await import('../commands/install.js');
    await expect(install(PLUGIN_SOURCE, [], parsed, approve)).rejects.toThrow(
      /Permission decision changed/,
    );
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(authenticatedFetch.mock.calls[1][1].body).consent
        .grantRevision,
    ).toBe('stale-revision');
  });

  /**
   * station#4288. The install carries the operator's decision, taken from the
   * preview it just read — so this asserts the ORDER as well as the body: a
   * preview whose values the install then echoes back. The previous version of
   * this test asserted a body with no `consent` at all, which the server now
   * refuses with a hard 400: the test was green while the command was broken
   * against a real Station.
   */
  test('previews, discloses, then installs with the approval the preview produced', async () => {
    const previewBody = {
      valid: true,
      manifest: { name: 'demo', version: '1.0.0', entrypoint: 'src/index.tsx' },
      components: [],
      conflicts: [],
      dependencies: [
        {
          id: 'shared-lib',
          status: 'will-install',
          consent: {
            permissions: ['providers.register'],
            contentDigest: 'sha256:dependency',
            registryTrustRevision: `sha256:${'e'.repeat(64)}`,
            grantRevision: 'dependency-reviewed-revision',
            dependencies: [],
            pendingConsent: [
              { permission: 'providers.register', tier: 'trusted' },
            ],
          },
        },
      ],
      contentDigest: 'sha256:reviewed',
      registryTrustRevision: `sha256:${'d'.repeat(64)}`,
      grantRevision: 'parent-reviewed-revision',
      permissions: {
        required: ['navigation.dock', 'network.fetch'],
        autoGranted: ['navigation.dock'],
        pendingConsent: [{ permission: 'network.fetch', tier: 'active' }],
      },
    };
    authenticatedFetch
      .mockResolvedValueOnce(Response.json(previewBody))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          plugin: { name: 'demo', version: '1.0.0' },
          permissions: {
            pendingConsent: [],
            dependencies: [
              {
                id: 'shared-lib',
                pendingConsent: [
                  { permission: 'providers.register', tier: 'trusted' },
                ],
              },
            ],
          },
        }),
      );
    const { install } = await import('../commands/install.js');

    await expect(
      install(PLUGIN_SOURCE, ['agent:helper'], parsed, approve),
    ).resolves.toEqual({ pluginName: 'demo', version: '1.0.0' });

    expect(authenticatedFetch.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:3141/api/plugins/preview',
      'http://127.0.0.1:3141/api/plugins/install',
    ]);
    expect(authenticatedFetch).toHaveBeenLastCalledWith(
      'http://127.0.0.1:3141/api/plugins/install',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );
    const postedBody = authenticatedFetch.mock.calls.at(-1)?.[1]?.body;
    expect(typeof postedBody).toBe('string');
    expect(JSON.parse(postedBody as string)).toEqual({
      source: PLUGIN_SOURCE,
      skip: ['agent:helper'],
      consent: {
        permissions: ['navigation.dock', 'network.fetch'],
        contentDigest: 'sha256:reviewed',
        registryTrustRevision: `sha256:${'d'.repeat(64)}`,
        grantRevision: 'parent-reviewed-revision',
        dependencies: ['shared-lib'],
        dependencyApprovals: [
          {
            id: 'shared-lib',
            permissions: ['providers.register'],
            contentDigest: 'sha256:dependency',
            registryTrustRevision: `sha256:${'e'.repeat(64)}`,
            grantRevision: 'dependency-reviewed-revision',
            dependencies: [],
          },
        ],
      },
    });

    // The disclosure the operator answered: the server's own derivation,
    // printed before the question. A prompt with nothing above it is not a
    // decision about anything.
    const printed = (
      console.log as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls
      .map((args) => String(args[0]))
      .join('\n');
    expect(printed).toContain('sha256:reviewed');
    expect(printed).toContain('network.fetch (active)');
    expect(printed).toContain('shared-lib');
    expect(printed).toContain('shared-lib requires providers.register');
    expect(printed).toContain('an in-page bundle');
    expect(printed).toContain(
      'Installed demo@1.0.0, but activation is incomplete',
    );
    expect(printed).toContain(
      'shared-lib requires host approval for providers.register',
    );
    expect(printed).toContain('Station host in the Plugins page');
    expect(printed).not.toContain('✅ Installed demo@1.0.0 through Station');
  });

  test.each([true, false])(
    'uses post-install dependency status instead of preview requirements (status available: %s)',
    async (statusAvailable) => {
      authenticatedFetch
        .mockResolvedValueOnce(
          Response.json({
            valid: true,
            manifest: { name: 'demo', version: '1.0.0' },
            components: [],
            conflicts: [],
            dependencies: [
              {
                id: 'shared-lib',
                status: 'will-install',
                consent: {
                  permissions: ['providers.register'],
                  contentDigest: 'sha256:dependency',
                  registryTrustRevision: `sha256:${'e'.repeat(64)}`,
                  grantRevision: 'dependency-reviewed-revision',
                  dependencies: [],
                  pendingConsent: [
                    { permission: 'providers.register', tier: 'trusted' },
                  ],
                },
              },
            ],
            contentDigest: 'sha256:reviewed',
            registryTrustRevision: `sha256:${'d'.repeat(64)}`,
            grantRevision: 'parent-reviewed-revision',
            permissions: {
              required: [],
              autoGranted: [],
              pendingConsent: [],
            },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            success: true,
            plugin: { name: 'demo', version: '1.0.0' },
            permissions: {
              pendingConsent: [],
              ...(statusAvailable
                ? { dependencies: [{ id: 'shared-lib', pendingConsent: [] }] }
                : {}),
            },
          }),
        );
      const { install } = await import('../commands/install.js');
      vi.mocked(console.log).mockClear();

      await install(PLUGIN_SOURCE, [], parsed, approve);

      const printed = (
        console.log as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls
        .map((args) => String(args[0]))
        .join('\n');
      if (statusAvailable)
        expect(printed).toContain('✅ Installed demo@1.0.0 through Station');
      else {
        expect(printed).toContain(
          'did not report current dependency approval status',
        );
        expect(printed).not.toContain('✅ Installed');
      }
      expect(printed).not.toContain('activation is incomplete');
      expect(printed).not.toContain(
        'requires host approval for providers.register',
      );
    },
  );

  /**
   * The refusal path, executable. A gate whose rejection branch never runs is
   * unproven — and this branch is the whole reason the command is safe to run
   * from a script.
   */
  test('refuses to install when nothing approved the disclosure, without sending the install', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      Response.json({
        valid: true,
        manifest: { name: 'demo', version: '1.0.0' },
        components: [],
        conflicts: [],
        contentDigest: 'sha256:reviewed',
        registryTrustRevision: `sha256:${'d'.repeat(64)}`,
        grantRevision: 'parent-reviewed-revision',
        permissions: {
          required: ['network.fetch'],
          autoGranted: [],
          pendingConsent: [{ permission: 'network.fetch', tier: 'active' }],
        },
      }),
    );
    const { install } = await import('../commands/install.js');

    await expect(install(PLUGIN_SOURCE, [], parsed, decline)).rejects.toThrow(
      'Not installed: the install was not approved. Nothing was added or changed.',
    );
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(authenticatedFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3141/api/plugins/preview',
      expect.anything(),
    );
  });

  /**
   * A Station too old to report a basis cannot be installed against: the CLI
   * has nothing to disclose and nothing to bind, and inventing either is the
   * defect this whole gate exists to prevent.
   */
  /**
   * The other half of the refusal: no `--yes`, and no terminal to ask. This is
   * the shape a CI job or a script has, and assuming approval for it is
   * precisely the "consent nobody gave" the gate exists to stop.
   */
  test('refuses a non-interactive install that did not pass --yes', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      Response.json({
        valid: true,
        manifest: { name: 'demo', version: '1.0.0' },
        components: [],
        conflicts: [],
        contentDigest: 'sha256:reviewed',
        registryTrustRevision: `sha256:${'d'.repeat(64)}`,
        grantRevision: 'parent-reviewed-revision',
        permissions: { required: [], autoGranted: [], pendingConsent: [] },
      }),
    );
    const { install } = await import('../commands/install.js');

    await expect(install(PLUGIN_SOURCE, [], parsed, null)).rejects.toThrow(
      'there is no terminal to ask',
    );
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  test('installs non-interactively when --yes approved the disclosure', async () => {
    authenticatedFetch
      .mockResolvedValueOnce(
        Response.json({
          valid: true,
          manifest: { name: 'demo', version: '1.0.0' },
          components: [],
          conflicts: [],
          contentDigest: 'sha256:reviewed',
          registryTrustRevision: `sha256:${'d'.repeat(64)}`,
          grantRevision: 'parent-reviewed-revision',
          permissions: { required: [], autoGranted: [], pendingConsent: [] },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          plugin: { name: 'demo', version: '1.0.0' },
        }),
      );
    const { install } = await import('../commands/install.js');

    await expect(
      install(PLUGIN_SOURCE, [], { ...parsed, flags: { yes: true } }, null),
    ).resolves.toEqual({ pluginName: 'demo', version: '1.0.0' });
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
  });

  test('reports an install saved without completing its activation as installed but not active, not as a failed request', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    authenticatedFetch
      .mockResolvedValueOnce(
        Response.json({
          valid: true,
          manifest: { name: 'demo', version: '1.0.0' },
          components: [],
          conflicts: [],
          contentDigest: 'sha256:reviewed',
          grantRevision: 'parent-reviewed-revision',
          permissions: {
            required: ['plugin.server'],
            autoGranted: [],
            pendingConsent: [{ permission: 'plugin.server', tier: 'trusted' }],
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            success: false,
            plugin: { name: 'demo', version: '1.0.0' },
            permissions: {
              pendingConsent: [
                { permission: 'plugin.server', tier: 'trusted' },
              ],
            },
            configurationActivation: {
              status: 'pending',
              recovery: 'required',
              reason: 'saved',
            },
          },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ success: false }, { status: 202 }),
      );
    const { install, installRegistryPlugin } = await import(
      '../commands/install.js'
    );

    await expect(
      install(PLUGIN_SOURCE, [], { ...parsed, flags: { yes: true } }, null),
    ).resolves.toEqual({ pluginName: 'demo', version: '1.0.0' });
    const printed = log.mock.calls.map((call) => String(call[0]));
    expect(printed).toContain(
      '⚠️ Installed demo@1.0.0, but its activation did not finish, so it is not active.',
    );
    // Not the host-approval list: that review refuses an inactive plugin.
    expect(printed.join('\n')).not.toContain('requires host approval');
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    // Installed but not active is not a success a script should continue
    // from (the CLI's distinct-outcome precedent).
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;

    // A 202 that does not say pending is still a refusal.
    await expect(installRegistryPlugin('curated-demo', parsed)).rejects.toThrow(
      'Registry install failed with HTTP 202',
    );
  });

  test('an older server that sends no recovery field defers to the plugin row and does not exit 2', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.exitCode = undefined;
    authenticatedFetch
      .mockResolvedValueOnce(
        Response.json({
          valid: true,
          manifest: { name: 'demo', version: '1.0.0' },
          components: [],
          conflicts: [],
          contentDigest: 'sha256:reviewed',
          grantRevision: 'parent-reviewed-revision',
          permissions: { required: [], autoGranted: [], pendingConsent: [] },
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            success: false,
            plugin: { name: 'demo', version: '1.0.0' },
            configurationActivation: { status: 'pending', reason: 'saved' },
          },
          { status: 202 },
        ),
      );
    const { install } = await import('../commands/install.js');

    await install(PLUGIN_SOURCE, [], { ...parsed, flags: { yes: true } }, null);
    const printed = log.mock.calls.map((call) => String(call[0]));
    expect(printed).toContain(
      '⚠️ Installed demo@1.0.0, but Station did not say whether it is active.',
    );
    // Nothing known says the plugin is inactive, so nothing is a failure.
    expect(process.exitCode).toBeUndefined();
  });

  test('reports a saved update by its recovery field and a saved removal as removed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const saved = {
      success: false,
      plugin: { name: 'demo', version: '1.1.0' },
      configurationActivation: {
        status: 'pending',
        recovery: 'required',
        deadlineMs: 10_000,
        reason: 'saved',
      },
    };
    const finishing = {
      ...saved,
      configurationActivation: { status: 'pending', recovery: 'none' },
    };
    authenticatedFetch
      .mockResolvedValueOnce(Response.json(saved, { status: 202 }))
      .mockResolvedValueOnce(Response.json(finishing, { status: 202 }))
      .mockResolvedValueOnce(Response.json(finishing, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({ success: false }, { status: 202 }),
      );
    const { update, remove } = await import('../commands/install.js');

    await update('demo', parsed);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await update('demo', parsed);
    await remove('demo', parsed);
    // Finishing on its own, and a saved removal, are successes.
    expect(process.exitCode).toBeUndefined();
    const printed = log.mock.calls.map((call) => String(call[0]));
    expect(printed).toContain(
      '⚠️ Updated demo@1.1.0, but its activation did not finish within 10 seconds, so it is not active.',
    );
    // A legacy update the server says finishes on its own is not a recovery.
    expect(printed).toContain(
      '✅ Updated demo@1.1.0 through Station; it finishes applying in the background.',
    );
    expect(printed).toContain(
      '✅ Removed demo through Station; it finishes unloading in the background',
    );
    await expect(remove('demo', parsed)).rejects.toThrow(
      'Plugin request failed with HTTP 202',
    );
  });

  test('refuses to install another copy of a plugin that is installed but not active, unless --reinstall', async () => {
    const preview = {
      valid: true,
      manifest: { name: 'demo', version: '1.0.0' },
      components: [],
      conflicts: [],
      contentDigest: 'sha256:reviewed',
      grantRevision: 'parent-reviewed-revision',
      permissions: { required: [], autoGranted: [], pendingConsent: [] },
    };
    listPlugins.mockResolvedValue([
      {
        name: 'demo',
        version: '1.0.0',
        installationReadiness: { state: 'pending', recovery: 'review' },
      },
    ]);
    authenticatedFetch.mockImplementation(async () => Response.json(preview));
    const { install } = await import('../commands/install.js');

    await expect(
      install(PLUGIN_SOURCE, [], { ...parsed, flags: { yes: true } }, null),
    ).rejects.toThrow(
      'demo is already installed but not active. Run `station plugin recover demo` to activate it, or pass --reinstall to install another copy of its code. Nothing was installed.',
    );
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);

    authenticatedFetch
      .mockReset()
      .mockResolvedValueOnce(Response.json(preview))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          plugin: { name: 'demo', version: '1.0.0' },
        }),
      );
    await expect(
      install(
        PLUGIN_SOURCE,
        [],
        { ...parsed, flags: { yes: true, reinstall: true } },
        null,
      ),
    ).resolves.toEqual({ pluginName: 'demo', version: '1.0.0' });
  });

  test('does not call an activating plugin stopped: no Recover advice and no second install, unless --reinstall', async () => {
    const preview = {
      valid: true,
      manifest: { name: 'demo', version: '1.0.0' },
      components: [],
      conflicts: [],
      contentDigest: 'sha256:reviewed',
      grantRevision: 'parent-reviewed-revision',
      permissions: { required: [], autoGranted: [], pendingConsent: [] },
    };
    listPlugins.mockResolvedValue([
      {
        name: 'demo',
        version: '1.0.0',
        installationReadiness: { state: 'pending', recovery: 'review' },
        activationInFlight: true,
      },
    ]);
    authenticatedFetch.mockImplementation(async () => Response.json(preview));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    log.mockClear();
    const { install } = await import('../commands/install.js');

    await expect(
      install(PLUGIN_SOURCE, [], { ...parsed, flags: { yes: true } }, null),
    ).resolves.toEqual({ pluginName: 'demo', version: '1.0.0' });
    const printed = log.mock.calls.map((call) => String(call[0]));
    expect(printed).toEqual([
      'demo is still activating. Check again shortly with `station plugin list`. Nothing was installed.',
    ]);
    expect(process.exitCode).toBeUndefined();
    // Only the preview was sent: no install.
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);

    authenticatedFetch
      .mockReset()
      .mockResolvedValueOnce(Response.json(preview))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          plugin: { name: 'demo', version: '1.0.0' },
        }),
      );
    await install(
      PLUGIN_SOURCE,
      [],
      { ...parsed, flags: { yes: true, reinstall: true } },
      null,
    );
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
  });

  describe('plugin recover', () => {
    test('says an activating plugin is still activating and sends nothing', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      log.mockClear();
      listPlugins.mockResolvedValue([
        {
          name: 'demo',
          version: '1.0.0',
          installationReadiness: { state: 'pending', recovery: 'review' },
          activationInFlight: true,
        },
      ]);
      const { recover } = await import('../commands/install.js');

      await recover('demo', { ...parsed, flags: { yes: true } }, null);
      expect(log.mock.calls.map((call) => String(call[0]))).toEqual([
        'demo is still activating. Check again shortly with `station plugin list`. Nothing was recovered.',
      ]);
      expect(authenticatedFetch).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    const review = {
      manifest: { name: 'demo', version: '1.0.0' },
      recoveryRevision: 'review-1',
      contentDigest: 'sha256:retained',
      grantRevision: 'grant-1',
      registryTrust: { state: 'unrecorded' },
      permissions: {
        required: ['plugin.server'],
        pendingConsent: [{ permission: 'plugin.server', tier: 'trusted' }],
      },
      dependencies: [
        {
          id: 'child',
          consent: {
            contentDigest: 'sha256:child',
            permissions: [],
            dependencies: [],
            grantRevision: 'child-grant',
          },
        },
      ],
    };

    test('prints the review and recovers nothing without an explicit decision', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      authenticatedFetch.mockImplementation(async () => Response.json(review));
      const { recover } = await import('../commands/install.js');

      await expect(recover('demo', parsed, null)).rejects.toThrow(
        /Not recovered: nothing approved it/,
      );
      await expect(recover('demo', parsed, async () => false)).rejects.toThrow(
        /Not recovered: the recovery was not approved/,
      );
      const printed = log.mock.calls.map((call) => String(call[0]));
      expect(printed).toContain('  requires  plugin.server');
      expect(printed).toContain('  approving plugin.server (trusted)');
      expect(printed).toContain('  dependency child requires no permissions');
      // Only the two review reads: no recovery was sent.
      expect(
        authenticatedFetch.mock.calls.map((call) => String(call[0])),
      ).toEqual([
        'http://127.0.0.1:3141/api/plugins/demo/recovery-preview',
        'http://127.0.0.1:3141/api/plugins/demo/recovery-preview',
      ]);
    });

    test('sends exactly the reviewed revisions and names the host approval still owed', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      authenticatedFetch
        .mockResolvedValueOnce(Response.json(review))
        .mockResolvedValueOnce(
          Response.json({
            success: true,
            permissions: {
              pendingConsent: [
                { permission: 'plugin.server', tier: 'trusted' },
              ],
            },
          }),
        );
      const { recover } = await import('../commands/install.js');

      await recover('demo', parsed, approve);
      const [url, init] = authenticatedFetch.mock.calls[1]!;
      expect(String(url)).toBe(
        'http://127.0.0.1:3141/api/plugins/demo/recover',
      );
      expect(JSON.parse(String(init.body))).toEqual({
        recoveryRevision: 'review-1',
        consent: {
          contentDigest: 'sha256:retained',
          grantRevision: 'grant-1',
          permissions: ['plugin.server'],
          dependencies: ['child'],
          dependencyApprovals: [
            { id: 'child', ...review.dependencies[0]!.consent },
          ],
        },
      });
      const printed = log.mock.calls.map((call) => String(call[0]));
      expect(printed).toContain(
        '  demo requires host approval for plugin.server.',
      );
      expect(process.exitCode).toBeUndefined();
    });

    test('a recovery stopped again says why, how to get out, and exits 2', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      authenticatedFetch
        .mockResolvedValueOnce(Response.json(review))
        .mockResolvedValueOnce(
          Response.json(
            {
              success: false,
              configurationActivation: {
                status: 'pending',
                recovery: 'required',
                deadlineMs: 10_000,
              },
            },
            { status: 202 },
          ),
        );
      const { recover } = await import('../commands/install.js');

      await recover('demo', { ...parsed, flags: { yes: true } }, null);
      const printed = log.mock.calls.map((call) => String(call[0]));
      expect(printed).toContain(
        '⚠️ Recovery of demo was saved, but it is still not active: its activation did not finish within 10 seconds.',
      );
      expect(process.exitCode).toBe(2);
      process.exitCode = undefined;
    });
  });

  test('refuses when the server reports no basis to approve', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      Response.json({
        valid: true,
        manifest: { name: 'demo', version: '1.0.0' },
        components: [],
        conflicts: [],
      }),
    );
    const { install } = await import('../commands/install.js');

    await expect(install(PLUGIN_SOURCE, [], parsed, approve)).rejects.toThrow(
      /did not report what installing this plugin requires/,
    );
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  test('lists through the canonical plugin collection route without a trailing slash', async () => {
    listPlugins.mockResolvedValue([{ name: 'demo', version: '1.0.0' }]);
    const { list } = await import('../commands/install.js');

    await list(parsed);

    expect(listPlugins).toHaveBeenCalledWith('http://127.0.0.1:3141');
  });

  test('prefers a validated plugin identity over a colliding rejected directory name', async () => {
    listPlugins.mockResolvedValue([
      {
        status: 'rejected',
        name: 'demo',
        displayName: 'demo',
        rejection: {
          code: 'malformed-json',
          reason: 'Plugin manifest is malformed.',
          recovery: {
            kind: 'repair-manifest',
            instruction: 'Repair plugin.json and reload plugins.',
          },
        },
      },
      { name: 'demo', version: '1.0.0' },
    ]);
    const { info } = await import('../commands/install.js');

    await info('demo', parsed);

    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2),
    );
  });

  test('resolves a local source from the CLI invocation directory before sending it', async () => {
    authenticatedFetch
      .mockResolvedValueOnce(
        Response.json({
          valid: true,
          manifest: { name: 'demo', version: '1.0.0' },
          components: [],
          conflicts: [],
          contentDigest: 'sha256:reviewed',
          registryTrustRevision: `sha256:${'d'.repeat(64)}`,
          grantRevision: 'parent-reviewed-revision',
          permissions: {
            required: [],
            autoGranted: [],
            pendingConsent: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          plugin: { name: 'demo', version: '1.0.0' },
        }),
      );
    const { install } = await import('../commands/install.js');

    await install('.', [], parsed, approve);

    expect(authenticatedFetch).toHaveBeenLastCalledWith(
      'http://127.0.0.1:3141/api/plugins/install',
      expect.objectContaining({
        body: expect.any(String),
      }),
    );
    const postedBody = authenticatedFetch.mock.calls.at(-1)?.[1]?.body;
    expect(typeof postedBody).toBe('string');
    expect(JSON.parse(postedBody as string)).toEqual({
      source: process.cwd(),
      skip: [],
      consent: {
        permissions: [],
        contentDigest: 'sha256:reviewed',
        registryTrustRevision: `sha256:${'d'.repeat(64)}`,
        grantRevision: 'parent-reviewed-revision',
        dependencies: [],
      },
    });
  });

  test.each(['preview', 'install'] as const)(
    'rejects a local source before %s sends it to a remote Station',
    async (operation) => {
      target.apiBase = 'https://station.example.test';
      target.source = 'station-flag';
      target.station = 'hosted';
      const plugin = await import('../commands/install.js');

      const request =
        operation === 'preview'
          ? plugin.preview('.', parsed)
          : plugin.install('.', [], parsed, approve);

      await expect(request).rejects.toThrow(
        'the CLI and server do not have a proved shared filesystem',
      );
      expect(authenticatedFetch).not.toHaveBeenCalled();
    },
  );

  test('removes through the canonical Station plugin route', async () => {
    authenticatedFetch.mockResolvedValue(Response.json({ success: true }));
    const { remove } = await import('../commands/install.js');

    await remove('demo', parsed);

    expect(authenticatedFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3141/api/plugins/demo',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  test('says a removal is still winding down when Station answers 202 with outstanding command effects', async () => {
    authenticatedFetch.mockResolvedValue(
      Response.json(
        {
          success: true,
          commandEffects: {
            withdrawalId: 'pcw-1',
            status: 'winding-down',
            outstanding: 2,
          },
        },
        { status: 202 },
      ),
    );
    const { remove } = await import('../commands/install.js');
    await remove('demo', parsed);
    expect(vi.mocked(console.log)).toHaveBeenLastCalledWith(
      '✅ Removed demo through Station. 2 plugin command effects are still winding down (withdrawal pcw-1).',
    );
  });

  test('says completion cannot be confirmed when Station could not record the withdrawal', async () => {
    authenticatedFetch.mockResolvedValue(
      Response.json(
        { success: true, commandEffectsUnavailable: true },
        { status: 202 },
      ),
    );
    const { remove } = await import('../commands/install.js');
    await remove('demo', parsed);
    expect(vi.mocked(console.log)).toHaveBeenLastCalledWith(
      '✅ Removed demo through Station. Its plugin command effects could not be recorded, so completion cannot be confirmed.',
    );
  });

  test('does not report removal when Station refuses an alias and rejected-directory collision', async () => {
    authenticatedFetch.mockResolvedValue(
      Response.json(
        {
          success: false,
          error:
            "Registry plugin 'demo' resolves to installed plugin 'actual-plugin', but plugin 'demo' also exists",
        },
        { status: 400 },
      ),
    );
    const { remove } = await import('../commands/install.js');
    const logCountBefore = vi.mocked(console.log).mock.calls.length;

    await expect(remove('demo', parsed)).rejects.toThrow(
      "resolves to installed plugin 'actual-plugin'",
    );
    expect(vi.mocked(console.log).mock.calls).toHaveLength(logCountBefore);
  });

  test('does not fall back to direct filesystem mutation when Station is down', async () => {
    const home = join(TEST_TEMP_ROOT, 'station-down-home');
    const pluginDir = join(home, 'plugins', 'demo');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      '{"name":"demo","version":"1"}',
    );
    const snapshot = () =>
      readdirSync(join(home, 'plugins'), { recursive: true })
        .map(String)
        .sort()
        .map((entry) => {
          const path = join(home, 'plugins', entry);
          return statSync(path).isFile()
            ? [entry, readFileSync(path, 'utf8')]
            : [entry];
        });
    const before = snapshot();
    vi.stubEnv('STATION_HOME', home);
    vi.resetModules();
    try {
      // The plugins directory a direct-mutation fallback would write is the
      // seeded one.
      const { PLUGINS_DIR } = await import('../commands/helpers.js');
      expect(PLUGINS_DIR).toBe(join(home, 'plugins'));
      authenticatedFetch.mockRejectedValue(new TypeError('fetch failed'));
      const { update } = await import('../commands/install.js');

      await expect(update('demo', parsed)).rejects.toThrow(
        'Plugin lifecycle commands require a running Station',
      );
      expect(snapshot()).toEqual(before);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
