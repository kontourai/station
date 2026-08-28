import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { resolveGitInfo } from '@kontourai/station-shared/git';
import { execGit } from '../../utils/git-exec.js';

export const NIGHTLY_SOURCE_STAMP_FILENAME = 'station-nightly-source.json';

/**
 * Fallback for stamps written before the stamp carried its own `repository`
 * field. New stamps name their origin explicitly so a fork or mirror install
 * checks against the remote it was actually built from.
 */
export const DEFAULT_REPOSITORY = 'https://github.com/kontourai/station.git';

const FULL_GIT_SHA = /^[0-9a-f]{40}$/i;

/**
 * Both values reach `git ls-remote` argv. `https://` only — no ssh (would
 * hang on host-key/auth prompts), and structurally no `ext::`/`--upload-pack`
 * style values, which git would otherwise treat as local command execution.
 */
const SAFE_REPOSITORY = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.:-]*\/\S+$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

/**
 * The stamp lives at the bundle's resource root (`Contents/Resources/`) while
 * the server runs from `Resources/dist-server/`; the tight bound keeps a
 * checkout's `dist-server` from ever reaching a stray stamp in some distant
 * ancestor directory.
 */
const STAMP_WALK_LIMIT = 3;

export type InstallKind = 'source-checkout' | 'desktop-bundle' | 'unknown';

/**
 * Where the server module legitimately lives inside a real source checkout:
 * `<gitRoot>/dist-server*` (built bundles, incl. per-instance variants like
 * `dist-server-phone`) or under `<gitRoot>/src-server` (tsx dev). Anything
 * else inside a git tree — most importantly a packaged .app under
 * `src-desktop/target/…` — is NOT that checkout's server, and treating it as
 * one would arm the git-pull apply path against an unrelated repo.
 */
const SOURCE_SERVER_ROOT = /^(dist-server[^/\\]*|src-server)$/;

/**
 * True only when `moduleDir` sits at a recognized server location of
 * `gitRoot`'s own build/dev layout. `relative()` starting with `..` also
 * rejects the resolveGitInfo cwd/argv fallbacks resolving some OTHER repo
 * than the one containing the module.
 */
export function isServerOfCheckout(
  gitRoot: string,
  moduleDir: string,
): boolean {
  const rel = relative(gitRoot, moduleDir);
  if (rel === '') return true;
  const first = rel.split(sep)[0] ?? '';
  return first !== '..' && SOURCE_SERVER_ROOT.test(first);
}

export interface NightlySourceStamp {
  channel: string;
  ref: string;
  sha: string;
  repository: string;
  createdAt: string | null;
  /**
   * Absolute path of the checkout this install was built from, when the
   * installer wrote one. Never trusted alone: self-update eligibility
   * re-verifies the path exists AND its git origin matches `repository` at
   * request time (archive#1624).
   */
  sourceCheckout: string | null;
}

export type InstallProvenance =
  | {
      installKind: 'source-checkout';
      gitRoot: string;
      branch: string;
      sha: string;
    }
  | ({ installKind: 'desktop-bundle'; stampPath: string } & NightlySourceStamp)
  | { installKind: 'unknown'; detail: string };

/**
 * Fail-closed stamp reader: anything that does not match the shape the nightly
 * installer writes is treated as absent rather than trusted — a malformed
 * stamp must never fabricate a channel or sha.
 */
export function readNightlySourceStamp(
  path: string,
): NightlySourceStamp | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const stamp = parsed as Record<string, unknown>;
  if (stamp.schemaVersion !== 1) return null;
  if (typeof stamp.channel !== 'string' || stamp.channel.trim().length === 0) {
    return null;
  }
  if (typeof stamp.sha !== 'string' || !FULL_GIT_SHA.test(stamp.sha)) {
    return null;
  }
  // `ref` and `repository` reach `git ls-remote` argv, so they get the same
  // fail-closed treatment as `sha`: a value git could parse as an option or
  // a command-running transport invalidates the whole stamp.
  if (typeof stamp.ref !== 'string' || !SAFE_REF.test(stamp.ref.trim())) {
    return null;
  }
  if (
    stamp.repository !== undefined &&
    (typeof stamp.repository !== 'string' ||
      !SAFE_REPOSITORY.test(stamp.repository.trim()))
  ) {
    return null;
  }
  // Optional; must be an absolute path when present. Deliberately NOT proof
  // of anything — eligibility is re-derived from the live filesystem + git
  // origin identity at request time.
  if (
    stamp.sourceCheckout !== undefined &&
    (typeof stamp.sourceCheckout !== 'string' ||
      !stamp.sourceCheckout.startsWith('/'))
  ) {
    return null;
  }
  return {
    channel: stamp.channel.trim(),
    ref: stamp.ref.trim(),
    sha: stamp.sha.toLowerCase(),
    repository:
      typeof stamp.repository === 'string'
        ? stamp.repository.trim()
        : DEFAULT_REPOSITORY,
    createdAt: typeof stamp.createdAt === 'string' ? stamp.createdAt : null,
    sourceCheckout:
      typeof stamp.sourceCheckout === 'string' ? stamp.sourceCheckout : null,
  };
}

/**
 * Classify what kind of install this server is running from: a git source
 * checkout, a stamped desktop bundle, or an install with no provenance at all.
 * The old behavior — `resolveGitInfo` throwing "Not a git repository" straight
 * into the update UI — is what this replaces (archive#1624).
 */
export function resolveInstallProvenance(
  moduleDir: string,
  { resolveGit = resolveGitInfo }: { resolveGit?: typeof resolveGitInfo } = {},
): InstallProvenance {
  // The build stamp wins over git resolution: a bundle built INSIDE a git
  // checkout (src-desktop/target/…/Station Nightly.app) still resolves a git
  // toplevel — the surrounding repo, not the bundle — and classifying it
  // source-checkout would let the apply path run `git pull` + rebuild against
  // that unrelated checkout. The stamp is the deliberate, install-specific
  // marker, so it takes precedence when both are present.
  let dir = moduleDir;
  for (let depth = 0; depth < STAMP_WALK_LIMIT; depth += 1) {
    const stampPath = join(dir, NIGHTLY_SOURCE_STAMP_FILENAME);
    if (existsSync(stampPath)) {
      const stamp = readNightlySourceStamp(stampPath);
      if (stamp) {
        return { installKind: 'desktop-bundle', stampPath, ...stamp };
      }
      return {
        installKind: 'unknown',
        detail: `a build stamp exists at ${stampPath} but is malformed`,
      };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  try {
    const git = resolveGit(moduleDir);
    // An ancestor `.git` is not enough: a stampless bundle built inside a
    // checkout (src-desktop/target/…/Resources/dist-server) resolves the
    // SURROUNDING repo, and resolveGitInfo's cwd/argv fallbacks can resolve
    // a repo entirely unrelated to the module. Only a module sitting at the
    // checkout's own server layout counts as that checkout's server.
    if (isServerOfCheckout(git.gitRoot, moduleDir)) {
      return {
        installKind: 'source-checkout',
        gitRoot: git.gitRoot,
        branch: git.branch,
        sha: git.hash,
      };
    }
    return {
      installKind: 'unknown',
      detail: `the server at ${moduleDir} is inside git checkout ${git.gitRoot} but not at that checkout's server layout, and no ${NIGHTLY_SOURCE_STAMP_FILENAME} build stamp is present`,
    };
  } catch {
    // Not a checkout either.
  }

  return {
    installKind: 'unknown',
    detail: `no git checkout and no ${NIGHTLY_SOURCE_STAMP_FILENAME} build stamp near ${moduleDir}`,
  };
}

/**
 * Map a stamp ref (`origin/main`) to the refspec `git ls-remote` matches
 * (`refs/heads/main`). Already-qualified refs pass through.
 */
export function refspecFromStampRef(ref: string): string {
  const name = ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref;
  return name.startsWith('refs/') ? name : `refs/heads/${name}`;
}

/**
 * Head sha of the stamp's ref on its origin repository. Throws on any failure
 * (no git binary, no network, unknown ref) — callers report that as a
 * disclosed "couldn't reach the remote" state, never as update-available.
 */
export async function fetchChannelLatestSha(
  repository: string,
  ref: string,
  { exec = execGit }: { exec?: typeof execGit } = {},
): Promise<string> {
  // Defense in depth behind the stamp reader's validation: these two values
  // become git argv, so re-check them at the boundary that actually spawns.
  if (!SAFE_REPOSITORY.test(repository)) {
    throw new Error(`refusing non-https repository url for ls-remote`);
  }
  if (!SAFE_REF.test(ref)) {
    throw new Error(`refusing unsafe ref for ls-remote`);
  }
  const refspec = refspecFromStampRef(ref);
  const { stdout } = await exec(['ls-remote', repository, refspec], {
    timeout: 15_000,
    encoding: 'utf-8',
  });
  const sha = String(stdout).trim().split(/\s+/)[0] ?? '';
  if (!FULL_GIT_SHA.test(sha)) {
    throw new Error(
      `ls-remote returned no sha for ${refspec} on ${repository}`,
    );
  }
  return sha.toLowerCase();
}

/**
 * Normalize a git origin URL the same way the nightly installer does when it
 * writes the stamp's `repository`: SSH forms become anonymous https, and a
 * trailing `.git` is insignificant for identity comparison.
 */
export function normalizeOriginUrl(originUrl: string): string {
  return originUrl
    .trim()
    .replace(/^ssh:\/\/git@([^/:]+)(?::\d+)?\//, 'https://$1/')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '');
}

export type SelfUpdateEligibility =
  | { eligible: true; checkoutPath: string; installerPath: string }
  | { eligible: false; reason: string };

/**
 * Whether this desktop bundle may self-update by running its source
 * checkout's own installer (archive#1624 git-based updates). The stamp's
 * `sourceCheckout` is a hint, never an authorization: the path must exist
 * NOW, be a git checkout whose origin normalizes to the stamp's repository,
 * and contain the installer script.
 *
 * Threat model, stated precisely: these checks defend against a STALE or
 * MOVED checkout (deleted, relocated, or repointed at a different repo) so
 * the updater never runs the wrong project's installer. They do NOT defend
 * against same-user tampering — an actor who can rewrite the stamp or plant
 * a matching-origin fake checkout can already execute arbitrary code as
 * this user, so no in-process check could add protection there. The request
 * itself is behind the runtime auth boundary.
 */
export async function resolveSelfUpdateEligibility(
  stamp: Pick<NightlySourceStamp, 'repository' | 'sourceCheckout'>,
  {
    exec = execGit,
    platform = process.platform,
  }: { exec?: typeof execGit; platform?: NodeJS.Platform } = {},
): Promise<SelfUpdateEligibility> {
  if (platform !== 'darwin') {
    return { eligible: false, reason: 'self-update installer is macOS-only' };
  }
  if (!stamp.sourceCheckout) {
    return { eligible: false, reason: 'no source checkout recorded' };
  }
  const checkoutPath = stamp.sourceCheckout;
  const installerPath = join(
    checkoutPath,
    'ops',
    'nightly',
    'install-macos.zsh',
  );
  if (!existsSync(checkoutPath) || !existsSync(installerPath)) {
    return {
      eligible: false,
      reason: 'recorded source checkout or its installer is absent',
    };
  }
  let origin: string;
  try {
    const { stdout } = await exec(['remote', 'get-url', 'origin'], {
      cwd: checkoutPath,
      timeout: 10_000,
      encoding: 'utf-8',
    });
    origin = String(stdout).trim();
  } catch {
    return {
      eligible: false,
      reason: 'recorded source checkout is not a git checkout',
    };
  }
  if (normalizeOriginUrl(origin) !== normalizeOriginUrl(stamp.repository)) {
    return {
      eligible: false,
      reason: 'source checkout origin does not match this install',
    };
  }
  return { eligible: true, checkoutPath, installerPath };
}
