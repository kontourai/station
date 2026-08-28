/**
 * App-home profile status + explicit import (archive#896,
 * `docs/design/agent-engine-unification.md` §6.1's overlay model, channel
 * 2). Wave 1 supported `claude-runtime` only; wave 2 adds `codex-runtime`
 * to the same table (`APP_HOME_ENGINES`) — any other connection id 404s.
 * Mounted at `/api/connections` alongside (not merged into) `connections.ts`
 * so its `/agent/:id/app-home…` path never collides with that file's
 * `/agents` (plural, existing) or `/:id` (catch-all) routes.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  CredentialProfileApplicationProjection,
  CredentialRecoveryGroupProjection,
} from '@kontourai/station-contracts/connection-recovery';
import { Hono } from 'hono';
import { defaultClaudeGlobalConfigDirs } from '../../providers/adapters/claude-skills-materialization.js';
import {
  clearAppHomeProfile,
  ensureAppHomeProfile,
  type ImportClaudeGlobalSnapshotResult,
  importClaudeGlobalSnapshot,
  importCodexGlobalSnapshot,
  markAppHomeProfileImported,
  readAppHomeProfileStatus,
  readAppHomeProfileUsage,
} from '../../providers/app-home/app-home-profiles.js';
import {
  credentialProfileAppHomeDir,
  credentialProfileStorageId,
  ensureCredentialProfileAppHome,
} from '../../providers/app-home/credential-profile-registry.js';
import { detectClaudeAuthState } from '../../providers/auth/claude-auth.js';
import { type CliAuthState } from '../../providers/auth/cli-auth.js';
import {
  defaultCodexGlobalConfigDir,
  detectCodexAuthState,
} from '../../providers/auth/codex-auth.js';
import type { ConnectionService } from '../../services/connections/connection-service.js';
import {
  enrolmentCommand,
  verifyEnrolment,
} from '../../services/connections/credential-enrolment.js';
import { readCredentialUsage } from '../../services/connections/credential-usage.js';
import { appHomeCleared, appHomeImport } from '../../telemetry/metrics.js';
import {
  appHomeImportRequestSchema,
  credentialProfileApplyRequestSchema,
  credentialProfileEnrollmentRequestSchema,
  credentialProfileImportRequestSchema,
  credentialProfileRefSchema,
  credentialProfileUpsertRequestSchema,
  credentialRecoveryPolicyRequestSchema,
  errorMessage,
  getBody,
  param,
  validate,
} from '../schemas/schemas.js';

interface AppHomeEngine {
  provider: 'claude' | 'codex';
  credentialProfileEngineId: 'claude-code' | 'codex';
  globalDir: () => string;
  importSnapshot: (opts: {
    globalDir: string;
    profileDir: string;
    includeCredentials: boolean;
  }) => Promise<ImportClaudeGlobalSnapshotResult>;
  detectAuthState: (profileDir: string) => Promise<CliAuthState>;
  keychainAuthPossible: boolean;
}

/**
 * archive#896 wave 2: the two-entry engine table replacing wave 1's
 * claude-runtime-only guard. The claude entry preserves wave 1's behavior
 * byte-for-byte; the codex entry is new this wave (Step 4's import
 * allowlist, Step 3's `auth.json` auth detection).
 */
const APP_HOME_ENGINES: Record<string, AppHomeEngine> = {
  claude: {
    provider: 'claude',
    credentialProfileEngineId: 'claude-code',
    globalDir: () =>
      defaultClaudeGlobalConfigDirs()[0] ?? join(homedir(), '.claude'),
    importSnapshot: importClaudeGlobalSnapshot,
    detectAuthState: (dir) =>
      detectClaudeAuthState({ ...process.env, CLAUDE_CONFIG_DIR: dir }),
    // macOS auth lives in the Keychain, config-dir-independent — an
    // 'unauthenticated' profile authState there does not mean sign-in will
    // actually prompt (docs/design/connections-onboarding.md §1.1).
    keychainAuthPossible: process.platform === 'darwin',
  },
  codex: {
    provider: 'codex',
    credentialProfileEngineId: 'codex',
    globalDir: () => defaultCodexGlobalConfigDir(),
    importSnapshot: importCodexGlobalSnapshot,
    detectAuthState: (dir) => detectCodexAuthState(dir),
    // Codex auth is `auth.json`-based only — no macOS Keychain analog
    // (Ambiguity D); a `cli_auth_credentials_store = "keychain"` user reads
    // as `unauthenticated` here, disclosed in docs.
    keychainAuthPossible: false,
  },
};

function unsupportedConnectionResponse(id: string) {
  return {
    success: false as const,
    error: `App home profiles are not available for '${id}'.`,
  };
}

/** Plain-language messages for `ImportClaudeGlobalSnapshotResult`'s machine-readable `reason` — the raw reason string is still returned in `data.reason` for API/test consumers. */
const IMPORT_FAILURE_MESSAGES: Record<string, string> = {
  'global-config-dir-missing':
    'No global engine config folder was found to import from.',
  'global-config-dir-unreadable':
    'The global engine config folder could not be read.',
  'profile-dir-outside-app-homes-root':
    'The app home profile could not be resolved to a safe location.',
};

function importFailureMessage(reason: string | undefined): string {
  return (
    (reason && IMPORT_FAILURE_MESSAGES[reason]) ||
    `App home import failed${reason ? `: ${reason}` : '.'}`
  );
}

/**
 * archive#896 wave 2: DELETE-while-enabled guard copy — verbatim, this is the
 * spec (Accepted gap, Ambiguity F: the saved-config 409 proxy does not
 * close the window where a session already live under the profile keeps
 * running after a clear; documented in docs/design/connections-onboarding.md
 * §1.1, not solved this wave).
 *
 * MED (security review 1a028fde, accepted — no serialization built): the
 * `isUseAppHomeEnabled` check and the `clearAppHomeProfile` call below are
 * not atomic with a concurrent connection save — a save that flips
 * `useAppHome` back on between them can leave it enabled with the profile
 * just removed. This self-heals: `getAppHomeEnv`'s closure runs
 * `ensureAppHomeProfile` per session, lazily recreating the profile at the
 * next session start, and the only actor able to race this window is the
 * user's own UI acting on their own Station-owned config — not a
 * cross-user or cross-trust-boundary hazard.
 */
const APP_HOME_ENABLED_CLEAR_REFUSAL =
  'Turn off "Run sessions in a Station-managed app home" for this connection before clearing its app home.';

type CredentialRecoveryConnectionService = Pick<
  ConnectionService,
  | 'getConnection'
  | 'getCredentialRecovery'
  | 'upsertCredentialProfile'
  | 'deleteCredentialProfile'
  | 'setCredentialProfileEnrollment'
  | 'setCredentialRecoveryAutomaticPolicy'
  | 'applyCredentialProfile'
>;

export function createAppHomeRoutes(deps?: {
  isUseAppHomeEnabled?: (id: string) => Promise<boolean>;
  connectionService?: CredentialRecoveryConnectionService;
}) {
  const app = new Hono();

  const credentialRecoveryContext = async (
    id: string,
  ): Promise<
    | {
        engine?: AppHomeEngine;
        recovery: CredentialRecoveryGroupProjection;
        service: CredentialRecoveryConnectionService;
      }
    | undefined
  > => {
    const service = deps?.connectionService;
    if (!service) return undefined;
    const connection = await service.getConnection(id);
    if (
      connection?.kind !== 'agent' ||
      !connection.capabilities.includes('agent-runtime')
    ) {
      return undefined;
    }
    const recovery = await service.getCredentialRecovery(id);
    return { engine: APP_HOME_ENGINES[id], recovery, service };
  };

  const credentialRecoveryUnavailable = () => ({
    success: false as const,
    error: 'Credential recovery is not available for this connection.',
  });

  const credentialRecoveryConflict = (
    application?: CredentialProfileApplicationProjection,
  ) => ({
    success: false as const,
    error:
      'Credential recovery state changed before the request could complete.',
    ...(application ? { data: application } : {}),
  });

  const profileRefFromParam = (value: string) => {
    const parsed = credentialProfileRefSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  };

  // Credential recovery is a separate management surface. Unlike the legacy
  // app-home status route above, it never returns a profile directory: refs
  // are opaque registry identity only and resolve server-side to hashed paths.
  app.get('/agent/:id/credential-recovery', async (c) => {
    try {
      const context = await credentialRecoveryContext(param(c, 'id'));
      if (!context) return c.json(credentialRecoveryUnavailable(), 404);
      return c.json({ success: true, data: context.recovery });
    } catch {
      return c.json(
        { success: false, error: 'Credential recovery could not be loaded.' },
        500,
      );
    }
  });

  app.post(
    '/agent/:id/credential-recovery/profiles',
    validate(credentialProfileUpsertRequestSchema),
    async (c) => {
      try {
        const context = await credentialRecoveryContext(param(c, 'id'));
        if (!context) return c.json(credentialRecoveryUnavailable(), 404);
        const body = getBody(c) as { ref: string; label?: string };
        const data = await context.service.upsertCredentialProfile(
          param(c, 'id'),
          body,
        );
        const profile = data.profiles.find(
          (candidate) => candidate.ref === body.ref,
        );
        if (!profile) {
          return c.json(credentialRecoveryConflict(), 409);
        }
        return c.json({ success: true, data });
      } catch {
        return c.json(credentialRecoveryConflict(), 409);
      }
    },
  );

  app.delete('/agent/:id/credential-recovery/profiles/:ref', async (c) => {
    const ref = profileRefFromParam(param(c, 'ref'));
    if (!ref)
      return c.json({ success: false, error: 'Validation failed' }, 400);
    try {
      const context = await credentialRecoveryContext(param(c, 'id'));
      if (!context) return c.json(credentialRecoveryUnavailable(), 404);
      if (!context.recovery.profiles.some((profile) => profile.ref === ref)) {
        return c.json(
          { success: false, error: 'Credential profile not found.' },
          404,
        );
      }
      const data = await context.service.deleteCredentialProfile(
        param(c, 'id'),
        ref,
      );
      if (data.profiles.some((profile) => profile.ref === ref)) {
        return c.json(credentialRecoveryConflict(), 409);
      }
      return c.json({ success: true, data });
    } catch {
      return c.json(credentialRecoveryConflict(), 409);
    }
  });

  app.put(
    '/agent/:id/credential-recovery/profiles/:ref/enrollment',
    validate(credentialProfileEnrollmentRequestSchema),
    async (c) => {
      const ref = profileRefFromParam(param(c, 'ref'));
      if (!ref)
        return c.json({ success: false, error: 'Validation failed' }, 400);
      try {
        const context = await credentialRecoveryContext(param(c, 'id'));
        if (!context) return c.json(credentialRecoveryUnavailable(), 404);
        if (!context.recovery.profiles.some((profile) => profile.ref === ref)) {
          return c.json(
            { success: false, error: 'Credential profile not found.' },
            404,
          );
        }
        const body = getBody(c) as { enrolled: boolean };
        const data = await context.service.setCredentialProfileEnrollment(
          param(c, 'id'),
          ref,
          body.enrolled,
        );
        if (data.group.enrolledProfileRefs.includes(ref) !== body.enrolled) {
          return c.json(credentialRecoveryConflict(), 409);
        }
        return c.json({ success: true, data });
      } catch {
        return c.json(credentialRecoveryConflict(), 409);
      }
    },
  );

  app.put(
    '/agent/:id/credential-recovery/policy',
    validate(credentialRecoveryPolicyRequestSchema),
    async (c) => {
      try {
        const context = await credentialRecoveryContext(param(c, 'id'));
        if (!context) return c.json(credentialRecoveryUnavailable(), 404);
        const body = getBody(c) as { automatic: boolean };
        if (
          body.automatic &&
          context.recovery.application.capability === 'unsupported'
        ) {
          return c.json(
            {
              success: false,
              error:
                'Automatic credential recovery is unsupported for this connection.',
              data: context.recovery,
            },
            409,
          );
        }
        const data = await context.service.setCredentialRecoveryAutomaticPolicy(
          param(c, 'id'),
          body.automatic,
        );
        if (data.policy.automatic !== body.automatic) {
          return c.json(credentialRecoveryConflict(), 409);
        }
        return c.json({ success: true, data });
      } catch {
        return c.json(credentialRecoveryConflict(), 409);
      }
    },
  );

  app.post(
    '/agent/:id/credential-recovery/profiles/:ref/import',
    validate(credentialProfileImportRequestSchema),
    async (c) => {
      const ref = profileRefFromParam(param(c, 'ref'));
      if (!ref)
        return c.json({ success: false, error: 'Validation failed' }, 400);
      try {
        const context = await credentialRecoveryContext(param(c, 'id'));
        if (!context) return c.json(credentialRecoveryUnavailable(), 404);
        if (!context.engine)
          return c.json(credentialRecoveryUnavailable(), 404);
        if (!context.recovery.profiles.some((profile) => profile.ref === ref)) {
          return c.json(
            { success: false, error: 'Credential profile not found.' },
            404,
          );
        }
        const body = getBody(c) as { includeCredentials?: boolean };
        const includeCredentials = body.includeCredentials === true;
        const profileId = credentialProfileStorageId(
          context.engine.credentialProfileEngineId,
          ref,
        );
        const { dir } = await ensureCredentialProfileAppHome(
          context.engine.credentialProfileEngineId,
          ref,
        );
        const result = await context.engine.importSnapshot({
          globalDir: context.engine.globalDir(),
          profileDir: dir,
          includeCredentials,
        });
        let provenanceUpdated = false;
        if (result.outcome === 'completed' && result.copied.length > 0) {
          const marked = await markAppHomeProfileImported(profileId, dir);
          if (!marked.ok) {
            return c.json(
              {
                success: false,
                error:
                  'Credential profile import could not update its provenance.',
              },
              500,
            );
          }
          provenanceUpdated = true;
        }
        appHomeImport.add(1, {
          provider: context.engine.provider,
          outcome:
            result.outcome === 'completed'
              ? result.copied.length > 0
                ? 'copied'
                : 'nothing-copied'
              : 'failed',
          credentials: includeCredentials ? 'included' : 'excluded',
        });
        if (result.outcome === 'failed') {
          return c.json(
            { success: false, error: importFailureMessage(result.reason) },
            400,
          );
        }
        return c.json({
          success: true,
          data: {
            outcome: 'completed',
            copied: result.copied,
            skipped: result.skipped,
            provenanceUpdated,
          },
        });
      } catch {
        return c.json(
          {
            success: false,
            error: 'Credential profile import could not complete.',
          },
          400,
        );
      }
    },
  );

  app.post(
    '/agent/:id/credential-recovery/profiles/:ref/apply',
    validate(credentialProfileApplyRequestSchema),
    async (c) => {
      const ref = profileRefFromParam(param(c, 'ref'));
      if (!ref)
        return c.json({ success: false, error: 'Validation failed' }, 400);
      try {
        const context = await credentialRecoveryContext(param(c, 'id'));
        if (!context) return c.json(credentialRecoveryUnavailable(), 404);
        if (context.recovery.application.capability === 'unsupported') {
          return c.json(
            credentialRecoveryConflict(context.recovery.application),
            409,
          );
        }
        if (!context.recovery.profiles.some((profile) => profile.ref === ref)) {
          return c.json(
            { success: false, error: 'Credential profile not found.' },
            404,
          );
        }
        const body = getBody(c) as { confirmed: true; timeoutMs?: number };
        const data = await context.service.applyCredentialProfile(
          param(c, 'id'),
          ref,
          body,
        );
        if (data.outcome !== 'adopted') {
          return c.json(credentialRecoveryConflict(data), 409);
        }
        return c.json({ success: true, data });
      } catch {
        return c.json(
          {
            success: false,
            error: 'Credential profile application could not be completed.',
          },
          409,
        );
      }
    },
  );

  app.get('/agent/:id/app-home', async (c) => {
    const id = param(c, 'id');
    const engine = APP_HOME_ENGINES[id];
    if (!engine) {
      return c.json(unsupportedConnectionResponse(id), 404);
    }
    try {
      const status = await readAppHomeProfileStatus(id);
      const authState = await engine.detectAuthState(status.dir);
      const usage = status.exists
        ? await readAppHomeProfileUsage(id)
        : undefined;
      return c.json({
        success: true,
        data: {
          profileDir: status.dir,
          exists: status.exists,
          seededFrom: status.seededFrom,
          importedAt: status.importedAt,
          authState,
          keychainAuthPossible: engine.keychainAuthPossible,
          ...(usage ? { usage } : {}),
        },
      });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  /**
   * archive#3552: this engine's accounts and how much of each account's quota
   * the provider says is spent.
   *
   * One entry per credential Station can actually reach: the connection's own
   * signed-in account (the engine's global config) plus every enrolled
   * credential profile. Reading is per-credential and independent — one
   * account's failure never suppresses another's, and a failure is reported as
   * `unknown` with a reason rather than a zeroed meter.
   */
  /**
   * archive#3549: what to run to sign this profile in, and whether it already
   * is.
   *
   * The command is RETURNED, never spawned. The engine's login is interactive
   * and browser-based, so the caller surfaces it and the user runs it — a
   * background process that silently opened a browser would be exactly the
   * "never silent" violation the provisioning rules forbid.
   *
   * `authState` comes from asking the ENGINE, not from reading a credential
   * file: on macOS the credential can live in the Keychain, so an absent file
   * proves nothing.
   */
  app.get('/agent/:id/enrolment/:ref', async (c) => {
    const id = param(c, 'id');
    const engine = APP_HOME_ENGINES[id];
    if (!engine) return c.json(unsupportedConnectionResponse(id), 404);
    const ref = profileRefFromParam(param(c, 'ref'));
    if (!ref)
      return c.json({ success: false, error: 'Validation failed' }, 400);
    try {
      const recovery = await deps?.connectionService?.getCredentialRecovery(id);
      if (!recovery?.profiles.some((profile) => profile.ref === ref)) {
        return c.json(
          { success: false, error: 'Credential profile not found.' },
          404,
        );
      }
      const dir = credentialProfileAppHomeDir(
        engine.credentialProfileEngineId,
        ref,
      );
      const command = enrolmentCommand(engine.provider, dir);
      const verification = await verifyEnrolment(engine.provider, dir);
      return c.json({
        success: true,
        data: {
          profileDir: dir,
          authState: verification.state,
          ...(verification.detail ? { detail: verification.detail } : {}),
          command: {
            command: command.command,
            args: command.args,
            env: command.env,
            description: command.description,
          },
        },
      });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.get('/agent/:id/credential-usage', async (c) => {
    const id = param(c, 'id');
    const engine = APP_HOME_ENGINES[id];
    if (!engine) {
      return c.json(unsupportedConnectionResponse(id), 404);
    }
    try {
      const recovery = await deps?.connectionService?.getCredentialRecovery(id);
      const targets: Array<{ ref: string | null; label: string; dir: string }> =
        [
          {
            ref: null,
            label: "This connection's account",
            dir: engine.globalDir(),
          },
          ...(recovery?.profiles ?? []).map((profile) => ({
            ref: profile.ref,
            label: profile.label || profile.ref,
            dir: credentialProfileAppHomeDir(
              engine.credentialProfileEngineId,
              profile.ref,
            ),
          })),
        ];
      // Per-account isolation is the point of this route, and `Promise.all`
      // broke it: one account whose read REJECTED took down every other
      // account's reading with a 500 (independent review). The reader is now
      // fenced too, but the route must not depend on that — a rejection here
      // is this account's unknown, never everyone's failure.
      const credentials = await Promise.all(
        targets.map(async (target) => ({
          ref: target.ref,
          label: target.label,
          usage: await readCredentialUsage(engine.provider, target.dir).catch(
            () => ({
              status: 'unknown' as const,
              fetchedAt: new Date().toISOString(),
              reason: 'This account could not be read.',
            }),
          ),
        })),
      );
      return c.json({ success: true, data: { credentials } });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.delete('/agent/:id/app-home', async (c) => {
    const id = param(c, 'id');
    const engine = APP_HOME_ENGINES[id];
    if (!engine) {
      return c.json(unsupportedConnectionResponse(id), 404);
    }
    try {
      const enabled = (await deps?.isUseAppHomeEnabled?.(id)) === true;
      if (enabled) {
        return c.json(
          { success: false, error: APP_HOME_ENABLED_CLEAR_REFUSAL },
          409,
        );
      }
      const result = await clearAppHomeProfile(id);
      if (!result.ok) {
        return c.json(
          {
            success: false,
            error:
              'The app home profile could not be resolved to a safe location.',
          },
          500,
        );
      }
      appHomeCleared.add(1, { provider: engine.provider });
      return c.json({ success: true, data: { cleared: result.cleared } });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.post(
    '/agent/:id/app-home/import',
    validate(appHomeImportRequestSchema),
    async (c) => {
      const id = param(c, 'id');
      const engine = APP_HOME_ENGINES[id];
      if (!engine) {
        return c.json(unsupportedConnectionResponse(id), 404);
      }
      const body = getBody(c) as { includeCredentials?: boolean };
      const includeCredentials = body?.includeCredentials === true;
      try {
        const { dir: profileDir } = await ensureAppHomeProfile(id);
        const globalDir = engine.globalDir();
        const result = await engine.importSnapshot({
          globalDir,
          profileDir,
          includeCredentials,
        });

        // MED-3 / item 3 (security review, rounds 1-2): provenance
        // (`seededFrom: 'global-import'`) only ever advances on a
        // genuinely `'completed'` import that ACTUALLY COPIED SOMETHING —
        // an unreadable/absent global config dir never reaches here
        // (`outcome: 'failed'`, handled below), and a `'completed'` import
        // that copied zero entries (an empty global dir, or every entry
        // refused/skipped) is a real, honest success — it just has nothing
        // to record as imported, so the profile stays `seededFrom: 'empty'`
        // rather than being falsely marked as seeded from an import that
        // brought nothing over.
        let provenanceUpdateFailed = false;
        let provenanceUpdated = false;
        if (result.outcome === 'completed' && result.copied.length > 0) {
          const marked = await markAppHomeProfileImported(id, profileDir);
          provenanceUpdateFailed = !marked.ok;
          provenanceUpdated = marked.ok;
        }

        appHomeImport.add(1, {
          provider: engine.provider,
          outcome:
            result.outcome === 'completed'
              ? result.copied.length > 0
                ? 'copied'
                : 'nothing-copied'
              : 'failed',
          credentials: includeCredentials ? 'included' : 'excluded',
        });

        if (result.outcome === 'failed') {
          return c.json(
            {
              success: false,
              error: importFailureMessage(result.reason),
              data: { profileDir, ...result },
            },
            400,
          );
        }
        if (provenanceUpdateFailed) {
          // Files were genuinely copied (real, true) but Station's own
          // provenance marker could not be safely updated afterward (e.g.
          // it was replaced by something other than a regular file between
          // requests) — surfaced distinctly rather than silently reported
          // as a clean success.
          return c.json(
            {
              success: false,
              error:
                'App home import copied files but could not update its own provenance marker; the app home profile may be tampered with.',
              data: { profileDir, ...result },
            },
            500,
          );
        }
        return c.json({
          success: true,
          data: {
            profileDir,
            ...result,
            // Says so plainly (item 3): `false` whenever this import
            // copied nothing — the operation still succeeded, but the
            // profile's `seededFrom` provenance was NOT advanced.
            provenanceUpdated,
          },
        });
      } catch (error: unknown) {
        appHomeImport.add(1, {
          provider: engine.provider,
          outcome: 'error',
          credentials: includeCredentials ? 'included' : 'excluded',
        });
        return c.json({ success: false, error: errorMessage(error) }, 400);
      }
    },
  );

  return app;
}
