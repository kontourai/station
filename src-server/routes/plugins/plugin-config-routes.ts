import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  PluginManifest,
  PluginSettingField,
} from '@kontourai/station-contracts/plugin';
import type { ServerEventName } from '@kontourai/station-contracts/runtime-events';
import {
  isSecretField,
  redactSecrets,
} from '@kontourai/station-shared/redaction';
import { Hono } from 'hono';
import { isContextSafetyError } from '../../services/orchestration/context-safety.js';
import { readPluginManifestFileSync } from '../../services/plugins/plugin-manifest-loader.js';
import { pluginSettingsUpdates } from '../../telemetry/metrics.js';
import { execGit } from '../../utils/git-exec.js';
import type { Logger } from '../../utils/logger.js';
import { assertPathInside } from '../../utils/path-containment.js';
import { nullPrototypeCopy } from '../../utils/reserved-object-keys.js';
import {
  errorMessage,
  getBody,
  param,
  pluginOverridesSchema,
  pluginSettingsSchema,
  validate,
} from '../schemas/schemas.js';
import { assertPluginNameSegment } from './plugin-install-shared.js';

interface PluginConfigRouteDeps {
  pluginsDir: string;
  projectHomeDir: string;
  logger: Logger;
  eventBus?: {
    emit: (event: ServerEventName, data?: Record<string, unknown>) => void;
  };
}

/**
 * archive#3576: `field.secret` is manifest-author-controlled, so a plugin
 * author who declares a genuinely sensitive setting and forgets
 * `"secret": true` would otherwise have its value broadcast to every
 * connected client on `PLUGINS_SETTINGS_CHANGED` (correctly tagged
 * `broadcast` — the channel itself is host-global config). This is a
 * second, independent line of defense on top of the manifest declaration,
 * on two axes reused from `@kontourai/station-shared/redaction` rather than
 * minting a new pattern set:
 *
 * 1. Key-name axis (`isSecretField`, the same classifier `redactDeep` walks
 *    an object with) — the issue's actual scenario is a field NAMED
 *    `apiKey`/`apiToken`/`clientSecret`/etc. This axis is type-agnostic
 *    (matches regardless of the stored value's shape or type). It is NOT
 *    false-positive-free: `isSecretField` is tuned for log redaction, where
 *    over-redacting is free, not for a withholding gate, where it isn't.
 *    A standard OAuth-shaped manifest (`authorizationUrl`, `tokenEndpoint`,
 *    `tokenUrl`) is entirely non-secret and entirely withheld by this axis,
 *    along with `apiKeyHeaderName`/`apiKeyEnvVar` (the NAME of a header/env
 *    var, not a credential), `cookieName`/`cookieDomain`, and
 *    `passwordMinLength`/`passwordPolicyUrl`/`credentialProvider` (a number
 *    and two descriptive strings, none of them a secret). There is no
 *    remedy for a plugin author who hits this today — the manifest has no
 *    `broadcast: true`/allow-list opt-in — so an affected field is simply
 *    unavailable to every client of this event, permanently, with only the
 *    logged warning as a signal. Kept as WITHHOLD anyway (same disposition
 *    as a declared `field.secret`): a missing `authorizationUrl` on a
 *    channel nothing in this repo currently consumes is a strictly better
 *    failure than broadcasting a live `apiKey` to every connected client.
 * 2. Value-shape axis (`redactSecrets`, which is a key-name-in-text scan
 *    over the value's own contents — `redactContextualFields` — followed by
 *    `SECRET_PATTERNS`) — a lower-confidence second net for a value that
 *    looks credential-shaped under a name that doesn't. Review round:
 *    caught only 2/14 real credential shapes on its own, and produces real
 *    false positives on ordinary strings ("Basic plan", "Bearer token",
 *    prose containing the word "password"). A match here is WARNED but
 *    still EMITTED — withholding a value on a match this unreliable buys no
 *    real confidentiality (an attacker-relevant secret named plainly enough
 *    to slip past axis 1 rarely also collides with `SECRET_PATTERNS`) and
 *    would otherwise silently drop a legitimate setting from every
 *    subsequent broadcast with nothing signalling it to the client.
 *
 * `field.secret` remains the primary, author-declared signal; these two
 * axes only catch what that declaration missed.
 */
export function emittedPluginSettings(
  pluginName: string,
  manifestSettings: PluginSettingField[],
  nextSettings: Record<string, unknown>,
  logger: Logger,
): Record<string, unknown> {
  const emitted: Record<string, unknown> = Object.create(null);
  for (const field of manifestSettings) {
    if (field.secret || !Object.hasOwn(nextSettings, field.key)) continue;
    const value = nextSettings[field.key];

    if (isSecretField(field.key)) {
      logger.warn(
        `Plugin '${pluginName}' setting '${field.key}' is not declared secret but its key name matches a known secret-field name; withholding it from the broadcast plugins:settings-changed event.`,
      );
      continue;
    }

    if (typeof value === 'string' && value && redactSecrets(value) !== value) {
      logger.warn(
        `Plugin '${pluginName}' setting '${field.key}' is not declared secret but its value matched a secret-shaped pattern during redaction; emitting it as-is on the broadcast plugins:settings-changed event because a value-only match is not reliable enough to withhold (this may be a false positive, e.g. a "Basic"/"Bearer"-prefixed non-credential string).`,
      );
    }

    emitted[field.key] = value;
  }
  return emitted;
}

export function registerPluginConfigRoutes(
  app: Hono,
  deps: PluginConfigRouteDeps,
): void {
  const { eventBus, logger, pluginsDir, projectHomeDir } = deps;

  app.get('/:name/settings', async (c) => {
    const name = decodeURIComponent(param(c, 'name'));
    try {
      assertPluginNameSegment(name);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
    const manifestPath = join(pluginsDir, name, 'plugin.json');
    try {
      assertPathInside(pluginsDir, manifestPath, 'Plugin settings target');
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
    if (!existsSync(manifestPath)) {
      return c.json({ error: 'Plugin not found' }, 404);
    }

    try {
      const manifest = readPluginManifestFileSync(manifestPath);
      const schema = manifest.settings || [];

      const { ConfigLoader } = await import('../../domain/config-loader.js');
      const configLoader = new ConfigLoader({ projectHomeDir });
      const overrides = await configLoader.loadPluginOverrides();
      const values = overrides[manifest.name || name]?.settings || {};

      // Null-prototype: `field.key` is manifest-author-controlled, so a
      // declared field keyed `constructor` would otherwise read
      // `Object.prototype.constructor` out of `values` and serialize the
      // `Object` function into the response (archive#4307).
      const merged: Record<string, unknown> = Object.create(null);
      for (const field of schema) {
        if (field.secret) {
          merged[field.key] = null;
          continue;
        }
        merged[field.key] = values[field.key] ?? field.default ?? null;
      }

      return c.json({ schema, values: merged });
    } catch (error: unknown) {
      if (isContextSafetyError(error)) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  app.put('/:name/settings', validate(pluginSettingsSchema), async (c) => {
    const name = decodeURIComponent(param(c, 'name'));
    try {
      assertPluginNameSegment(name);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
    const body = getBody(c);
    const manifestPath = join(pluginsDir, name, 'plugin.json');
    try {
      assertPathInside(pluginsDir, manifestPath, 'Plugin settings target');
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
    if (!existsSync(manifestPath)) {
      return c.json({ error: 'Plugin not found' }, 404);
    }

    const { ConfigLoader } = await import('../../domain/config-loader.js');
    const configLoader = new ConfigLoader({ projectHomeDir });
    const overrides = await configLoader.loadPluginOverrides();
    // The read is guarded here, as it is on GET and on the changelog route
    // (archive#4307 review): a REFUSED manifest — a name that is not a
    // canonical plugin id, a reserved settings key, a hidden-unicode channel —
    // throws, and unguarded that surfaced as Hono's bodiless 500 with no
    // mention of what was wrong. Same disposition as GET: a context-safety
    // refusal is the caller's 400, anything else is a 500 that at least names
    // the reason.
    let manifest: PluginManifest;
    try {
      manifest = readPluginManifestFileSync(manifestPath);
    } catch (error: unknown) {
      // `errorMessage` on both branches, not the raw `.message` the GET path
      // carries as a reviewed egress exception: it is the same text through
      // the common sanitizing boundary, so this adds no new outward-error
      // surface to review.
      if (isContextSafetyError(error)) {
        return c.json({ error: errorMessage(error) }, 400);
      }
      return c.json({ error: errorMessage(error) }, 500);
    }
    const pluginName = manifest.name || name;
    const existingSettings = overrides[pluginName]?.settings || {};
    // Null-prototype (archive#4307). Both loops below write keys that are not
    // ours: `field.key` comes from the manifest and the second loop copies
    // EVERY undeclared key from the request body verbatim, so a body of
    // `{"settings":{"__proto__":{…}}}` would otherwise hit the prototype
    // setter — the value would not persist (it is not an own property, so
    // `JSON.stringify` drops it) while the route answered success. The
    // reserved-key/null-prototype policy is the grants store's
    // (`services/plugins/grants-file-store.ts` decision 5, shared via
    // `utils/reserved-object-keys.ts`).
    const nextSettings: Record<string, unknown> =
      nullPrototypeCopy(existingSettings);
    const incomingSettings = body.settings || {};

    for (const field of manifest.settings || []) {
      if (!Object.hasOwn(incomingSettings, field.key)) continue;
      const value = incomingSettings[field.key];
      if (field.secret && (value === null || value === undefined)) {
        continue;
      }
      nextSettings[field.key] = value;
    }
    for (const [key, value] of Object.entries(incomingSettings)) {
      if ((manifest.settings || []).some((field) => field.key === key)) {
        continue;
      }
      nextSettings[key] = value;
    }

    if (!overrides[pluginName]) {
      overrides[pluginName] = Object.create(null);
    }
    overrides[pluginName].settings = nextSettings as Record<
      string,
      string | number | boolean
    >;
    await configLoader.savePluginOverrides(overrides);
    pluginSettingsUpdates.add(1, { plugin: pluginName });
    eventBus?.emit('plugins:settings-changed', {
      name: pluginName,
      settings: emittedPluginSettings(
        pluginName,
        manifest.settings || [],
        nextSettings,
        logger,
      ),
    });

    return c.json({ success: true });
  });

  app.get('/:name/changelog', async (c) => {
    const name = decodeURIComponent(param(c, 'name'));
    try {
      assertPluginNameSegment(name);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
    const pluginDir = join(pluginsDir, name);
    try {
      assertPathInside(pluginsDir, pluginDir, 'Plugin changelog target');
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
    if (!existsSync(pluginDir)) {
      return c.json({ error: 'Plugin not found' }, 404);
    }

    const isGit = existsSync(join(pluginDir, '.git'));
    if (!isGit) {
      return c.json({ entries: [], source: 'local' });
    }

    try {
      const { stdout } = await execGit(
        [
          'log',
          '--oneline',
          '--no-decorate',
          '-20',
          '--format=%H|%h|%s|%an|%aI',
        ],
        { cwd: pluginDir, encoding: 'utf-8' },
      );

      const entries = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, short, subject, author, date] = line.split('|');
          return { hash, short, subject, author, date };
        });

      const changelogPath = join(pluginDir, 'CHANGELOG.md');
      const changelog = existsSync(changelogPath)
        ? await readFile(changelogPath, 'utf-8')
        : null;

      return c.json({ entries, source: 'git', changelog });
    } catch (error: unknown) {
      return c.json({ entries: [], source: 'git', error: errorMessage(error) });
    }
  });

  app.get('/:name/providers', async (c) => {
    const name = decodeURIComponent(param(c, 'name'));
    try {
      assertPluginNameSegment(name);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
    const pluginDir = join(pluginsDir, name);
    const manifestPath = join(pluginDir, 'plugin.json');
    try {
      assertPathInside(pluginsDir, manifestPath, 'Plugin providers target');
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
    if (!existsSync(manifestPath)) {
      return c.json({ error: 'Plugin not found' }, 404);
    }

    try {
      const manifest = readPluginManifestFileSync(manifestPath);
      const { ConfigLoader } = await import('../../domain/config-loader.js');
      const configLoader = new ConfigLoader({ projectHomeDir });
      const overrides = await configLoader.loadPluginOverrides();
      const disabled = overrides[manifest.name || name]?.disabled ?? [];

      const providers = (manifest.providers || []).map((provider) => ({
        type: provider.type,
        module: provider.module,
        layout: provider.layout ?? null,
        enabled: !disabled.includes(provider.type),
      }));

      return c.json({ providers });
    } catch (error: unknown) {
      if (isContextSafetyError(error)) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  app.get('/:name/overrides', async (c) => {
    const name = decodeURIComponent(param(c, 'name'));
    try {
      assertPluginNameSegment(name);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
    const { ConfigLoader } = await import('../../domain/config-loader.js');
    const configLoader = new ConfigLoader({ projectHomeDir });
    const overrides = await configLoader.loadPluginOverrides();
    const override = overrides[name] ?? {};
    return c.json({ disabled: override.disabled ?? [] });
  });

  app.put('/:name/overrides', validate(pluginOverridesSchema), async (c) => {
    const name = decodeURIComponent(param(c, 'name'));
    try {
      assertPluginNameSegment(name);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
    const body = getBody(c);
    const { ConfigLoader } = await import('../../domain/config-loader.js');
    const configLoader = new ConfigLoader({ projectHomeDir });
    const overrides = await configLoader.loadPluginOverrides();
    // Null-prototype, matching the settings route's initializer above: a plain
    // object literal here would put a plain-prototype value back into the
    // null-prototype map on the very next save, defeating the invariant
    // `loadPluginOverrides` documents (archive#4307 review).
    overrides[name] = Object.assign(Object.create(null), overrides[name], {
      disabled: body.disabled || [],
    });
    await configLoader.savePluginOverrides(overrides);
    return c.json({ success: true });
  });
}
