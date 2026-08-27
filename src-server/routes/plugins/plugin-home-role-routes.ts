/**
 * Workspace Home role routes (station#3122 stage 3 / station#3677 PR 2):
 * READ, REVOKE, and the GRANT channel on the distinct-origin consent surface.
 *
 * Why the grant rides ConsentTransaction: the granted party is same-origin
 * plugin JavaScript, so any write path an ordinary authenticated fetch can
 * reach is a write path the plugin can reach — and independent re-review
 * showed that even a `Sec-Fetch-Mode: navigate` + `Sec-Fetch-User: ?1` guard
 * cannot bind an approval to the consent page when the page itself is served
 * from the plugin's own origin: same-origin code can open the page and
 * rewrite it, or submit a top-level POST inside a click's user activation
 * without the page ever being seen. `POST /home-role/requests` therefore
 * mints no authority at all: it opens a ConsentTransaction whose review AND
 * decision live only on the distinct-origin consent listener
 * (`src-server/runtime/consent/consent-listener.ts`), where deciding
 * requires the transaction-bound consent session, an explicit
 * `consent:decide` grant, or local-native authority
 * (`consentDecisionAuthority`, pairing-route-scopes.ts).
 *
 * The three riders recorded on the parked channel (#3637) are closed by
 * construction here:
 * - Request-snapshot TOCTOU: the target fingerprint is derived in ONE pass
 *   ({@link deriveHomeRoleTrustTarget}), revalidated byte-for-byte before
 *   granting under the per-plugin content lock, and compared AGAIN against
 *   the commit-time derivation — the lock is a cooperative in-process mutex,
 *   so the fingerprint comparison, not the lock, is what refuses a tree that
 *   changed between revalidation and commit (#3720 review).
 * - Digest coverage: the fingerprint's `contentDigest` covers the plugin's
 *   entire on-disk tree ({@link computePluginContentDigest}), not just the
 *   pane bundle. What it honestly cannot attest: code the plugin fetches at
 *   runtime after being granted, bytes behind symlinks (targets contribute
 *   as strings, unfollowed), and mutation AFTER the grant commits — the
 *   stored grant's bundle-scoped `installDigest` is what lapses the role on
 *   later change, and a same-version change OUTSIDE the bundle does not
 *   lapse it (the consent copy says exactly that, no more).
 * - The description claims only what is derivable: the item list is framed
 *   as what the BUILT-IN Home shows (what the user replaces), never as a
 *   bound on the granted code — which is stated plainly to run as
 *   unrestricted trusted plugin code, per the projection contract's own
 *   consent-surface requirement (workspace-home-role.ts).
 *
 * Scope: the whole `/home-role/requests` family carries an explicit
 * `access:manage` override (pairing-route-scopes.ts) — request creation
 * returns the transaction-bound decision cookie, so it is authority-bearing
 * and must be no more reachable than the operator's own credential.
 *
 * `DELETE /home-role` — revocation. KNOWN, ACCEPTED DEFECT (availability,
 * not escalation — station#3673): this mutation is reachable by same-origin
 * plugin fetch, so plugin code can revoke the role holder. The result is
 * always the built-in floor — the fail-closed direction — which is why it
 * ships. It is deliberately NOT gated behind Sec-Fetch navigation headers:
 * Station's own revoke affordances (the Home provenance bar and fallback
 * notices) are script-shaped SDK fetches, and a header check here would be a
 * speed bump misreadable as a security boundary.
 */

import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import {
  createWorkspaceHomeRoleGrant,
  describeWorkspaceHomeProjection,
  isWorkspaceHomeRoleEligibleDescriptor,
  WORKSPACE_HOME_PROJECTION_FIELDS,
} from '@kontourai/station-contracts/workspace-home-role';
import { parseWorkspacePaneDescriptor } from '@kontourai/station-contracts/workspace-pane';
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
  DistributionProfileService,
  type InstalledPluginWorkspacePaneContribution,
} from '../../services/plugins/distribution-profile-service.js';
import {
  computePluginContentDigest,
  withPluginContentLock,
} from '../../services/plugins/plugin-content-integrity.js';
import {
  clearWorkspaceHomeRole,
  computeWorkspaceHomeRoleInstallDigest,
  deriveWorkspaceHomeRoleStatus,
  WorkspaceHomeRoleUnavailableError,
  writeWorkspaceHomeRoleGrant,
} from '../../services/plugins/workspace-home-role-service.js';
import { consentTransactionOps } from '../../telemetry/metrics.js';
import { assertPluginNameSegment } from './plugin-install-shared.js';

const CONSENT_TARGET_KIND = 'workspace-home-role';

export interface PluginHomeRoleRouteDeps {
  pluginsDir: string;
  projectHomeDir: string;
  eventBus?: EventBus;
  /**
   * The distinct-origin consent surface. Absent (or not listening) means the
   * grant channel refuses truthfully with 503 — Home role approvals FAIL
   * CLOSED while read/revoke and the rest of Station stay usable (#3677
   * owner decision 3).
   */
  consentChannel?: ConsentChannelService;
  /** Injectable for tests; defaults to a fresh read of the installed inventory. */
  listContributions?: () => InstalledPluginWorkspacePaneContribution[];
}

/**
 * One snapshot of exactly what an approval would grant, derived in a single
 * pass so labels and digests cannot come from different instants (rider 1).
 * Returns null whenever any part is underivable — an unreadable tree or an
 * ineligible pane refuses rather than grants.
 */
function deriveHomeRoleTrustTarget(
  deps: {
    pluginsDir: string;
    listContributions: () => InstalledPluginWorkspacePaneContribution[];
  },
  pluginName: string,
  paneId: string,
): {
  target: ConsentTargetSnapshot;
  live: InstalledPluginWorkspacePaneContribution;
  paneName: string;
  installDigest: string;
} | null {
  const live = deps
    .listContributions()
    .find(
      (entry) =>
        entry.pluginName === pluginName &&
        entry.enabled &&
        entry.descriptor.id === paneId,
    );
  if (!live) return null;
  const descriptor = parseWorkspacePaneDescriptor(live.descriptor);
  if (!descriptor || !isWorkspaceHomeRoleEligibleDescriptor(descriptor)) {
    return null;
  }
  // Rider 2: the consent fingerprint covers the ENTIRE tree — the ordinary
  // update route can replace everything via `git pull` while name and
  // version stay equal, and a narrower projection would revalidate a grant
  // the user never reviewed.
  const contentDigest = computePluginContentDigest(deps.pluginsDir, pluginName);
  if (contentDigest === null) return null;
  // The bundle-scoped digest the STORED grant carries: this is what the
  // status derivation compares on every later read to lapse the role.
  const installDigest = computeWorkspaceHomeRoleInstallDigest(
    deps.pluginsDir,
    pluginName,
  );
  if (installDigest === null) return null;
  return {
    live,
    paneName: descriptor.name,
    installDigest,
    target: {
      kind: CONSENT_TARGET_KIND,
      subject: pluginName,
      fingerprint: JSON.stringify({
        pluginName,
        paneId,
        paneName: descriptor.name,
        version: live.contribution.version ?? null,
        projectionFields: [...WORKSPACE_HOME_PROJECTION_FIELDS].sort(),
        contentDigest,
        installDigest,
      }),
    },
  };
}

export function registerPluginHomeRoleRoutes(
  app: Hono,
  deps: PluginHomeRoleRouteDeps,
): void {
  const listContributions =
    deps.listContributions ??
    (() =>
      new DistributionProfileService(
        deps.projectHomeDir,
      ).listPluginWorkspacePaneContributions());

  app.get('/home-role', (c) => {
    try {
      return c.json({
        success: true,
        status: deriveWorkspaceHomeRoleStatus({
          projectHomeDir: deps.projectHomeDir,
          pluginsDir: deps.pluginsDir,
          listContributions,
        }),
      });
    } catch (error) {
      if (error instanceof WorkspaceHomeRoleUnavailableError) {
        return c.json(
          { success: false, error: 'Home role store is unavailable' },
          503,
        );
      }
      throw error;
    }
  });

  app.delete('/home-role', async (c) => {
    try {
      await clearWorkspaceHomeRole(deps.projectHomeDir);
    } catch (error) {
      if (error instanceof WorkspaceHomeRoleUnavailableError) {
        return c.json(
          { success: false, error: 'Home role store is unavailable' },
          503,
        );
      }
      throw error;
    }
    deps.eventBus?.emit(SERVER_EVENTS.PLUGINS_GRANTS_CHANGED, {
      name: 'workspace-home-role',
    });
    return c.json({ success: true });
  });

  /**
   * The panes that could hold the Home role right now. Read-only, derived
   * from the same eligibility predicate the grant constructor re-checks —
   * listing a pane here mints nothing.
   */
  app.get('/home-role/candidates', (c) => {
    const candidates = listContributions().flatMap((entry) => {
      if (!entry.enabled) return [];
      const descriptor = parseWorkspacePaneDescriptor(entry.descriptor);
      if (!descriptor || !isWorkspaceHomeRoleEligibleDescriptor(descriptor)) {
        return [];
      }
      return [
        {
          pluginName: entry.pluginName,
          paneId: descriptor.id,
          name: descriptor.name,
          version: entry.contribution.version ?? null,
        },
      ];
    });
    return c.json({ success: true, candidates });
  });

  const respondWithTransaction = (
    c: Context,
    channel: ConsentChannelService,
    transactionId: string,
    status: string,
  ) => {
    // station#3752: the BROWSER's host, not the proxied one. Station's UI
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
    // station#3731: a review URL is the BROWSER's way in, and only a browser
    // needs one. A caller that can decide in native OS chrome does not, and
    // refusing it here left the native path's listener-independence
    // unreachable — with the listener down nothing could be ORIGINATED, so
    // there was never anything to decide. Same predicate the native routes
    // enforce, so the claim and the enforcement cannot drift.
    if (reviewUrl === null && !isBoundLocalGrantMintedOperator(c.req.raw)) {
      return c.json(
        {
          success: false,
          error:
            'The consent listener is unavailable, so Home role approvals cannot be opened. Nothing was granted.',
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
      // narrowed to the consent paths, carrying only "may decide this
      // transaction" for one TTL. Deliberately not Secure so it reaches the
      // plain-HTTP consent listener on loopback/LAN hosts.
      setCookie(c, CONSENT_SESSION_COOKIE, sessionSecret, {
        httpOnly: true,
        path: '/consent',
        sameSite: 'Strict',
        maxAge: Math.ceil(CONSENT_TRANSACTION_TTL_MS / 1000),
      });
    }
    return c.json({
      success: true,
      request: { id: transactionId, status, reviewUrl },
    });
  };

  app.post('/home-role/requests', async (c) => {
    const channel = deps.consentChannel;
    if (!channel) {
      return c.json(
        {
          success: false,
          error:
            'The consent surface is not configured on this runtime, so Home role approvals are unavailable.',
        },
        503,
      );
    }
    const state = channel.state();
    // Same rule as the responder above (station#3731).
    if (
      state.status !== 'listening' &&
      !isBoundLocalGrantMintedOperator(c.req.raw)
    ) {
      return c.json(
        {
          success: false,
          error: `Home role approvals are unavailable: ${state.reason}`,
        },
        503,
      );
    }
    const body = await c.req.json().catch(() => null);
    const pluginName = body?.pluginName;
    const paneId = body?.paneId;
    if (typeof pluginName !== 'string' || typeof paneId !== 'string') {
      return c.json(
        { success: false, error: 'Invalid Home role request' },
        400,
      );
    }
    try {
      assertPluginNameSegment(pluginName);
    } catch {
      return c.json(
        { success: false, error: 'Invalid Home role request' },
        400,
      );
    }
    const derived = deriveHomeRoleTrustTarget(
      { pluginsDir: deps.pluginsDir, listContributions },
      pluginName,
      paneId,
    );
    if (derived === null) {
      return c.json(
        {
          success: false,
          error:
            'That pane is not eligible to hold the Home role right now. It must be an enabled, trusted plugin pane that supports standalone placement.',
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
      // The rate limit is charged to the AUTHENTICATED surface this request
      // passed, never to the body-supplied plugin name (which a caller could
      // vary for a fresh budget per name).
      rateKey: 'plugin-ui',
      description: {
        // Rider 3, corrected by the #3720 review: the first cut framed the
        // item list as "readable by the Home pane through the projection" —
        // exactly the false bound the contract's own doc comment
        // (WORKSPACE_HOME_PROJECTION_FIELD_DESCRIPTIONS) forbids a consent
        // surface to present. The list is what the BUILT-IN Home shows —
        // what the user is replacing — and the granted code's access is
        // stated plainly as unbounded trusted code, because that is what a
        // trusted-plugin-react mount is.
        title: `Let ${derived.paneName} render Home?`,
        summary:
          `Approving replaces this Station's built-in Home page with the "${derived.paneName}" pane from the plugin "${pluginName}". ` +
          'The list below is what the built-in Home shows today — what you would be replacing. ' +
          'The built-in Home remains available as the fallback and from the revoke control on the Home surface. ' +
          'This separate consent page is not part of the plugin UI.',
        items: describeWorkspaceHomeProjection().map((line) => ({
          label: line,
          detail: 'Shown by the built-in Home you are replacing',
        })),
        warning:
          'Only approve a plugin whose source and publisher you trust. Its Home pane runs as trusted plugin code with the same unrestricted access as any trusted plugin surface — this list is not a limit on it. Changing the plugin version or its Home pane code lapses this grant until it is approved again.',
        approveLabel: 'Grant the Home role',
        denyLabel: 'Keep the built-in Home',
      },
      revalidateTarget: async () => {
        const revalidated = deriveHomeRoleTrustTarget(
          { pluginsDir: deps.pluginsDir, listContributions },
          pluginName,
          paneId,
        );
        return revalidated?.target ?? null;
      },
      // Rider 1: the decision's revalidate → grant-commit span runs under the
      // same per-plugin content lock the update and uninstall routes take
      // around their tree mutations, so content cannot change between
      // "fingerprint revalidated unchanged" and "grant committed".
      guardDecision: (fn) =>
        withPluginContentLock(deps.pluginsDir, pluginName, fn),
      commitApproval: async () => {
        // Re-derived inside the decision guard, then COMPARED byte-for-byte
        // against the reviewed fingerprint. The first cut asserted the two
        // "cannot differ" because revalidateTarget had just proved the tree
        // unchanged — a claim nothing computed (#3720 review, HIGH): the
        // content lock is a cooperative in-process mutex, so an external
        // writer mutating between revalidation and this derivation would
        // have committed a descriptor and digest the user never reviewed.
        // Now a divergent derivation refuses instead of granting.
        const committed = deriveHomeRoleTrustTarget(
          { pluginsDir: deps.pluginsDir, listContributions },
          pluginName,
          paneId,
        );
        if (committed === null) {
          throw new ConsentCommitRefusedError(
            'The pane is no longer eligible, so nothing was granted. Open a new request to review the current install.',
          );
        }
        if (committed.target.fingerprint !== derived.target.fingerprint) {
          throw new ConsentCommitRefusedError(
            'The plugin changed while the approval was being decided, so nothing was granted. Open a new request to review the current install.',
          );
        }
        const grant = createWorkspaceHomeRoleGrant({
          descriptor: committed.live.descriptor,
          contribution: committed.live.contribution,
          grantedAt: new Date().toISOString(),
          projectionFields: WORKSPACE_HOME_PROJECTION_FIELDS,
        });
        if (grant === null) {
          throw new ConsentCommitRefusedError(
            'The grant could not be constructed from the current install, so nothing was granted.',
          );
        }
        try {
          await writeWorkspaceHomeRoleGrant(
            deps.projectHomeDir,
            grant,
            committed.installDigest,
          );
        } catch (error) {
          if (error instanceof WorkspaceHomeRoleUnavailableError) {
            throw new ConsentCommitRefusedError(
              'The Home role store could not be written, so nothing was granted. Recover the store and open the approval again.',
            );
          }
          throw error;
        }
        deps.eventBus?.emit(SERVER_EVENTS.PLUGINS_GRANTS_CHANGED, {
          name: 'workspace-home-role',
        });
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
              ? 'Too many Home role requests are pending. Finish or retry an existing review.'
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

  app.get('/home-role/requests/:id', (c) => {
    const channel = deps.consentChannel;
    const request = channel?.store.get(channel.tenantId, c.req.param('id'));
    if (!request || request.target.kind !== CONSENT_TARGET_KIND) {
      return c.json(
        { success: false, error: 'Home role request not found' },
        404,
      );
    }
    return c.json({
      success: true,
      request: { id: request.id, status: request.status },
    });
  });
}
