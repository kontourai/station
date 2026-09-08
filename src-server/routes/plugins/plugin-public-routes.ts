import { randomUUID } from 'node:crypto';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { Hono } from 'hono';
import { isContextSafetyError } from '../../services/orchestration/context-safety.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import type { PackageMcpAdmissionJournal } from '../../services/plugins/package-mcp-admission.js';
import {
  type PluginGrantReconciliationService,
  pluginPermissionsNeedRuntimeReconciliation,
} from '../../services/plugins/plugin-grant-reconciliation.js';
import {
  assertGrantablePermissions,
  getPermissionTier,
  getPluginGrants,
  grantPermissions,
  hasGrantOrThrow,
  PluginContentUnavailableError,
  PluginGrantsUnavailableError,
  readPluginGrantState,
  requiredPermissionsForManifest,
  revokeGrants,
} from '../../services/plugins/plugin-permissions.js';
import {
  capturePluginRuntimeArtifact,
  type PluginRuntimeArtifact,
} from '../../services/plugins/plugin-runtime-artifact.js';
import {
  pluginServerRequestDuration,
  pluginServerRequests,
  routingDecision,
} from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';
import {
  errorMessage,
  getBody,
  param,
  pluginFetchSchema,
  pluginGrantSchema,
  validate,
} from '../schemas/schemas.js';
import { readPluginBundle } from './plugin-bundles.js';
import { assertPluginNameSegment } from './plugin-install-shared.js';
import {
  acquirePluginPublicServerModule,
  buildPluginRequestContext,
  createScopedPluginRequest,
  type LoadedPluginServerModule,
  type PluginServerModuleContext,
  readPluginServerSettings,
} from './plugin-public-server.js';

interface PluginPublicRouteDeps {
  pluginsDir: string;
  packageMcpJournal?: PackageMcpAdmissionJournal;
  projectHomeDir: string;
  logger: Logger;
  eventBus?: EventBus;
  grantReconciliation?: PluginGrantReconciliationService;
}

export function registerPluginPublicRoutes(
  app: Hono,
  deps: PluginPublicRouteDeps,
): void {
  const { logger, pluginsDir, projectHomeDir } = deps;

  function manifestSafetyFailure(
    name: string,
    correlationId: string,
    error: unknown,
  ) {
    logger.warn('Plugin public manifest failed safety validation', {
      correlationId,
      error: errorMessage(error),
      plugin: name,
    });
    return {
      correlationId,
      error: 'Plugin manifest failed safety validation',
      success: false,
    };
  }

  app.get('/:name/bundle.js', async (c) => {
    const name = param(c, 'name');
    try {
      assertPluginNameSegment(name);
    } catch (error) {
      return c.text(errorMessage(error), 400);
    }
    const bundle = await readPluginBundle(
      pluginsDir,
      name,
      'bundle.js',
      deps.packageMcpJournal,
    );
    if (bundle === null) return c.text('Bundle not found', 404);
    c.header('Content-Type', 'application/javascript');
    c.header('Cache-Control', 'no-cache');
    return c.text(bundle);
  });

  app.get('/:name/bundle.css', async (c) => {
    const name = param(c, 'name');
    try {
      assertPluginNameSegment(name);
    } catch (error) {
      return c.text(errorMessage(error), 400);
    }
    const css = await readPluginBundle(
      pluginsDir,
      name,
      'bundle.css',
      deps.packageMcpJournal,
    );
    if (css === null) return c.text('', 200);
    c.header('Content-Type', 'text/css');
    c.header('Cache-Control', 'no-cache');
    c.header('Access-Control-Allow-Origin', '*');
    return c.text(css);
  });

  app.get('/:name/permissions', async (c) => {
    const name = param(c, 'name');
    try {
      assertPluginNameSegment(name);
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
    try {
      const artifact = capturePluginRuntimeArtifact(
        pluginsDir,
        name,
        deps.packageMcpJournal,
      );
      if (!artifact)
        return c.json({ success: false, error: 'Plugin unavailable' }, 404);
      const manifest = artifact.manifest;
      const declared = requiredPermissionsForManifest(manifest);
      // archive#4288: `granted` is the EFFECTIVE set. When the installed tree
      // no longer matches the one consent was given against, the withheld
      // names and the binding state travel with it, so the panel can say what
      // was taken away and why instead of a permission just disappearing.
      const state = readPluginGrantState(projectHomeDir, name, artifact);
      return c.json({
        declared,
        granted: state.granted,
        contentBinding: state.binding,
        withheld: state.withheld,
      });
    } catch (error: unknown) {
      if (isContextSafetyError(error)) {
        return c.json(manifestSafetyFailure(name, randomUUID(), error), 400);
      }
      if (error instanceof PluginGrantsUnavailableError) {
        // Display surface: an unreadable store must not render as "nothing
        // granted" (archive#1835). Surface the unavailable state explicitly.
        return c.json(
          {
            success: false,
            error: errorMessage(error),
            grantsUnavailable: true,
          },
          503,
        );
      }
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.post('/:name/grant', validate(pluginGrantSchema), async (c) => {
    const name = param(c, 'name');
    try {
      assertPluginNameSegment(name);
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
    const { permissions } = getBody(c);
    if (!Array.isArray(permissions)) {
      return c.json(
        { success: false, error: 'permissions array required' },
        400,
      );
    }
    try {
      const artifact = capturePluginRuntimeArtifact(
        pluginsDir,
        name,
        deps.packageMcpJournal,
      );
      if (!artifact)
        return c.json({ success: false, error: 'Plugin unavailable' }, 404);
      const manifest = artifact.manifest;
      assertGrantablePermissions(manifest, permissions);
      const trusted = permissions.filter(
        (permission) => getPermissionTier(permission) === 'trusted',
      );
      if (trusted.length > 0) {
        return c.json(
          {
            success: false,
            error:
              'Trusted plugin permissions require an isolated host approval channel',
          },
          403,
        );
      }
      const outcome = await grantPermissions(
        projectHomeDir,
        name,
        permissions,
        artifact,
      );
      deps.eventBus?.emit(SERVER_EVENTS.PLUGINS_GRANTS_CHANGED, {
        name,
      });
      const reconciliation = pluginPermissionsNeedRuntimeReconciliation(
        outcome.withdrawn,
      )
        ? deps.grantReconciliation
          ? await deps.grantReconciliation.reconcile({
              pluginName: name,
              permissions: outcome.withdrawn,
            })
          : {
              status: 'incomplete' as const,
              failures: ['runtime-unavailable'],
            }
        : undefined;
      // Derived, never the request echoed back (archive#4288, delta review
      // MEDIUM 2). Granting one permission against a `changed` binding
      // withdraws every OTHER recorded permission — `trusted` ones included,
      // which are re-acquirable only through the isolated host-approval
      // channel — so answering with the request would report a capability
      // loss as a success carrying exactly what was asked for. `DELETE
      // /:name/grant` already answers with derived state; this makes the two
      // verbs agree.
      return c.json(
        {
          success: true,
          granted: outcome.granted,
          withdrawn: outcome.withdrawn,
          ...(reconciliation ? { reconciliation } : {}),
        },
        reconciliation?.status === 'winding-down' ? 202 : 200,
      );
    } catch (error: unknown) {
      if (isContextSafetyError(error)) {
        return c.json(manifestSafetyFailure(name, randomUUID(), error), 400);
      }
      if (error instanceof PluginGrantsUnavailableError) {
        // Consent write path: nothing was granted; say why (archive#1835).
        return c.json(
          {
            success: false,
            error: errorMessage(error),
            grantsUnavailable: true,
          },
          503,
        );
      }
      if (error instanceof PluginContentUnavailableError) {
        // A grant is a consent to bytes; bytes we cannot read cannot be
        // consented to, so nothing was written (archive#4288).
        return c.json(
          {
            success: false,
            error: errorMessage(error),
            contentUnavailable: true,
          },
          503,
        );
      }
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  /**
   * Withdraws permissions a plugin currently holds (archive#3815).
   *
   * DELETE, not POST: this removes authority and is idempotent — asking
   * twice leaves the same state, and asking for something never granted is
   * already satisfied.
   *
   * Deliberately NOT symmetric with granting. `POST /grant` refuses
   * `trusted` permissions outright and sends them through the isolated host
   * approval channel, because granting is the act that can hand a plugin
   * server-side code execution. Withdrawal only ever narrows what a plugin
   * may do, so requiring the same ceremony would make the safe direction
   * harder than the dangerous one. Every tier can be revoked here.
   *
   * Missing manifest is NOT a refusal: a plugin whose files are gone may
   * still hold grants in the store, and being unable to withdraw them
   * because the thing holding them is broken would be exactly backwards.
   */
  app.delete('/:name/grant', validate(pluginGrantSchema), async (c) => {
    const name = param(c, 'name');
    try {
      assertPluginNameSegment(name);
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
    const { permissions } = getBody(c);
    if (!Array.isArray(permissions)) {
      return c.json(
        { success: false, error: 'permissions array required' },
        400,
      );
    }
    try {
      await revokeGrants(projectHomeDir, name, permissions);
      deps.eventBus?.emit(SERVER_EVENTS.PLUGINS_GRANTS_CHANGED, {
        name,
      });
      const reconciliation = pluginPermissionsNeedRuntimeReconciliation(
        permissions,
      )
        ? deps.grantReconciliation
          ? await deps.grantReconciliation.reconcile({
              pluginName: name,
              permissions,
            })
          : {
              status: 'incomplete' as const,
              failures: ['runtime-unavailable'],
            }
        : {
            status: 'completed' as const,
            effects: [] as const,
          };
      return c.json(
        {
          success: true,
          revoked: permissions,
          granted: getPluginGrants(projectHomeDir, name),
          reconciliation,
        },
        reconciliation.status === 'winding-down' ? 202 : 200,
      );
    } catch (error: unknown) {
      if (error instanceof PluginGrantsUnavailableError) {
        // Nothing was withdrawn; say why rather than reporting success for a
        // write that did not land (archive#1835's posture, applied to this verb).
        return c.json(
          {
            success: false,
            error: errorMessage(error),
            grantsUnavailable: true,
          },
          503,
        );
      }
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.post('/:name/fetch', validate(pluginFetchSchema), async (c) => {
    const name = param(c, 'name');
    try {
      assertPluginNameSegment(name);
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
    try {
      if (!hasGrantOrThrow(projectHomeDir, name, 'network.fetch')) {
        return c.json(
          {
            success: false,
            error: `Plugin '${name}' does not have network.fetch permission`,
          },
          403,
        );
      }
    } catch (error: unknown) {
      if (error instanceof PluginGrantsUnavailableError) {
        // Enforcement gate, fail-closed with the honest reason (archive#1835).
        return c.json(
          {
            success: false,
            error: errorMessage(error),
            grantsUnavailable: true,
          },
          503,
        );
      }
      throw error;
    }
    return c.json(
      {
        success: false,
        error:
          'Plugin fetch proxy is disabled until plugin execution identity is verifiable',
      },
      403,
    );
  });

  app.post('/fetch', validate(pluginFetchSchema), async (c) =>
    c.json(
      {
        success: false,
        error: 'Plugin fetch requires a named plugin route',
      },
      403,
    ),
  );

  app.all('/:name/*', async (c) => {
    const name = param(c, 'name');
    try {
      assertPluginNameSegment(name);
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
    const requestContext = buildPluginRequestContext(c, name);
    let manifest: PluginManifest | null;
    let artifact: PluginRuntimeArtifact | null;
    try {
      artifact = capturePluginRuntimeArtifact(
        pluginsDir,
        name,
        deps.packageMcpJournal,
      );
      manifest = artifact?.manifest ?? null;
    } catch (error: unknown) {
      if (isContextSafetyError(error)) {
        return c.json(
          manifestSafetyFailure(name, requestContext.correlationId, error),
          400,
        );
      }
      logger.error('Plugin public manifest read failed', {
        correlationId: requestContext.correlationId,
        error: errorMessage(error),
        path: requestContext.path,
        plugin: name,
      });
      return c.json(
        {
          correlationId: requestContext.correlationId,
          error: 'Plugin server route failed',
          success: false,
        },
        500,
      );
    }
    if (!manifest?.serverModule) {
      return c.json({ success: false, error: 'Plugin route not found' }, 404);
    }
    try {
      if (
        !artifact ||
        !readPluginGrantState(projectHomeDir, name, artifact).granted.includes(
          'plugin.server',
        )
      ) {
        return c.json(
          {
            success: false,
            error: `Plugin '${name}' does not have plugin.server permission`,
          },
          403,
        );
      }
    } catch (error: unknown) {
      if (error instanceof PluginGrantsUnavailableError) {
        // Enforcement gate, fail-closed with the honest reason (archive#1835).
        return c.json(
          {
            success: false,
            error: errorMessage(error),
            grantsUnavailable: true,
          },
          503,
        );
      }
      throw error;
    }

    let acquired: Awaited<
      ReturnType<typeof acquirePluginPublicServerModule>
    > | null = null;
    let loaded: LoadedPluginServerModule | null = null;

    try {
      acquired = await acquirePluginPublicServerModule(
        pluginsDir,
        name,
        manifest,
        logger,
        {
          journal: deps.packageMcpJournal,
          artifact: artifact ?? undefined,
          authorize: () =>
            !!artifact &&
            readPluginGrantState(
              projectHomeDir,
              name,
              artifact,
            ).granted.includes('plugin.server'),
        },
      );
      loaded = acquired?.loaded ?? null;
      if (!loaded) {
        return c.json({ success: false, error: 'Plugin route not found' }, 404);
      }

      const configValues = await readPluginServerSettings(
        projectHomeDir,
        name,
        manifest,
      );
      const routeApp = new Hono();
      const moduleContext: PluginServerModuleContext = {
        config: {
          all: () => ({ ...configValues }),
          get: (key: string) => configValues[key],
        },
        logger,
        pluginName: name,
        projectHomeDir,
        telemetry: {
          recordRoutingDecision: (attributes) => {
            routingDecision.add(1, { plugin: name, ...attributes });
          },
        },
      };

      const assertCurrent = () => {
        if (
          !acquired?.isCurrent() ||
          !artifact ||
          !readPluginGrantState(
            projectHomeDir,
            name,
            artifact,
          ).granted.includes('plugin.server')
        ) {
          throw new Error('Plugin execution is unavailable.');
        }
      };
      routeApp.onError((error) => {
        throw error;
      });

      routeApp.use('*', async (subc, next) => {
        assertCurrent();
        await loaded?.hooks?.onRequest?.(requestContext);
        assertCurrent();
        await next();
        assertCurrent();
        await loaded?.hooks?.onResponse?.({
          ...requestContext,
          status: subc.res.status,
        });
      });

      assertCurrent();
      await loaded.register(routeApp, moduleContext);
      assertCurrent();
      const routed = await routeApp.fetch(createScopedPluginRequest(c, name));
      const headers = new Headers(routed.headers);
      headers.set('x-station-correlation-id', requestContext.correlationId);
      pluginServerRequests.add(1, {
        method: requestContext.method,
        plugin: name,
        status: String(routed.status),
      });
      pluginServerRequestDuration.record(
        Date.now() - requestContext.startedAt,
        {
          method: requestContext.method,
          plugin: name,
        },
      );
      return new Response(routed.body, {
        headers,
        status: routed.status,
        statusText: routed.statusText,
      });
    } catch (error: unknown) {
      try {
        if (acquired?.isCurrent())
          await loaded?.hooks?.onError?.({ ...requestContext, error });
      } catch (hookError) {
        logger.error('Plugin server error hook failed', {
          correlationId: requestContext.correlationId,
          error: errorMessage(hookError),
          path: requestContext.path,
          plugin: name,
        });
      }
      pluginServerRequests.add(1, {
        method: requestContext.method,
        plugin: name,
        status: '500',
      });
      pluginServerRequestDuration.record(
        Date.now() - requestContext.startedAt,
        {
          method: requestContext.method,
          plugin: name,
        },
      );
      logger.error('Plugin server route failed', {
        correlationId: requestContext.correlationId,
        error: errorMessage(error),
        path: requestContext.path,
        plugin: name,
      });
      return c.json(
        {
          correlationId: requestContext.correlationId,
          error: 'Plugin server route failed',
          success: false,
        },
        500,
      );
    } finally {
      acquired?.release();
    }
  });
}
