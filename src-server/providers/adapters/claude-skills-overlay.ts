/**
 * station#1174: the Station-owned per-session directory a cwd-less Claude
 * session's skills materialize into, when there is no real project/user
 * cwd to bind the session to (ProviderSessionStartInput.cwdDefaulted).
 *
 * Background (station#897 follow-through): a cwd-less station chat
 * <external-agent> defaults its session cwd to $HOME
 * (orchestration-service.ts's resolveStartSessionCwd), and
 * claude-skills-materialization.ts's section 6.1 hard guard (isGlobalConfigTarget)
 * correctly REFUSES to materialize into $HOME/.claude/skills -- that IS the
 * user's real global Claude Code config. The guard must stay intact; this
 * module gives cwd-less sessions somewhere else to land skills instead.
 *
 * The mechanism (confirmed empirically against the installed
 * @anthropic-ai/claude-agent-sdk, not just inferred from its types): the
 * SDK's Options.additionalDirectories registers a directory as a full
 * working-directory root for skill/CLAUDE.md discovery -- NOT merely a
 * tool-access allowlist entry -- so a skill materialized under
 * <overlayDir>/.claude/skills/<id>/ is discovered and delivered exactly
 * like one materialized under the real session cwd, with the real session
 * cwd (and the spawned engine's actual working directory) left completely
 * unchanged. This is the SDK-supports-a-custom-skills-root branch of the
 * station#1174 design choice -- no session-cwd override, no weakening of
 * isGlobalConfigTarget.
 *
 * Every directory this module ever creates or removes is deterministically
 * derived from a filesystem-safe session id under Station's own home
 * (<STATION_HOME>/claude-skill-overlays/<sessionId>/) -- never under
 * ~/.claude or any caller-supplied path -- so it can never collide with,
 * or need to defend against, user content the way
 * claude-skills-materialization.ts's containment machinery must for a
 * real workspace cwd.
 */
import {
  readdir as nodeReaddir,
  rm as nodeRm,
  stat as nodeStat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { isSafeToolServerId } from '@kontourai/station-contracts/tool';
import { resolveHomeDir } from '../../utils/paths.js';

const SKILL_OVERLAYS_DIRNAME = 'claude-skill-overlays';

/** Matches the any-typed logger convention used across providers/adapters. */
type OverlayLogger = any;

/** Injectable for tests -- defaults to real node:fs/promises. */
export interface SkillOverlayFsPort {
  readdir: (path: string) => Promise<string[]>;
  /** null on ENOENT or any other stat failure -- never throws. */
  mtimeMs: (path: string) => Promise<number | null>;
  rmRecursive: (path: string) => Promise<void>;
}

function defaultFsPort(): SkillOverlayFsPort {
  return {
    readdir: (path) => nodeReaddir(path),
    mtimeMs: async (path) => {
      try {
        return (await nodeStat(path)).mtimeMs;
      } catch {
        return null;
      }
    },
    rmRecursive: async (path) => {
      await nodeRm(path, { recursive: true, force: true });
    },
  };
}

/** STATION_HOME/claude-skill-overlays -- every cwd-less session's overlay lives under here. */
export function skillOverlaysRootDir(
  homeDir: string = resolveHomeDir(),
): string {
  return join(homeDir, SKILL_OVERLAYS_DIRNAME);
}

/**
 * The Station-owned overlay directory for one session. Throws for an unsafe
 * sessionId (empty, '.', '..', or a path separator) -- same predicate as
 * claude-skills-materialization.ts's skill ids and
 * app-home-profiles.ts's engine ids -- since it joins directly into a
 * filesystem path.
 */
export function skillOverlayDirFor(
  sessionId: string,
  homeDir: string = resolveHomeDir(),
): string {
  if (!isSafeToolServerId(sessionId)) {
    throw new Error(
      `Claude skills overlay: session id '${sessionId}' is not filesystem-safe (empty, '.', '..', or a path separator).`,
    );
  }
  return join(skillOverlaysRootDir(homeDir), sessionId);
}

/**
 * Best-effort, unconditional recursive removal of one session's overlay
 * directory. Safe to call unconditionally (a missing directory is a
 * no-op): unlike cleanupMaterializedSkills's hash-verified, TOCTOU-safe
 * per-file deletes (which defend a real workspace cwd that might also hold
 * the user's OWN files), every byte under a session's overlay directory was
 * written by THIS module's caller (materializeSkills) and nothing else --
 * there is no foreign content to protect here.
 */
export async function removeSkillOverlayDir(
  sessionId: string,
  options: {
    homeDir?: string;
    logger?: OverlayLogger;
    fs?: SkillOverlayFsPort;
  } = {},
): Promise<void> {
  const { homeDir, logger = console, fs = defaultFsPort() } = options;
  let dir: string;
  try {
    dir = skillOverlayDirFor(sessionId, homeDir);
  } catch (error) {
    logger.warn?.(
      `Claude skills overlay cleanup: refusing to remove anything (${error instanceof Error ? error.message : String(error)}).`,
    );
    return;
  }
  try {
    await fs.rmRecursive(dir);
  } catch (error) {
    logger.warn?.(
      `Claude skills overlay cleanup: failed to remove '${dir}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface SweepStaleSkillOverlaysInput {
  /** true for a session id that must never be swept -- the caller's live session set. */
  isLiveSessionId: (sessionId: string) => boolean;
  /**
   * Only sweep an overlay directory whose own mtime is at least this old.
   * Defaults to 24 hours -- an overlay directory is only ever swept here as
   * crash-safety (the normal path is stopSession's own best-effort
   * removal), so this grace window is generous rather than racing a
   * still-starting session the way the shorter, contention-driven
   * sweepStaleManifests grace window does for a SHARED workspace cwd
   * (an overlay directory is never shared between sessions, so there is no
   * equivalent race to guard against -- only whether this session is still live).
   */
  staleAfterMs?: number;
  homeDir?: string;
  logger?: OverlayLogger;
  fs?: SkillOverlayFsPort;
  now?: () => number;
}

export interface SweepStaleSkillOverlaysResult {
  swept: string[];
  skippedLive: string[];
  skippedRecent: string[];
}

/**
 * Crash-safety sweep, best-effort at the start of a new cwd-less session:
 * removes every OTHER session's overlay directory that is both not live
 * (per isLiveSessionId) and older than staleAfterMs. Mirrors
 * claude-skills-materialization.ts's sweepStaleManifests in shape, but
 * over sibling directories under the overlay root rather than sibling
 * manifest files inside one shared .claude/skills/ -- each session gets
 * its OWN overlay directory, so there is no shared-directory race to guard
 * against beyond whether this session is still live.
 */
export async function sweepStaleSkillOverlays(
  input: SweepStaleSkillOverlaysInput,
): Promise<SweepStaleSkillOverlaysResult> {
  const {
    isLiveSessionId,
    staleAfterMs = 24 * 60 * 60 * 1000,
    homeDir,
    logger = console,
    fs = defaultFsPort(),
    now = () => Date.now(),
  } = input;

  const swept: string[] = [];
  const skippedLive: string[] = [];
  const skippedRecent: string[] = [];

  const root = skillOverlaysRootDir(homeDir);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return { swept, skippedLive, skippedRecent };
  }

  for (const entry of entries) {
    if (!isSafeToolServerId(entry)) continue;
    if (isLiveSessionId(entry)) {
      skippedLive.push(entry);
      continue;
    }
    const dir = join(root, entry);
    const mtimeMs = await fs.mtimeMs(dir);
    if (mtimeMs !== null && now() - mtimeMs < staleAfterMs) {
      skippedRecent.push(entry);
      continue;
    }
    try {
      await fs.rmRecursive(dir);
      swept.push(entry);
    } catch (error) {
      logger.warn?.(
        `Claude skills overlay sweep: failed to remove '${dir}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { swept, skippedLive, skippedRecent };
}
