/**
 * Plugin host-approval routes — the FIRST consumer of the ConsentTransaction
 * module (archive#3677).
 *
 * What lives here now: OPENING a trusted-permission request and POLLING its
 * status, both on the main API under the family's existing `access:manage`
 * tier (`src-server/security/pairing-route-scopes.ts`).
 *
 * What deliberately does NOT live here any more: the review page and the
 * decision. The old same-origin review path and its headers-only approval
 * (`sec-fetch-mode: navigate` + `sec-fetch-user: ?1` as the entire barrier)
 * are REMOVED, not kept as a fallback — a vulnerable fallback is the
 * vulnerability. Same-origin plugin code could script that page or POST the
 * approval inside its own click's user activation; Sec-Fetch headers prove a
 * navigation happened under activation, not that the user reviewed anything.
 * Reviewing and deciding happen only on the distinct-origin consent listener
 * (`src-server/runtime/consent/consent-listener.ts`), which additionally
 * requires an exact-Origin match, a one-use render nonce, and an
 * authenticated consent session, and revalidates the target immediately
 * before granting.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { type Context, Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import {
  browserVisibleHost,
  isBoundLocalGrantMintedOperator,
} from '../../security/runtime-request-security.js';
import {
  CONSENT_SESSION_COOKIE,
  type ConsentChannelService,
} from '../../services/consent/consent-channel.js';
import {
  CONSENT_TRANSACTION_TTL_MS,
  ConsentCommitRefusedError,
  type ConsentTargetSnapshot,
} from '../../services/consent/consent-transactions.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import {
  computePluginContentDigest,
  withPluginContentLock,
} from '../../services/plugins/plugin-content-integrity.js';
import type { PluginGrantReconciliationService } from '../../services/plugins/plugin-grant-reconciliation.js';
import { readPluginManifestFile } from '../../services/plugins/plugin-manifest-loader.js';
import {
  assertGrantablePermissions,
  getPermissionTier,
  grantPermissions,
  PluginContentUnavailableError,
  PluginGrantsUnavailableError,
} from '../../services/plugins/plugin-permissions.js';
import { consentTransactionOps } from '../../telemetry/metrics.js';
import { assertPluginNameSegment } from './plugin-install-shared.js';

const CONSENT_TARGET_KIND = 'plugin-trusted-permissions';

interface PluginHostApprovalRouteDeps {
  pluginsDir: string;
  projectHomeDir: string;
  eventBus?: EventBus;
  /**
   * The distinct-origin consent surface. Absent (or unavailable) means every
   * approval request refuses truthfully — approvals FAIL CLOSED while the
   * rest of Station stays usable (owner decision 3).
   */
  consentChannel?: ConsentChannelService;
  grantReconciliation?: PluginGrantReconciliationService;
}

/**
 * Canonical snapshot of exactly what an approval would grant. Re-derived at
 * decision time; any difference refuses the decision.
 *
 * Review HIGH 1: the fingerprint covers what EXECUTES, not just the manifest
 * projection. `contentDigest` is a SHA-256 over the plugin's entire on-disk
 * tree ({@link computePluginContentDigest}) — `serverModule` and everything
 * it can import — because the ordinary update route can replace all of that
 * via `git pull` while name/displayName/version stay equal, and a manifest
 * projection would then revalidate a grant the user never reviewed. What
 * the digest honestly cannot attest: code the plugin fetches at runtime
 * after being granted, and any mutation AFTER the grant commits — it proves
 * the decided tree is byte-identical to the reviewed tree, nothing more.
 * An underivable digest (unreadable tree) refuses rather than grants.
 */
async function derivePluginTrustTarget(
  pluginsDir: string,
  pluginName: string,
  permissions: readonly string[],
): Promise<{
  target: ConsentTargetSnapshot;
  displayName: string;
} | null> {
  const manifestPath = join(pluginsDir, pluginName, 'plugin.json');
  if (!existsSync(manifestPath)) return null;
  let manifest: Awaited<ReturnType<typeof readPluginManifestFile>>;
  try {
    manifest = await readPluginManifestFile(manifestPath);
    assertGrantablePermissions(manifest, [...permissions]);
  } catch {
    return null;
  }
  if (
    permissions.length === 0 ||
    permissions.some(
      (permission) => getPermissionTier(permission) !== 'trusted',
    )
  ) {
    return null;
  }
  const contentDigest = computePluginContentDigest(pluginsDir, pluginName);
  if (contentDigest === null) return null;
  const displayName = manifest.displayName || pluginName;
  return {
    displayName,
    target: {
      kind: CONSENT_TARGET_KIND,
      subject: pluginName,
      fingerprint: JSON.stringify({
        name: pluginName,
        displayName,
        version: manifest.version ?? null,
        permissions: [...permissions].sort(),
        contentDigest,
      }),
    },
  };
}

export function registerPluginHostApprovalRoutes(
  app: Hono,
  deps: PluginHostApprovalRouteDeps,
): void {
  const respondWithTransaction = (
    c: Context,
    channel: ConsentChannelService,
    transactionId: string,
    status: string,
  ) => {
    // archive#3752: the BROWSER's host, not the proxied one. Station's UI
    // proxy rewrites `Host` to the upstream address, and a review URL built
    // from that names a host the browser has no transaction cookie for, so
    // the review page refused every operator.
    const reviewUrl = channel.reviewUrlFor(
      browserVisibleHost({
        environment: c.env,
        header: (name) => c.req.header(name),
      }),
      transactionId,
    );
    // archive#3731: a review URL is the BROWSER's way in, and it is the only
    // way in for a browser. A caller that can decide in native OS chrome
    // needs none — the native routes never consult listener state — so
    // refusing it here made the native path's listener-independence
    // unreachable in production: with the listener down, nothing could be
    // ORIGINATED on any surface, so there was never anything to decide.
    // The predicate is the same one the native routes enforce and
    // `native-eligibility` reports, so what a caller is told it may do and
    // what it may actually do cannot drift.
    if (reviewUrl === null && !isBoundLocalGrantMintedOperator(c.req.raw)) {
      return c.json(
        {
          success: false,
          error:
            'The consent listener is unavailable, so approvals cannot be opened. Nothing was granted.',
        },
        503,
      );
    }
    const sessionSecret = channel.store.decisionSessionSecretFor(
      channel.tenantId,
      transactionId,
    );
    if (sessionSecret !== undefined) {
      // The transaction-bound consent session (bearer-only UIs): HttpOnly,
      // narrowed to the consent paths, and carrying only "may decide this
      // transaction". Deliberately not Secure so it reaches the plain-HTTP
      // consent listener on loopback/LAN hosts; its authority is bounded to
      // one transaction for one TTL.
      setCookie(c, CONSENT_SESSION_COOKIE, sessionSecret, {
        httpOnly: true,
        path: '/consent',
        sameSite: 'Strict',
        maxAge: Math.ceil(CONSENT_TRANSACTION_TTL_MS / 1000),
      });
    }
    return c.json({
      success: true,
      approval: { id: transactionId, status, reviewUrl },
    });
  };

  app.post('/host-approvals', async (c) => {
    const channel = deps.consentChannel;
    if (!channel) {
      return c.json(
        {
          success: false,
          error:
            'The consent surface is not configured on this runtime, so approvals are unavailable.',
        },
        503,
      );
    }
    const state = channel.state();
    // Same rule as the responder below: the listener being down only refuses
    // a caller that would have needed it (archive#3731).
    if (
      state.status !== 'listening' &&
      !isBoundLocalGrantMintedOperator(c.req.raw)
    ) {
      return c.json(
        {
          success: false,
          error: `Approvals are unavailable: ${state.reason}`,
        },
        503,
      );
    }
    const body = await c.req.json().catch(() => null);
    const pluginName = body?.pluginName;
    const permissions = body?.permissions;
    if (typeof pluginName !== 'string' || !Array.isArray(permissions)) {
      return c.json({ success: false, error: 'Invalid approval request' }, 400);
    }
    try {
      assertPluginNameSegment(pluginName);
    } catch {
      return c.json({ success: false, error: 'Invalid approval request' }, 400);
    }
    const normalized = Array.from(
      new Set(
        permissions.filter(
          (value): value is string => typeof value === 'string',
        ),
      ),
    );
    if (!existsSync(join(deps.pluginsDir, pluginName, 'plugin.json'))) {
      return c.json({ success: false, error: 'Plugin not found' }, 404);
    }
    const derived = await derivePluginTrustTarget(
      deps.pluginsDir,
      pluginName,
      normalized,
    );
    if (derived === null) {
      return c.json(
        {
          success: false,
          error: 'Host approval accepts trusted permissions only',
        },
        400,
      );
    }

    const existing = channel.store.findPendingByTarget(
      channel.tenantId,
      derived.target,
    );
    if (existing) {
      return respondWithTransaction(c, channel, existing.id, existing.status);
    }

    const created = channel.store.create({
      tenantId: channel.tenantId,
      target: derived.target,
      requester: { kind: 'plugin-ui', id: pluginName },
      // Review MED 5: the rate limit is charged to the AUTHENTICATED surface
      // this request passed — every caller here holds the same
      // `access:manage`-tier authority on this tenant's main API — never to
      // the body-supplied plugin name above (which is display attribution a
      // caller could vary for a fresh budget per name).
      rateKey: 'plugin-ui',
      description: {
        title: `Trust ${derived.displayName}?`,
        summary:
          'This separate consent page is not part of the plugin UI. Review the exact capabilities before enabling its server-side code.',
        items: normalized.map((permission) => ({
          label: permission,
          detail: 'Trusted access to Station host behavior',
        })),
        warning:
          'Only approve plugins whose source and publisher you trust. Trusted code can affect Station beyond its layout.',
        approveLabel: 'Approve trusted access',
        denyLabel: 'Deny',
      },
      revalidateTarget: async () => {
        const revalidated = await derivePluginTrustTarget(
          deps.pluginsDir,
          pluginName,
          normalized,
        );
        return revalidated?.target ?? null;
      },
      // Review HIGH 1: the decision's revalidate → grant-commit span runs
      // under the same per-plugin content lock the update and uninstall
      // routes take around their tree mutations, so content cannot change
      // between "fingerprint revalidated unchanged" and "grant committed".
      guardDecision: (fn) =>
        withPluginContentLock(deps.pluginsDir, pluginName, fn),
      commitApproval: async () => {
        let outcome: Awaited<ReturnType<typeof grantPermissions>>;
        try {
          outcome = await grantPermissions(
            deps.projectHomeDir,
            pluginName,
            normalized,
          );
        } catch (error) {
          if (error instanceof PluginGrantsUnavailableError) {
            // Nothing was granted; the transaction stays pending so it can be
            // retried once the store is recovered (archive#1835).
            throw new ConsentCommitRefusedError(
              'The permission grants store could not be read, so nothing was granted. Recover the store and open the approval again.',
            );
          }
          if (error instanceof PluginContentUnavailableError) {
            // Already fail-closed — an unhandled throw here refuses the
            // commit too. This only replaces a raw stack with the sentence
            // that says what happened: the plugin's tree became unreadable
            // between opening this approval and committing it, and a consent
            // to bytes cannot be recorded against bytes nobody can read
            // (archive#4288).
            throw new ConsentCommitRefusedError(
              `This plugin's installed files could not be read, so nothing was granted. Reinstall or repair '${pluginName}' and open the approval again.`,
            );
          }
          throw error;
        }
        // archive#4288, delta review MEDIUM 2. An approval given against a
        // `changed` binding withdraws everything else the plugin held, so the
        // broadcast carries what was actually derived rather than leaving
        // every listener to assume an approval only ever adds.
        const reconciled = deps.grantReconciliation
          ? await deps.grantReconciliation.reconcile({
              pluginName,
              permissions: [...new Set([...normalized, ...outcome.withdrawn])],
            })
          : {
              status: 'incomplete' as const,
              operationId: randomUUID(),
              generation: 0,
              failures: ['runtime-unavailable'] as const,
            };
        const reconciliation = {
          status: reconciled.status,
          operationId: reconciled.operationId,
          generation: reconciled.generation,
          ...('effects' in reconciled ? { effects: reconciled.effects } : {}),
          ...('failures' in reconciled
            ? { failures: reconciled.failures }
            : {}),
        };
        deps.eventBus?.emit(SERVER_EVENTS.PLUGINS_GRANTS_CHANGED, {
          name: pluginName,
          granted: outcome.granted,
          withdrawn: outcome.withdrawn,
          reconciliation,
        });
        return reconciliation;
      },
    });
    if (!created.ok) {
      consentTransactionOps.add(1, {
        result: created.reason,
        kind: CONSENT_TARGET_KIND,
      });
      return c.json(
        {
          success: false,
          error:
            created.reason === 'capacity'
              ? 'Too many host approvals are pending. Finish or retry an existing review.'
              : 'Too many approval requests were opened recently. Wait a moment and retry.',
        },
        429,
      );
    }
    consentTransactionOps.add(1, {
      result: 'created',
      kind: CONSENT_TARGET_KIND,
    });
    return respondWithTransaction(
      c,
      channel,
      created.transaction.id,
      created.transaction.status,
    );
  });

  app.get('/host-approvals/:id', (c) => {
    const channel = deps.consentChannel;
    const approval = channel?.store.get(channel.tenantId, c.req.param('id'));
    if (!approval) {
      return c.json({ success: false, error: 'Approval not found' }, 404);
    }
    return c.json({
      success: true,
      approval: {
        id: approval.id,
        status: approval.status,
        ...(approval.effect ? { reconciliation: approval.effect } : {}),
      },
    });
  });
}
