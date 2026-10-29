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
import { basename, dirname, join, resolve } from 'node:path';
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
  seatbeltSessionDirPrefix,
  seatbeltTempRoot,
  seatbeltWorkspaceRefusal,
  seatbeltWriteGrantKinds,
} from '../../security/confinement/seatbelt.js';
import { hasOAuthCredential } from '../auth/claude-auth.js';
import type {
  ClaudeSpawnLaunch,
  ClaudeSpawnWrap,
} from './claude-code-spawn.js';

/** The default confined Claude home's name under the confined root. */
const DEFAULT_CONFINED_HOME = 'claude';

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
 * The Station-owned configuration directory a confined session uses. It is
 * always under the confined root (`seatbeltConfigRoot`), which no
 * unconfined spawn uses: never the operator's `~/.claude`, a connection's
 * `configHome`, or an app home an unconfined session also runs in. A
 * selected credential profile or the app-home opt-in gets a confined twin
 * of its own, named after its app home; anything else the default.
 */
export function confinedClaudeConfigDir(
  appHomeEnv: Record<string, string> | undefined,
  stationHome: string,
): string {
  const root = seatbeltConfigRoot(stationHome);
  const configured = appHomeEnv?.CLAUDE_CONFIG_DIR?.trim();
  if (configured) {
    const dir = canonicalPath(resolve(configured));
    if (dirname(dir) === join(stationHome, 'app-homes'))
      return join(root, basename(dir));
  }
  return join(root, DEFAULT_CONFINED_HOME);
}

/**
 * The ambient variables a confined engine is given: what Claude Code, Node
 * and its tools need to run (paths, locale, terminal, TLS trust, proxies)
 * and Claude's and Anthropic's own settings, which carry the confined
 * credential. Everything else in Station's environment (`GH_TOKEN`,
 * `NPM_TOKEN`, cloud keys, `SSH_AUTH_SOCK`) stays out. Keys the operator
 * configured for this engine (the connection's `env`, the app-home layer)
 * pass as configured.
 */
const CONFINED_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'COLORTERM',
  'TERM_PROGRAM',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  '__CF_USER_TEXT_ENCODING',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'ENABLE_TOOL_SEARCH',
  'USE_BUILTIN_RIPGREP',
  // Identity and editor, not credentials.
  'EDITOR',
  'VISUAL',
]);
const CONFINED_ENV_PREFIXES = [
  'LC_',
  'CLAUDE_',
  'ANTHROPIC_',
  'DISABLE_',
  'MCP_',
  'MAX_THINKING_',
  'MAX_MCP_',
  'BASH_DEFAULT_',
  'BASH_MAX_',
  'GIT_AUTHOR_',
  'GIT_COMMITTER_',
];

/** Whether an ambient variable may reach the confined engine. */
export function confinedEnvAllows(key: string): boolean {
  return (
    CONFINED_ENV_KEYS.has(key) ||
    CONFINED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
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
  const tmpDir = canonicalPath(
    mkdtempSync(join(tempRoot, seatbeltSessionDirPrefix())),
  );
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
 * The engine spawn sent through `provider.confine`: only allowed ambient
 * variables and the operator's `configuredKeys` pass (`confinedEnvAllows`);
 * the configuration and temp directories are the Station-owned ones; the
 * secure-store override is dropped wherever it came from (the adapter does
 * not strip it itself), so nothing points at the operator's Keychain
 * namespace. Whatever `confine` returns is what is spawned. `pending` is the
 * provider's own pending posture for that spawn.
 */
export function confinedClaudeSpawn(
  provider: ConfinementProvider<SeatbeltEvidence>,
  launch: Pick<
    ConfinedClaudeLaunch,
    'workspace' | 'configDir' | 'tmpDir' | 'grants'
  >,
  configuredKeys: ReadonlySet<string> = new Set(),
): {
  wrap: ClaudeSpawnWrap;
  pending: () => PendingConfinementPosture<SeatbeltEvidence> | undefined;
} {
  let pending: PendingConfinementPosture<SeatbeltEvidence> | undefined;
  const wrap = (spawn: ClaudeSpawnLaunch): ClaudeSpawnLaunch => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(spawn.env))
      if (
        value !== undefined &&
        key !== 'CLAUDE_SECURESTORAGE_CONFIG_DIR' &&
        (confinedEnvAllows(key) || configuredKeys.has(key))
      )
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
