import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  emittedPluginSettings,
  registerPluginConfigRoutes,
} from '../plugin-config-routes.js';

// archive#3576: `field.secret` is manifest-author-controlled, so a plugin
// author who declares a genuinely sensitive setting and forgets
// `"secret": true` would otherwise have its value broadcast to every
// connected client on `PLUGINS_SETTINGS_CHANGED`. `emittedPluginSettings`
// is the second, independent line of defense, on two axes:
//
// - Key-name axis (`isSecretField`) — a field NAMED `apiKey`/`apiToken`/
//   `clientSecret`/etc. is withheld regardless of value shape. This is the
//   axis that actually covers the issue's scenario (value-only matching
//   caught only 2/14 real credential shapes in one review round). It is NOT
//   false-positive-free: `isSecretField` is tuned for log redaction, where
//   over-redaction is free — a standard OAuth-shaped manifest
//   (`authorizationUrl`/`tokenEndpoint`/`tokenUrl`) and assorted
//   config-descriptive names (`apiKeyHeaderName`, `cookieName`,
//   `passwordMinLength`, `credentialProvider`, ...) are real false positives
//   under a withholding gate, with no manifest-side remedy today. See
//   `emittedPluginSettings`'s own docblock and the "false positives" describe
//   block below.
// - Value-shape axis (`redactSecrets`) — a lower-confidence second net for a
//   value that LOOKS credential-shaped under a non-secret-named field. A
//   match here is warned but still emitted (not withheld), because it
//   produces real false positives ("Basic plan", "Bearer token") and
//   withholding on a match this unreliable would silently drop legitimate
//   settings with nothing signalling it to the client.
//
// Both directions are exercised on both axes — a guard whose rejection path
// never executes is unproven.
describe('emittedPluginSettings (station#3576)', () => {
  describe('key-name axis (station#3577 review round HIGH-2)', () => {
    test('a secret-named key is withheld even when the value matches NO recognized value-shape pattern', () => {
      const logger = { warn: vi.fn() };
      // A live-shaped Stripe secret key. @kontourai/station-shared/redaction's
      // SECRET_PATTERNS has no Stripe pattern (only OpenAI `sk-`, GitHub
      // `gh[pousr]_`, AWS `AKIA`/`ASIA`, Bearer/Basic, connection strings) —
      // this value does NOT match the value-shape axis at all. Only the
      // key-name axis (`isSecretField('apiKey')`) can catch it; if the key
      // axis is removed, this value is emitted verbatim to every SSE client.
      const result = emittedPluginSettings(
        'my-plugin',
        [{ key: 'apiKey', label: 'API Key', type: 'string' }],
        { apiKey: 'sk_live_51H8xQ2eZvKYlo2Cabcdefghijkl' },
        logger as any,
      );

      expect(result).toEqual({});
      expect(logger.warn).toHaveBeenCalledOnce();
      const [message] = logger.warn.mock.calls[0];
      expect(message).toContain('my-plugin');
      expect(message).toContain('apiKey');
    });

    test('a secret-named key is withheld regardless of value type (number/boolean)', () => {
      const logger = { warn: vi.fn() };
      const result = emittedPluginSettings(
        'my-plugin',
        [{ key: 'apiToken', label: 'API Token', type: 'number' }],
        { apiToken: 12345 },
        logger as any,
      );

      expect(result).toEqual({});
      expect(logger.warn).toHaveBeenCalledOnce();
    });

    test('a non-secret-named key is never withheld by the key axis', () => {
      const logger = { warn: vi.fn() };
      const result = emittedPluginSettings(
        'my-plugin',
        [{ key: 'endpoint', label: 'Endpoint', type: 'string' }],
        { endpoint: 'https://example.com/webhook' },
        logger as any,
      );

      expect(result).toEqual({ endpoint: 'https://example.com/webhook' });
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('value-shape axis (warn, not withhold — station#3577 review round MEDIUM-1)', () => {
    test('a value-shape match under a non-secret-named key still emits, but warns', () => {
      const logger = { warn: vi.fn() };
      const result = emittedPluginSettings(
        'my-plugin',
        [{ key: 'endpoint', label: 'Endpoint', type: 'string' }],
        // AWS-key-shaped value under a field name the key axis does not
        // catch. The value axis fires, but per the redesign this is
        // WARN-and-EMIT, not withhold: a value-only match is not reliable
        // enough to justify a silent drop.
        { endpoint: 'AKIAABCDEFGHIJKLMNOP' },
        logger as any,
      );

      expect(result).toEqual({ endpoint: 'AKIAABCDEFGHIJKLMNOP' });
      expect(logger.warn).toHaveBeenCalledOnce();
    });

    test('a genuine false positive ("Basic plan") is NOT silently dropped', () => {
      const logger = { warn: vi.fn() };
      // Matches SECRET_PATTERNS' `\bBasic\s+[A-Za-z0-9+/_=-]+` even though
      // it names a pricing tier, not a credential. Withholding this under
      // the pre-redesign disposition would have dropped a legitimate select
      // option from the broadcast on every subsequent PUT.
      const result = emittedPluginSettings(
        'my-plugin',
        [{ key: 'authScheme', label: 'Auth scheme', type: 'select' }],
        { authScheme: 'Basic plan' },
        logger as any,
      );

      expect(result).toEqual({ authScheme: 'Basic plan' });
    });

    test('a non-secret-shaped value emits with no warning at all', () => {
      const logger = { warn: vi.fn() };
      const result = emittedPluginSettings(
        'my-plugin',
        [{ key: 'endpoint', label: 'Endpoint', type: 'string' }],
        { endpoint: 'https://example.com/webhook' },
        logger as any,
      );

      expect(result).toEqual({ endpoint: 'https://example.com/webhook' });
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  // archive#3577 review round 2 (NIT): the field key here must NOT also
  // trip the key-name axis (unlike the previous fixture, `password`, which
  // does) — otherwise this test cannot tell "declared `secret: true` is
  // honored" apart from "the key-name axis also caught it," and would keep
  // passing even if the `field.secret ||` short-circuit were deleted.
  // `licenseKey` matches neither `isSecretField` nor any value-shape
  // pattern, so the `secret: true` declaration is the only thing this test
  // can be passing because of.
  test('a field the manifest declares `secret: true` is still withheld regardless of value shape', () => {
    const logger = { warn: vi.fn() };
    const result = emittedPluginSettings(
      'my-plugin',
      [
        {
          key: 'licenseKey',
          label: 'License Key',
          type: 'string',
          secret: true,
        },
      ],
      { licenseKey: 'not-secret-shaped-at-all' },
      logger as any,
    );

    expect(result).toEqual({});
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a non-string value (number/boolean) is never treated as secret-shaped by the value axis', () => {
    const logger = { warn: vi.fn() };
    const result = emittedPluginSettings(
      'my-plugin',
      [
        { key: 'retries', label: 'Retries', type: 'number' },
        { key: 'enabled', label: 'Enabled', type: 'boolean' },
      ],
      { retries: 3, enabled: true },
      logger as any,
    );

    expect(result).toEqual({ retries: 3, enabled: true });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // archive#3577 review round 2 (MEDIUM-3): the round-1 docblock claimed
  // "0 false positives on a real corpus." There was no corpus — nine
  // hand-picked names. Measured against `isSecretField`, a standard,
  // entirely non-secret OAuth-shaped manifest is mostly withheld, and a
  // batch of ordinary config-descriptive field names (a header NAME, an env
  // var NAME, a cookie NAME/domain, a password MIN LENGTH, a policy URL, a
  // provider NAME — none of them a credential value) are withheld outright.
  // There is no manifest-side remedy for an author who hits this (no
  // `broadcast: true` opt-in) — the withhold disposition stays correct
  // (better to drop a benign field than leak a live `apiKey`), but the
  // "0 false positives" claim was wrong and is documented here instead.
  describe('key-name axis false positives (station#3577 review round 2, MEDIUM-3)', () => {
    test('a standard OAuth-shaped manifest is mostly withheld by the key axis', () => {
      const logger = { warn: vi.fn() };
      const manifest = [
        { key: 'authorizationUrl', label: 'Authorization URL', type: 'string' },
        { key: 'tokenEndpoint', label: 'Token endpoint', type: 'string' },
        { key: 'tokenUrl', label: 'Token URL', type: 'string' },
        { key: 'scope', label: 'Scope', type: 'string' },
        { key: 'redirectUri', label: 'Redirect URI', type: 'string' },
      ] as const;
      const values = {
        authorizationUrl: 'https://idp.example.com/oauth/authorize',
        tokenEndpoint: 'https://idp.example.com/oauth/token',
        tokenUrl: 'https://idp.example.com/oauth/token',
        scope: 'openid profile',
        redirectUri: 'https://app.example.com/callback',
      };

      const result = emittedPluginSettings(
        'my-plugin',
        manifest as any,
        values,
        logger as any,
      );

      // Only the two fields the key axis genuinely does not touch survive —
      // 3 of 5 non-secret OAuth fields are withheld as false positives.
      expect(result).toEqual({
        scope: 'openid profile',
        redirectUri: 'https://app.example.com/callback',
      });
      expect(logger.warn).toHaveBeenCalledTimes(3);
    });

    test('config-descriptive field names (not credential values) are withheld outright', () => {
      const logger = { warn: vi.fn() };
      const manifest = [
        { key: 'apiKeyHeaderName', label: 'API key header', type: 'string' },
        { key: 'apiKeyEnvVar', label: 'API key env var', type: 'string' },
        { key: 'cookieName', label: 'Cookie name', type: 'string' },
        { key: 'cookieDomain', label: 'Cookie domain', type: 'string' },
        {
          key: 'passwordMinLength',
          label: 'Password min length',
          type: 'number',
        },
        {
          key: 'passwordPolicyUrl',
          label: 'Password policy URL',
          type: 'string',
        },
        {
          key: 'credentialProvider',
          label: 'Credential provider',
          type: 'string',
        },
      ] as const;
      const values = {
        apiKeyHeaderName: 'X-Api-Key',
        apiKeyEnvVar: 'MY_PLUGIN_API_KEY',
        cookieName: 'session_id',
        cookieDomain: '.example.com',
        passwordMinLength: 12,
        passwordPolicyUrl: 'https://example.com/password-policy',
        credentialProvider: 'okta',
      };

      const result = emittedPluginSettings(
        'my-plugin',
        manifest as any,
        values,
        logger as any,
      );

      expect(result).toEqual({});
      expect(logger.warn).toHaveBeenCalledTimes(7);
    });
  });

  test('a key not present in the submitted settings is skipped', () => {
    const logger = { warn: vi.fn() };
    const result = emittedPluginSettings(
      'my-plugin',
      [{ key: 'missing', label: 'Missing', type: 'string' }],
      {},
      logger as any,
    );

    expect(result).toEqual({});
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// archive#4307. `PUT /api/plugins/:name/settings` derived its store key from
// `manifest.name || name` and used it against a plain-prototype `overrides`
// object loaded by `ConfigLoader.loadPluginOverrides`. A plugin installed in
// `demo/` whose manifest declared `"name": "__proto__"` therefore:
//
//   1. made `overrides['__proto__']` answer `Object.prototype` — truthy, so
//      `if (!overrides[pluginName]) overrides[pluginName] = {}` was skipped;
//   2. wrote `Object.prototype.settings = nextSettings`, and `nextSettings`
//      carries every undeclared body key verbatim, so the payload was
//      caller-controlled;
//   3. serialized an object with no such OWN key, so nothing persisted while
//      the route answered `{ success: true }`.
//
// Two independent defects — process-wide prototype pollution AND a silent
// write loss reported as success. Two independent fixes, tested separately
// below: `manifest.name` must be a canonical plugin id (the real bug — such a
// name should never reach a store key), and the store is null-prototype so
// the class cannot recur through a field nobody thought about. The
// null-prototype/reserved-key policy is the grants store's
// (`services/plugins/grants-file-store.ts` decision 5, shared via
// `utils/reserved-object-keys.ts`).
describe('PUT /:name/settings prototype pollution (station#4307)', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupDirs
        .splice(0, cleanupDirs.length)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
    // Fail loudly rather than leaking a polluted prototype into sibling
    // tests if an assertion below ever stops holding.
    for (const key of ['settings', 'polluted', 'disabled']) {
      delete (Object.prototype as Record<string, unknown>)[key];
    }
  });

  function createApp(root: string, emit = vi.fn()) {
    const app = new Hono();
    registerPluginConfigRoutes(app, {
      eventBus: { emit } as never,
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      } as never,
      pluginsDir: join(root, 'plugins'),
      projectHomeDir: root,
    });
    return app;
  }

  function seedPlugin(root: string, dirName: string, manifest: unknown) {
    const pluginDir = join(root, 'plugins', dirName);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify(manifest, null, 2),
    );
  }

  // Each case carries the refusal it must produce (archive#4307 review): a
  // bare `status !== 200` passes for ANY throw in the handler — including one
  // that has nothing to do with the name — so it could not tell a working
  // refusal from an unrelated crash. It also has to be a refusal a caller can
  // READ: the manifest read used to sit outside any try/catch, so it surfaced
  // as Hono's bodiless 500 with no mention of what was wrong.
  test.each([
    ['__proto__', /is not a canonical plugin id/],
    ['constructor', /is a reserved object key and cannot name a plugin/],
    ['prototype', /is a reserved object key and cannot name a plugin/],
  ] as const)(
    'a manifest naming the reserved key %s is refused by name, and nothing lands on Object.prototype',
    async (pollutingName, refusal) => {
      const root = mkdtempSync(join(tmpdir(), 'station-plugin-proto-'));
      cleanupDirs.push(root);
      seedPlugin(root, 'demo', {
        name: pollutingName,
        version: '1.0.0',
        settings: [{ key: 'endpoint', label: 'Endpoint', type: 'string' }],
      });

      const response = await createApp(root).request('/demo/settings', {
        body: JSON.stringify({
          settings: { endpoint: 'https://example.com', polluted: 'yes' },
        }),
        headers: { 'content-type': 'application/json' },
        method: 'PUT',
      });

      // The route must not answer success for a write it cannot make, and it
      // must say which of the two axes refused it.
      expect(response.status).not.toBe(200);
      const { error } = (await response.json()) as { error: string };
      expect(error).toMatch(refusal);
      expect(error).toContain(pollutingName);
      expect(({} as Record<string, unknown>).settings).toBeUndefined();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.hasOwn(Object.prototype, 'settings')).toBe(false);
    },
  );

  test('a settings key named __proto__ persists as an own key instead of being silently dropped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-proto-'));
    cleanupDirs.push(root);
    seedPlugin(root, 'demo', {
      name: 'demo',
      version: '1.0.0',
      settings: [{ key: 'endpoint', label: 'Endpoint', type: 'string' }],
    });

    // The handler copies every UNDECLARED body key verbatim, so the settings
    // map is caller-keyed too. On a plain-prototype accumulator this write
    // hit the prototype setter: not an own property, so `JSON.stringify`
    // dropped it and the route reported a success that never happened.
    // Written as a literal, not via an object literal: `{ __proto__: … }` in
    // JS SOURCE sets the prototype instead of creating an own key, so
    // `JSON.stringify` would emit a body without the key at all and the test
    // would pass without ever reaching the case.
    const response = await createApp(root).request('/demo/settings', {
      body: '{"settings":{"__proto__":{"polluted":"yes"},"endpoint":"https://x.test"}}',
      headers: { 'content-type': 'application/json' },
      method: 'PUT',
    });

    expect(response.status).toBe(200);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const stored = JSON.parse(
      readFileSync(join(root, 'config', 'plugin-overrides.json'), 'utf-8'),
    );
    expect(Object.hasOwn(stored.demo.settings, '__proto__')).toBe(true);
    expect(stored.demo.settings.endpoint).toBe('https://x.test');
  });

  test('loadPluginOverrides hands out a null-prototype map, so a miss is a miss', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-proto-'));
    cleanupDirs.push(root);
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(
      join(root, 'config', 'plugin-overrides.json'),
      JSON.stringify({ demo: { disabled: ['auth'], settings: { a: 1 } } }),
    );

    const { ConfigLoader } = await import('../../../domain/config-loader.js');
    const overrides = await new ConfigLoader({
      projectHomeDir: root,
    }).loadPluginOverrides();

    expect(Object.getPrototypeOf(overrides)).toBeNull();
    // The lookups the route makes: on a plain object these answer
    // `Object.prototype` (truthy) and `Object.prototype.constructor`.
    expect(overrides['__proto__' as string]).toBeUndefined();
    expect(overrides.constructor).toBeUndefined();
    // ... and the nested settings map is keyed by manifest-declared field
    // names, so it gets the same treatment.
    expect(Object.getPrototypeOf(overrides.demo.settings)).toBeNull();
    expect(overrides.demo.disabled).toEqual(['auth']);
  });
});

/**
 * archive#4307 review. `PUT /:name/settings` copies every undeclared body key
 * VERBATIM into `plugin-overrides.json`, and nothing bounded how deeply those
 * values nest. Three limits, all measured on this Node:
 *
 *   JSON.parse      ~200_000 levels   (iterative in V8)
 *   JSON.stringify    ~6_167 levels
 *   the old nullPrototypeDeep ~3_515 levels (one call frame per level)
 *
 * So a body nested between the last two PERSISTED — the write succeeded and
 * the route answered `{ success: true }` — and every subsequent READ of the
 * store threw `RangeError: Maximum call stack size exceeded`. Not just on
 * these four routes: `readPluginServerSettings` runs on every HTTP request to
 * any plugin server module, and `loadPluginOverrides` is awaited unguarded on
 * the BOOT path (`runtime/plugins/runtime-plugin-loader.ts` via
 * `runtime-initialize.ts`), so plugin provider loading aborted at every server
 * start, survived restart, and needed the file hand-edited to recover. A 24 KB
 * request produced a 32 MB file (`JSON.stringify(…, null, 2)` indents by
 * depth) — ~1336x amplification on top of it.
 *
 * Two independent guards, tested separately here:
 *
 *   1. the READER is bounded by `JSON.parse`, not by the call stack
 *      (`nullPrototypeDeep` is iterative — proven directly in
 *      `utils/__tests__/reserved-object-keys.test.ts`); a store that is
 *      already deep, however it got there, still loads.
 *   2. the WRITER refuses past a declared depth instead of persisting
 *      something a reader has to survive.
 */
describe('PUT /:name/settings unbounded nesting (station#4307 review)', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupDirs
        .splice(0, cleanupDirs.length)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  // Built as TEXT: `JSON.stringify` cannot emit these depths at all.
  function nestedJson(depth: number): string {
    let text = 'null';
    for (let level = 0; level < depth; level += 1) text = `{"a":${text}}`;
    return text;
  }

  function seedDemo(root: string) {
    const pluginDir = join(root, 'plugins', 'demo');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'demo',
        settings: [{ key: 'endpoint', label: 'Endpoint', type: 'string' }],
        version: '1.0.0',
      }),
    );
  }

  function createApp(root: string) {
    const app = new Hono();
    registerPluginConfigRoutes(app, {
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      } as never,
      pluginsDir: join(root, 'plugins'),
      projectHomeDir: root,
    });
    return app;
  }

  test('the OVERRIDES route is capped too, and its boundary holds', async () => {
    // `PUT /:name/overrides` copies `body.disabled` verbatim into the same
    // file, so it is the same vector — and its cap is a SEPARATE `.refine`
    // instance. Removing it left the whole suite green, which is why this
    // exists (archive#4307 delta review, LOW-4).
    const root = mkdtempSync(join(tmpdir(), 'station-override-depth-'));
    cleanupDirs.push(root);
    seedDemo(root);
    const app = createApp(root);

    const refused = await app.request('/demo/overrides', {
      body: `{"disabled":${nestedJson(4_000)}}`,
      headers: { 'content-type': 'application/json' },
      method: 'PUT',
    });
    expect(refused.status).toBe(400);

    // And the boundary is where it says it is: nothing pinned 32-accept /
    // 33-refuse, so a cap that drifted either way went unnoticed. The
    // `{"disabled": …}` wrapper costs one of the 32.
    const atCap = await app.request('/demo/overrides', {
      body: `{"disabled":${nestedJson(30)}}`,
      headers: { 'content-type': 'application/json' },
      method: 'PUT',
    });
    expect(atCap.status).toBe(200);

    const overCap = await app.request('/demo/overrides', {
      body: `{"disabled":${nestedJson(40)}}`,
      headers: { 'content-type': 'application/json' },
      method: 'PUT',
    });
    expect(overCap.status).toBe(400);
  });

  test('a body nested past the declared cap is refused, and the store stays readable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-depth-'));
    cleanupDirs.push(root);
    seedDemo(root);
    const app = createApp(root);

    // 4_000 is the discriminating depth: deep enough that the recursive copy
    // died on it, shallow enough that `JSON.stringify` would have written it
    // to disk quite happily.
    const response = await app.request('/demo/settings', {
      body: `{"settings":{"deep":${nestedJson(4_000)}}}`,
      headers: { 'content-type': 'application/json' },
      method: 'PUT',
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'Validation failed',
    );
    // Nothing was persisted, so the next read is a read of an absent store.
    expect(existsSync(join(root, 'config', 'plugin-overrides.json'))).toBe(
      false,
    );
    // ... and the route that reads it still answers.
    const read = await app.request('/demo/settings');
    expect(read.status).toBe(200);
  });

  test('a store already nested deeper than the call stack still loads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-depth-'));
    cleanupDirs.push(root);
    seedDemo(root);
    mkdirSync(join(root, 'config'), { recursive: true });
    // Written directly, as a file left behind by the pre-fix route (or by a
    // hand edit) would be: the reader has to survive whatever is on disk, and
    // this is the exact shape that used to break every read AND server boot.
    writeFileSync(
      join(root, 'config', 'plugin-overrides.json'),
      `{"demo":{"settings":{"deep":${nestedJson(20_000)}}}}`,
    );

    const response = await createApp(root).request('/demo/settings');

    expect(response.status).toBe(200);
    const { ConfigLoader } = await import('../../../domain/config-loader.js');
    await expect(
      new ConfigLoader({ projectHomeDir: root }).loadPluginOverrides(),
    ).resolves.toBeTruthy();
  });

  test('an ordinary nested settings value is still accepted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-depth-'));
    cleanupDirs.push(root);
    seedDemo(root);

    const response = await createApp(root).request('/demo/settings', {
      body: JSON.stringify({
        settings: { endpoint: 'https://x.test', extra: { a: { b: [1, 2] } } },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'PUT',
    });

    expect(response.status).toBe(200);
    const stored = JSON.parse(
      readFileSync(join(root, 'config', 'plugin-overrides.json'), 'utf-8'),
    );
    expect(stored.demo.settings.extra).toEqual({ a: { b: [1, 2] } });
  });
});
