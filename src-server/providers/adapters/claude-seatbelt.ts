/**
 * #2494: what the Claude adapter needs to run a session under Station's
 * Seatbelt profile: the Station-owned configuration directory, the
 * credential check that decides whether a confined session can authenticate
 * at all, and the spawn wrapper that sends the engine spawn through the
 * provider's `confine`.
 *
 * A confined engine never reads the operator's Keychain (the profile hides
 * it) and never writes the operator's `~/.claude`. It authenticates only
 * with a credential that needs no operator state: one in its environment,
 * or one enrolled as a file in its Station-owned configuration directory.
 * The operator's own login is never copied there: Claude rotates its
 * refresh token on every refresh, so two holders of one login break each
 * other.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type {
  ConfinementFallbackReason,
  ConfinementWriteGrant,
} from '@kontourai/station-contracts/execution-confinement';
import type {
  ConfinementProvider,
  ConfinementSpawnSpec,
  PendingConfinementPosture,
} from '../../security/confinement/confinement-provider.js';
import {
  canonicalPath,
  discoverSeatbeltGitLayout,
  type SeatbeltBounds,
  type SeatbeltEvidence,
  seatbeltConfigRoot,
  seatbeltGrants,
  seatbeltHiddenPaths,
  seatbeltTempRoot,
  seatbeltWorkspaceRefusal,
  seatbeltWriteGrantKinds,
} from '../../security/confinement/seatbelt.js';
import { hasOAuthCredential } from '../auth/claude-auth.js';
import type {
  ClaudeSpawnLaunch,
  ClaudeSpawnWrap,
} from './claude-code-spawn.js';

/** The app-home id of the default Station-owned confined Claude home. */
export const CONFINED_CLAUDE_APP_HOME_ID = 'claude-confined';

/** Environment variables that carry a Claude credential by themselves. */
const CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

/** The setup step a missing confined credential names. */
export const CONFINED_CLAUDE_CREDENTIAL_SETUP =
  "Give confined Claude sessions a credential of their own: set ANTHROPIC_API_KEY, or a CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`, in the Claude connection's environment. Until then a workspace full-access Claude session runs at Auto.";

/**
 * The Station-owned configuration directory a confined session uses: the
 * selected credential profile's or app home's directory when it is one of
 * Station's app homes, else Station's default confined Claude home. A
 * connection's `configHome` is the operator's to choose, so it is never
 * used.
 */
export function confinedClaudeConfigDir(
  appHomeEnv: Record<string, string> | undefined,
  stationHome: string,
): string {
  const root = seatbeltConfigRoot(stationHome);
  const configured = appHomeEnv?.CLAUDE_CONFIG_DIR?.trim();
  if (configured) {
    const dir = canonicalPath(resolve(configured));
    if (dirname(dir) === root) return dir;
  }
  return join(root, CONFINED_CLAUDE_APP_HOME_ID);
}

export type ConfinedClaudeCredential =
  | { available: true; source: 'environment' | 'config-dir' }
  | { available: false };

/**
 * Whether a confined Claude session can authenticate: a non-empty
 * credential variable in its environment, or an OAuth credential file in
 * its configuration directory. Read only: no login, no Keychain, no CLI.
 */
export function confinedClaudeCredential(
  env: Readonly<Record<string, string | undefined>>,
  configDir: string,
): ConfinedClaudeCredential {
  if (CREDENTIAL_ENV_KEYS.some((key) => env[key]?.trim()))
    return { available: true, source: 'environment' };
  try {
    if (
      hasOAuthCredential(
        JSON.parse(readFileSync(join(configDir, '.credentials.json'), 'utf8')),
      )
    )
      return { available: true, source: 'config-dir' };
  } catch {
    // Absent or unreadable: no credential there.
  }
  return { available: false };
}

/** A confined launch, prepared before the engine is spawned. */
export interface ConfinedClaudeLaunch {
  workspace: string;
  configDir: string;
  tmpDir: string;
  grants: ConfinementSpawnSpec['grants'];
  bounds: SeatbeltBounds;
  /** Kinds of the grants, or `undefined` when any reaches out of bounds. */
  writeGrants: ConfinementWriteGrant[] | undefined;
  cleanup: () => void;
}

export interface ConfinedClaudeDecisionInput {
  cwd: string | undefined;
  appHomeEnv: Record<string, string> | undefined;
  /** The environment the engine would be spawned with. */
  env: Readonly<Record<string, string | undefined>>;
  /** Whether the start is pinned to the global configuration root. */
  globalConfigPinned: boolean;
  stationHome: string;
  home?: string;
}

/**
 * Why a start that asked for Seatbelt runs at Auto with nothing engaged
 * instead, derived in order from checks, or the configuration directory a
 * confined start uses.
 */
export function confinedClaudeDecision(
  input: ConfinedClaudeDecisionInput,
):
  | { fallback: ConfinementFallbackReason }
  | { configDir: string; workspace: string } {
  if (input.globalConfigPinned) return { fallback: 'config-root-pinned' };
  const home = canonicalPath(input.home ?? homedir());
  const workspace = input.cwd ? canonicalPath(resolve(input.cwd)) : undefined;
  if (
    !workspace ||
    seatbeltWorkspaceRefusal(workspace, {
      home,
      stationHome: input.stationHome,
    })
  )
    return { fallback: 'workspace-too-broad' };
  const configDir = confinedClaudeConfigDir(
    input.appHomeEnv,
    input.stationHome,
  );
  if (!confinedClaudeCredential(input.env, configDir).available)
    return { fallback: 'confined-credential-unavailable' };
  return { configDir, workspace };
}

/**
 * Creates the session's directories and derives its grants. Nothing is
 * spawned here; a launch whose grants reach out of bounds is still
 * returned, with `writeGrants` undefined, for the caller to refuse.
 */
export async function prepareConfinedClaudeLaunch(input: {
  workspace: string;
  configDir: string;
  stationHome: string;
  home?: string;
  stationRoot?: string;
}): Promise<ConfinedClaudeLaunch> {
  mkdirSync(input.configDir, { recursive: true, mode: 0o700 });
  const tempRoot = seatbeltTempRoot(input.stationHome);
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const tmpDir = canonicalPath(mkdtempSync(join(tempRoot, 'session-')));
  const configDir = canonicalPath(input.configDir);
  const home = canonicalPath(input.home ?? homedir());
  const git = await discoverSeatbeltGitLayout(input.workspace);
  const { hidden, readable } = seatbeltHiddenPaths({
    home,
    stationHome: input.stationHome,
    ...(input.stationRoot ? { stationRoot: input.stationRoot } : {}),
  });
  const grants = seatbeltGrants({
    workspace: input.workspace,
    stationTempDir: tmpDir,
    stationConfigDir: configDir,
    ...(git ? { git } : {}),
    hidden,
    readable,
  });
  const bounds: SeatbeltBounds = {
    workspace: input.workspace,
    stationHome: input.stationHome,
    home,
    ...(git ? { git } : {}),
  };
  return {
    workspace: input.workspace,
    configDir,
    tmpDir,
    grants,
    bounds,
    writeGrants: seatbeltWriteGrantKinds(grants, bounds),
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/**
 * The engine spawn sent through `provider.confine`: the configuration and
 * temp directories are the Station-owned ones (and the secure-store
 * override is dropped, so nothing points at the operator's Keychain
 * namespace), and whatever `confine` returns is what is spawned. `pending`
 * is the provider's own pending posture for that spawn.
 */
export function confinedClaudeSpawn(
  provider: ConfinementProvider<SeatbeltEvidence>,
  launch: Pick<
    ConfinedClaudeLaunch,
    'workspace' | 'configDir' | 'tmpDir' | 'grants'
  >,
): {
  wrap: ClaudeSpawnWrap;
  pending: () => PendingConfinementPosture<SeatbeltEvidence> | undefined;
} {
  let pending: PendingConfinementPosture<SeatbeltEvidence> | undefined;
  const wrap = (spawn: ClaudeSpawnLaunch): ClaudeSpawnLaunch => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(spawn.env))
      if (value !== undefined && key !== 'CLAUDE_SECURESTORAGE_CONFIG_DIR')
        env[key] = value;
    env.CLAUDE_CONFIG_DIR = launch.configDir;
    env.TMPDIR = launch.tmpDir;
    const confined = provider.confine({
      command: spawn.command,
      args: spawn.args,
      cwd: launch.workspace,
      env,
      grants: launch.grants,
      network: 'full',
    });
    pending = confined.pending;
    return {
      command: confined.spec.command,
      args: confined.spec.args,
      cwd: confined.spec.cwd,
      env: { ...confined.spec.env },
    };
  };
  return { wrap, pending: () => pending };
}
