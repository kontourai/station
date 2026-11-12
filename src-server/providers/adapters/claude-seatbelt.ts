/**
 * #2494: what the Claude adapter needs to run a session under Station's
 * Seatbelt profile, or (#4770) its bubblewrap sandbox on Linux: the
 * Station-owned configuration directory, the credential check that decides
 * whether a confined session can authenticate at all, and the spawn wrapper
 * that sends the engine spawn through the provider's `confine`.
 *
 * A confined engine never reads the operator's Keychain or login keyring
 * (the profile hides it) and never writes the operator's `~/.claude`. It
 * authenticates only
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
  ConfinementMechanism,
  ConfinementWriteGrant,
} from '@kontourai/station-contracts/execution-confinement';
import {
  bubblewrapArgs,
  bubblewrapConfinementProvider,
  bubblewrapGrants,
  bubblewrapHiddenPaths,
  bubblewrapWorkspaceRefusal,
  bubblewrapWriteGrantKinds,
} from '../../security/confinement/bubblewrap.js';
import type {
  ConfinementProvider,
  ConfinementSpawnSpec,
  PendingConfinementPosture,
} from '../../security/confinement/confinement-provider.js';
import type {
  EgressBroker,
  EgressTarget,
} from '../../security/confinement/egress-broker.js';
import { normalizeEgressHost } from '../../security/confinement/egress-broker.js';
import {
  canonicalPath,
  discoverSeatbeltGitLayout,
  type SeatbeltBounds,
  type SeatbeltEvidence,
  seatbeltConfigRoot,
  seatbeltConfinementProvider,
  seatbeltGrants,
  seatbeltHiddenPaths,
  seatbeltSessionDirPrefix,
  seatbeltTempRoot,
  seatbeltWorkspaceRefusal,
  seatbeltWriteGrantKinds,
} from '../../security/confinement/seatbelt.js';
import { errorMessage } from '../../utils/error-message.js';
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

/**
 * #4770: the Station-applied mechanisms a confined Claude start wraps its
 * engine spawn in: Seatbelt on macOS, bubblewrap on Linux. Both prepare the
 * same Station-owned directories, environment and credential, and both are
 * observed from the same evidence (`SeatbeltEvidence`).
 */
export type ClaudeSpawnWrapMechanism = Extract<
  ConfinementMechanism,
  'seatbelt' | 'bubblewrap'
>;

/** Whether a plan's mechanism is one the Claude adapter wraps the spawn in. */
export function isClaudeSpawnWrapMechanism(
  mechanism: ConfinementMechanism | undefined,
): mechanism is ClaudeSpawnWrapMechanism {
  return mechanism === 'seatbelt' || mechanism === 'bubblewrap';
}

/** How a refusal names a spawn-wrapped mechanism to a person. */
export function claudeSpawnWrapLabel(
  mechanism: ClaudeSpawnWrapMechanism,
): string {
  return mechanism === 'bubblewrap' ? 'bubblewrap sandbox' : 'Seatbelt profile';
}

/** The server's own provider for a spawn-wrapped mechanism. */
export function claudeSpawnWrapProvider(
  mechanism: ClaudeSpawnWrapMechanism,
): ConfinementProvider<SeatbeltEvidence> {
  return mechanism === 'bubblewrap'
    ? bubblewrapConfinementProvider
    : seatbeltConfinementProvider;
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
  /** Why the sandbox's arguments could not be built, when they could not. */
  buildError?: string;
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
  /**
   * #4770: the mechanism the plan names (Seatbelt by default). Under
   * bubblewrap a workspace inside or containing a path the sandbox hides is
   * too broad as well (`bubblewrapWorkspaceRefusal`).
   */
  mechanism?: ClaudeSpawnWrapMechanism;
  stationRoot?: string;
}

/**
 * The credential step of {@link confinedClaudeDecision}: the configuration
 * directory a confined start would use, and whether a credential usable
 * there exists. It needs no workspace, so the confinement preflight (#4774)
 * calls it too; the decision calls it, so the two cannot answer differently
 * for the same inputs.
 */
export function confinedClaudeCredentialCheck(
  input: Pick<
    ConfinedClaudeDecisionInput,
    'appHomeEnv' | 'env' | 'stationHome'
  >,
): { configDir: string; credential: ConfinedClaudeCredential } {
  const configDir = confinedClaudeConfigDir(
    input.appHomeEnv,
    input.stationHome,
  );
  return {
    configDir,
    credential: confinedClaudeCredential(input.env, configDir),
  };
}

/**
 * Why a start that asked for Seatbelt or bubblewrap runs at Auto with
 * nothing engaged instead, derived in order from checks, or the
 * configuration directory a confined start uses.
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
    }) ||
    (input.mechanism === 'bubblewrap' &&
      bubblewrapWorkspaceRefusal(
        workspace,
        bubblewrapHiddenPaths({
          home,
          stationHome: input.stationHome,
          ...(input.stationRoot ? { stationRoot: input.stationRoot } : {}),
        }).hidden,
      ))
  )
    return { fallback: 'workspace-too-broad' };
  const { configDir, credential } = confinedClaudeCredentialCheck(input);
  if (!credential.available)
    return { fallback: 'confined-credential-unavailable' };
  return { configDir, workspace };
}

/**
 * The kinds of the writes a bubblewrap launch with `grants` would allow,
 * read from the arguments bubblewrap would be given, or `undefined` when
 * those reach out of bounds or cannot be built at all.
 */
function bubblewrapLaunchWriteGrants(
  workspace: string,
  grants: ConfinementSpawnSpec['grants'],
  bounds: SeatbeltBounds,
): { writeGrants?: ConfinementWriteGrant[]; buildError?: string } {
  try {
    const writeGrants = bubblewrapWriteGrantKinds(
      bubblewrapArgs({
        command: '/bin/true',
        args: [],
        cwd: workspace,
        env: {},
        grants,
        network: 'full',
      }),
      bounds,
    );
    return writeGrants ? { writeGrants } : {};
  } catch (error) {
    return { buildError: errorMessage(error) };
  }
}

/**
 * Creates the session's directories and derives its grants for
 * `mechanism` (Seatbelt by default). Nothing is spawned here; a launch
 * whose grants reach out of bounds is still returned, with `writeGrants`
 * undefined, for the caller to refuse.
 */
export async function prepareConfinedClaudeLaunch(input: {
  workspace: string;
  configDir: string;
  stationHome: string;
  home?: string;
  stationRoot?: string;
  mechanism?: ClaudeSpawnWrapMechanism;
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
  const bubblewrap = input.mechanism === 'bubblewrap';
  const { hidden, readable } = (
    bubblewrap ? bubblewrapHiddenPaths : seatbeltHiddenPaths
  )({
    home,
    stationHome: input.stationHome,
    ...(input.stationRoot ? { stationRoot: input.stationRoot } : {}),
  });
  const grants = (bubblewrap ? bubblewrapGrants : seatbeltGrants)({
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
  const built = bubblewrap
    ? bubblewrapLaunchWriteGrants(input.workspace, grants, bounds)
    : { writeGrants: seatbeltWriteGrantKinds(grants, bounds) };
  return {
    workspace: input.workspace,
    configDir,
    tmpDir,
    grants,
    bounds,
    writeGrants: built.writeGrants,
    ...(built.buildError ? { buildError: built.buildError } : {}),
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/** #4769: Claude Code's API when no base URL is configured. */
const CLAUDE_DEFAULT_MODEL_ENDPOINT: EgressTarget = {
  host: 'api.anthropic.com',
  port: 443,
};

/** Claude Code's switches to a cloud provider's model API. */
const CLAUDE_CLOUD_PROVIDER_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

function enabled(value: string | undefined): boolean {
  const text = value?.trim().toLowerCase();
  return Boolean(text) && text !== '0' && text !== 'false' && text !== 'no';
}

/**
 * #4769: the model endpoint a Claude engine spawned with `env` reaches,
 * derived from the resolved connection's environment, never typed by hand:
 * an `https:` `ANTHROPIC_BASE_URL` (a gateway or Station's model-proxy
 * route), else Anthropic's API. A cloud provider's API (Bedrock, Vertex,
 * Foundry) needs hosts this does not derive, and a plain-HTTP base URL is
 * not tunnelled by `CONNECT`, so each is refused with the reason.
 */
export function claudeModelEndpoint(
  env: Readonly<Record<string, string | undefined>>,
): { endpoint: EgressTarget } | { refusal: string } {
  const cloud = CLAUDE_CLOUD_PROVIDER_KEYS.find((key) => enabled(env[key]));
  if (cloud)
    return {
      refusal: `A restricted network cannot derive the model endpoint of a Claude connection that uses a cloud provider (${cloud}).`,
    };
  const base = env.ANTHROPIC_BASE_URL?.trim();
  if (!base) return { endpoint: { ...CLAUDE_DEFAULT_MODEL_ENDPOINT } };
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return {
      refusal:
        "A restricted network cannot read the Claude connection's ANTHROPIC_BASE_URL.",
    };
  }
  if (url.protocol !== 'https:')
    return {
      refusal:
        "A restricted network tunnels HTTPS only, and the Claude connection's ANTHROPIC_BASE_URL is not an https: URL.",
    };
  const host = normalizeEgressHost(url.hostname);
  if (!host)
    return {
      refusal:
        "A restricted network cannot read the host of the Claude connection's ANTHROPIC_BASE_URL.",
    };
  return { endpoint: { host, port: url.port ? Number(url.port) : 443 } };
}

/** The proxy variables a restricted engine is pointed at the broker with. */
const PROXY_KEYS = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'https_proxy',
  'http_proxy',
  'all_proxy',
] as const;

/**
 * #4769: `env` with every proxy variable pointed at the egress broker on
 * `port`, and any proxy exclusion removed: an excluded host would be dialled
 * directly, which the profile refuses. Claude Code's non-essential traffic
 * (telemetry, error reports, update checks) is turned off, since its hosts
 * are not allowed and would only add refusals.
 */
function restrictedNetworkEnv(
  env: Readonly<Record<string, string>>,
  port: number,
): Record<string, string> {
  const next: Record<string, string> = { ...env };
  delete next.NO_PROXY;
  delete next.no_proxy;
  for (const key of PROXY_KEYS) next[key] = `http://127.0.0.1:${port}`;
  next.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return next;
}

/**
 * The engine spawn sent through `provider.confine`: only allowed ambient
 * variables and the operator's `configuredKeys` pass (`confinedEnvAllows`);
 * the configuration and temp directories are the Station-owned ones; the
 * secure-store override is dropped wherever it came from (the adapter does
 * not strip it itself), so nothing points at the operator's Keychain
 * namespace. Whatever `confine` returns is what is spawned. `pending` is the
 * provider's own pending posture for that spawn.
 *
 * #4769: with `egress`, the network is restricted to that broker: the proxy
 * variables point at it (`restrictedNetworkEnv`), the broker admits the
 * model endpoint derived from the environment actually spawned
 * (`claudeModelEndpoint`, which throws when it cannot be derived), and the
 * provider is asked for `network: 'broker'`.
 */
export function confinedClaudeSpawn(
  provider: ConfinementProvider<SeatbeltEvidence>,
  launch: Pick<
    ConfinedClaudeLaunch,
    'workspace' | 'configDir' | 'tmpDir' | 'grants'
  >,
  configuredKeys: ReadonlySet<string> = new Set(),
  egress?: { broker: Pick<EgressBroker, 'port' | 'setModelEndpoint'> },
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
    let spawnEnv: Record<string, string> = env;
    if (egress) {
      const model = claudeModelEndpoint(env);
      if ('refusal' in model) throw new Error(model.refusal);
      egress.broker.setModelEndpoint(model.endpoint);
      spawnEnv = restrictedNetworkEnv(env, egress.broker.port);
    }
    const confined = provider.confine({
      command: spawn.command,
      args: spawn.args,
      cwd: launch.workspace,
      env: spawnEnv,
      grants: launch.grants,
      ...(egress
        ? { network: 'broker' as const, brokerPort: egress.broker.port }
        : { network: 'full' as const }),
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
