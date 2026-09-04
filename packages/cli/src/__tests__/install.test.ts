import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ApiBaseSource, ParsedCoreArgs } from '../commands/core-api.js';

const authenticatedFetch = vi.hoisted(() => vi.fn());
const listPlugins = vi.hoisted(() => vi.fn());
const target = vi.hoisted(() => ({
  apiBase: 'http://127.0.0.1:3141',
  source: 'loopback' as ApiBaseSource,
  station: undefined as string | undefined,
}));

vi.mock('@kontourai/station-sdk/client', () => ({
  authenticatedFetch,
  listPlugins,
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
            dependencies: [],
            pendingConsent: [
              { permission: 'providers.register', tier: 'trusted' },
            ],
          },
        },
      ],
      contentDigest: 'sha256:reviewed',
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
      install('/tmp/demo', ['agent:helper'], parsed, approve),
    ).resolves.toEqual({ pluginName: 'demo', version: '1.0.0' });

    expect(authenticatedFetch.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:3141/api/plugins/preview',
      'http://127.0.0.1:3141/api/plugins/install',
    ]);
    expect(authenticatedFetch).toHaveBeenLastCalledWith(
      'http://127.0.0.1:3141/api/plugins/install',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          source: '/tmp/demo',
          skip: ['agent:helper'],
          consent: {
            permissions: ['navigation.dock', 'network.fetch'],
            contentDigest: 'sha256:reviewed',
            dependencies: ['shared-lib'],
            dependencyApprovals: [
              {
                id: 'shared-lib',
                permissions: ['providers.register'],
                contentDigest: 'sha256:dependency',
                dependencies: [],
              },
            ],
          },
        }),
      }),
    );

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
                  dependencies: [],
                  pendingConsent: [
                    { permission: 'providers.register', tier: 'trusted' },
                  ],
                },
              },
            ],
            contentDigest: 'sha256:reviewed',
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

      await install('/tmp/demo', [], parsed, approve);

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
        permissions: {
          required: ['network.fetch'],
          autoGranted: [],
          pendingConsent: [{ permission: 'network.fetch', tier: 'active' }],
        },
      }),
    );
    const { install } = await import('../commands/install.js');

    await expect(install('/tmp/demo', [], parsed, decline)).rejects.toThrow(
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
        permissions: { required: [], autoGranted: [], pendingConsent: [] },
      }),
    );
    const { install } = await import('../commands/install.js');

    await expect(install('/tmp/demo', [], parsed, null)).rejects.toThrow(
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
      install('/tmp/demo', [], { ...parsed, flags: { yes: true } }, null),
    ).resolves.toEqual({ pluginName: 'demo', version: '1.0.0' });
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
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

    await expect(install('/tmp/demo', [], parsed, approve)).rejects.toThrow(
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
        body: JSON.stringify({
          source: process.cwd(),
          skip: [],
          consent: {
            permissions: [],
            contentDigest: 'sha256:reviewed',
            dependencies: [],
          },
        }),
      }),
    );
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
    authenticatedFetch.mockRejectedValue(new TypeError('fetch failed'));
    const { update } = await import('../commands/install.js');

    await expect(update('demo', parsed)).rejects.toThrow(
      'Plugin lifecycle commands require a running Station',
    );
  });
});
