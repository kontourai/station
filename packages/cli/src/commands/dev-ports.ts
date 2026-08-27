/**
 * Deterministic, per-worktree port + home derivation for `station dev`.
 *
 * A bleeding-edge dev instance must coexist with the stable dogfood (reserved
 * on 3141/3000) and never move its ports between restarts — otherwise a URL
 * shared to a phone or a teammate breaks the moment the process is bounced.
 * This is a straight lift of t3code's dev-runner port model
 * (`scripts/dev-runner.ts` `resolveOffset` + the port-scan, and
 * `packages/shared/src/devHome.ts` worktree detection), ported to plain
 * TypeScript with a small FNV-1a hash instead of Effect's.
 *
 * Every function here is pure / side-effect-light and dependency-injected so
 * it can be unit-tested without touching a real filesystem or a real socket.
 * The `station dev` command wiring (real fs, real port probing, spawning
 * `start`) lives in `./dev-command.ts`.
 */

import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { stationChannelPorts } from '@kontourai/station-shared/ports';
import { resolveStationRoot } from '@kontourai/station-shared/runtime-path-resolver';

/**
 * Base ports for the dev instance's server and UI, and the maximum offset the
 * derivation may produce.
 *
 * These are DELIBERATELY UNCOMMON. The owner explicitly wants to avoid the
 * common 3000/3141 band (and every other well-trodden dev port), so a phone or
 * a LAN client can hold a single stable dev URL without ever fighting the
 * reserved dogfood or some other tool that grabbed 3000/8080/5173/etc.
 *
 *   server: 39140 + [1..500] => 39141-39640
 *   ui:     40140 + [1..500] => 40141-40640
 *
 * Why this band:
 *  - Well clear of the common dev ports and of the reserved 3141/3000 dogfood.
 *  - Below the OS ephemeral range (49152+ on the relevant platforms), so the
 *    kernel never hands one of these out from under us for an outbound socket.
 *  - The 1000-wide gap between the two bases is larger than MAX_OFFSET plus
 *    the instance block width (terminal +1, voice +2, consent +3 —
 *    station#3677), which GUARANTEES no port in one worktree's server block
 *    can ever equal a ui port for another (39640 + 3 = 39643 < 40141). No
 *    cross-role collision is possible.
 *
 * They are named constants on purpose: change the two bases together (keeping
 * their gap > MAX_OFFSET) to move the whole band.
 */
export const STATION_DEV_SERVER_PORT_BASE =
  stationChannelPorts('development').serverPort;
export const STATION_DEV_UI_PORT_BASE =
  stationChannelPorts('development').uiPort;
export const STATION_DEV_MAX_OFFSET = 500;

/**
 * Ports HTTP(S) requests are blocked from reaching by the Fetch standard
 * before a browser ever hits the network (https://fetch.spec.whatwg.org/#port-blocking).
 * Our deliberate band (39141-40640) sits far above every entry here (the
 * largest is 10080), so in practice this guard never fires — it is kept only
 * so that changing the base constants can never silently produce a URL curl
 * accepts but a browser refuses.
 */
const FETCH_BAD_PORTS = new Set<number>([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

/**
 * FNV-1a 32-bit. A small, stable, dependency-free string hash — it need not
 * match t3code's hash, only be deterministic across runs and machines. Uses
 * `Math.imul` for the 32-bit multiply and `>>> 0` to stay unsigned.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export interface ResolveDevOffsetInput {
  /** Explicit numeric offset (from --port-offset or STATION_PORT_OFFSET). */
  readonly portOffset?: number | undefined;
  /** STATION_DEV_INSTANCE seed: numeric = exact offset, else hashed. */
  readonly devInstance?: string | undefined;
  /** The linked-worktree path, hashed when no explicit source is given. */
  readonly worktreePath?: string | undefined;
}

export interface ResolvedDevOffset {
  readonly offset: number;
  /** Human-readable explanation of where the offset came from. */
  readonly source: string;
}

function assertOffsetInRange(offset: number, label: string): void {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(
      `${label} must be a non-negative integer; received ${offset}.`,
    );
  }
  if (offset > STATION_DEV_MAX_OFFSET) {
    throw new Error(
      `${label} must be at most ${STATION_DEV_MAX_OFFSET} to stay within the reserved dev port band; received ${offset}.`,
    );
  }
}

/**
 * Precedence (high to low), lifted from t3code's `resolveOffset`:
 *   1. explicit numeric port offset  (--port-offset / STATION_PORT_OFFSET)
 *   2. STATION_DEV_INSTANCE seed      (numeric = that exact offset;
 *                                      non-numeric = hashed into 1..MAX_OFFSET)
 *   3. worktree path                  (hashed into 1..MAX_OFFSET)
 *   4. 0                              (base ports)
 *
 * Hashed offsets are `(hash % MAX_OFFSET) + 1`, so they land in 1..MAX_OFFSET
 * and never collide with the explicit-0 "base ports" case.
 */
export function resolveDevOffset(
  config: ResolveDevOffsetInput,
): ResolvedDevOffset {
  if (config.portOffset !== undefined) {
    assertOffsetInRange(config.portOffset, 'Port offset');
    return {
      offset: config.portOffset,
      source: `port offset ${config.portOffset}`,
    };
  }

  const seed = config.devInstance?.trim();
  if (seed) {
    if (/^\d+$/.test(seed)) {
      const offset = Number(seed);
      assertOffsetInRange(offset, `STATION_DEV_INSTANCE=${seed}`);
      return { offset, source: `numeric STATION_DEV_INSTANCE=${seed}` };
    }
    const offset = (fnv1a32(seed) % STATION_DEV_MAX_OFFSET) + 1;
    return { offset, source: `hashed STATION_DEV_INSTANCE=${seed}` };
  }

  const worktreePath = config.worktreePath?.trim();
  if (worktreePath) {
    const offset = (fnv1a32(worktreePath) % STATION_DEV_MAX_OFFSET) + 1;
    return { offset, source: `worktree ${worktreePath}` };
  }

  return { offset: 0, source: 'default (base ports)' };
}

/**
 * A minimal filesystem view for worktree detection, injectable for testing.
 * `statType` returns the kind of the path or `undefined` when it is missing;
 * `readText` reads the `.git` file's contents.
 */
export interface WorktreeFs {
  statType(path: string): 'file' | 'dir' | undefined;
  readText(path: string): string;
}

const nodeWorktreeFs: WorktreeFs = {
  statType(path) {
    try {
      return statSync(path).isDirectory() ? 'dir' : 'file';
    } catch {
      return undefined;
    }
  },
  readText(path) {
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      return '';
    }
  },
};

/**
 * A `.git` FILE points at the real git directory. A linked worktree's lives at
 * `<common-dir>/worktrees/<name>`; a submodule's at
 * `<super-git-dir>/modules/<name>`. Both are files, so the `gitdir:` pointer —
 * not the file-vs-directory distinction alone — is what identifies a worktree.
 *
 * The common dir is not necessarily named `.git`, so match the
 * `worktrees/<name>` tail (which git always uses) as path segments rather than
 * a substring, so a directory merely named `…worktrees…` cannot match.
 */
function pointsAtLinkedWorktree(gitFileContents: string): boolean {
  const gitdir = gitFileContents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('gitdir:'))
    ?.slice('gitdir:'.length)
    .trim();
  if (gitdir === undefined || gitdir.length === 0) {
    return false;
  }
  const segments = normalize(gitdir.replaceAll('\\', '/'))
    .split(/[/\\]/)
    .filter((segment) => segment.length > 0);
  // `<common-dir>/worktrees/<name>`: `worktrees` is the penultimate segment and
  // something must precede it. This excludes `<git-dir>/modules/<name>`.
  return segments.length >= 3 && segments.at(-2) === 'worktrees';
}

/**
 * The path of the linked git worktree containing `cwd`, or `undefined` when
 * `cwd` is not inside one (a main checkout, a submodule, or no repo at all).
 * Walks up to the repository root, so running from a subdirectory resolves the
 * same worktree as running from the top.
 */
export function resolveWorktreePath(
  cwd: string,
  fs: WorktreeFs = nodeWorktreeFs,
): string | undefined {
  let directory = resolve(cwd);
  for (;;) {
    const gitPath = join(directory, '.git');
    const kind = fs.statType(gitPath);
    if (kind !== undefined) {
      // A directory is the main checkout. Stop either way: nesting one repo
      // inside another does not make the outer one this root.
      if (kind !== 'file') return undefined;
      return pointsAtLinkedWorktree(fs.readText(gitPath))
        ? directory
        : undefined;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * Sanitize one string into an instance-name-safe token: lowercase, only
 * `[a-z0-9._-]`, no leading/trailing dashes, and capped at 64 chars so an
 * oversized seed or basename can never blow the path-length limit on mkdir
 * (ENAMETOOLONG). Anything that reduces to empty becomes `instance`.
 *
 * Note this is also the path-traversal guard: every `/` and `\` collapses to
 * `-`, so the result is always a single path segment — `join(root, ...)` can
 * never escape the home root even for hostile input like `../../etc`.
 */
function sanitizeSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return normalized || 'instance';
}

export interface DeriveDevInstanceInput {
  readonly worktreePath?: string | undefined;
  readonly devInstance?: string | undefined;
  readonly cwd: string;
  /** Root under which per-instance homes live; defaults to ~/.station-dev. */
  readonly homeRoot?: string | undefined;
  /** Root of the shared Station ownership tree. */
  readonly stationRoot?: string | undefined;
}

export interface DerivedDevInstance {
  /** Stable, sanitized instance name, e.g. `dev-my-worktree`. */
  readonly instance: string;
  /** Isolated home directory, EXTERNAL to the worktree. */
  readonly home: string;
}

/**
 * Derive the instance name and isolated home for a dev instance. The home is
 * `~/.station-dev/<instance>` — deliberately EXTERNAL to the worktree so it
 * survives a worktree cleanup and a recreated worktree at the same path reuses
 * the same home.
 *
 * Two cases, because the ports are keyed off the FULL resolved path (not the
 * basename), and the home MUST be keyed the same way or it can collide:
 *
 *  - Explicit STATION_DEV_INSTANCE seed → `dev-<sanitized-seed>`, NO path hash.
 *    A shared name is then the user's intentional choice (matches t3code): two
 *    worktrees given the same seed deliberately share a home.
 *
 *  - Auto (worktree/cwd) → `dev-<sanitized-basename>-<hash8(fullResolvedPath)>`.
 *    Without the path hash, two UNRELATED worktrees sharing a basename
 *    (…/worktrees/fix-bug in two different repos or two users' checkouts) would
 *    get DIFFERENT ports but the SAME home, and `station dev --clean` in one
 *    would wipe the other's isolated data. The hash makes a recreated worktree
 *    at the SAME path reuse the same home (deterministic) and a different path
 *    never collide.
 */
export function deriveDevInstanceAndHome(
  input: DeriveDevInstanceInput,
): DerivedDevInstance {
  const root =
    input.homeRoot ??
    join(input.stationRoot ?? resolveStationRoot(), 'instances', 'dev');
  const seed = input.devInstance?.trim();

  let instance: string;
  if (seed && seed.length > 0) {
    instance = `dev-${sanitizeSegment(seed)}`;
  } else {
    const fullPath = resolve(input.worktreePath ?? input.cwd);
    const hash = fnv1a32(fullPath).toString(16).padStart(8, '0');
    instance = `dev-${sanitizeSegment(basename(fullPath))}-${hash}`;
  }

  return { instance, home: join(root, instance) };
}

export interface AllocatedDevPorts {
  /** The offset the free pair was found at (may differ from the input). */
  readonly offset: number;
  readonly serverPort: number;
  readonly uiPort: number;
  /** True when a collision forced a scan away from the derived offset. */
  readonly moved: boolean;
}

/**
 * Predicate deciding whether a single port is free. Async so the real probe
 * (bind on 127.0.0.1 and ::1) fits; a synchronous predicate (tests) works too
 * because `await` on a boolean is a boolean.
 */
export type IsPortFree = (port: number) => boolean | Promise<boolean>;

/**
 * All five listeners `start()` binds for one offset: the API server, the
 * terminal server (`serverPort + 1`), the voice server (`serverPort + 2`),
 * the consent listener (`serverPort + 3`, station#3677), and the UI
 * (`uiPort`). See `lifecycle.ts`'s `start`. The allocator must find them
 * ALL free, because `assertNoPortConflicts` is cwd-scoped and cannot see other
 * worktrees — this probe is the only cross-worktree guard. Two worktrees whose
 * offsets land 1-3 apart share a terminal/voice/consent port (terminal of
 * offset N is the API port of offset N+1), so probing only server+ui would
 * let them collide with a raw EADDRINUSE mid-start.
 */
function offsetPortsToProbe(serverPort: number, uiPort: number): number[] {
  return [serverPort, serverPort + 1, serverPort + 2, serverPort + 3, uiPort];
}

/**
 * Starting at `startOffset`, find the first offset whose FIVE listeners are
 * all free, scanning FORWARD to absorb the rare hash collision between two
 * worktrees (t3code does the same). Bounded by MAX_OFFSET: because the band is
 * only MAX_OFFSET+1 wide, the scan wraps modulo (MAX_OFFSET+1) so it can cover
 * the whole band from any starting point before giving up.
 */
export async function allocateDevPorts(
  startOffset: number,
  isPortFree: IsPortFree,
): Promise<AllocatedDevPorts> {
  const span = STATION_DEV_MAX_OFFSET + 1;
  for (let attempt = 0; attempt < span; attempt += 1) {
    const offset = (startOffset + attempt) % span;
    const serverPort = STATION_DEV_SERVER_PORT_BASE + offset;
    const uiPort = STATION_DEV_UI_PORT_BASE + offset;
    const ports = offsetPortsToProbe(serverPort, uiPort);
    if (ports.some((port) => FETCH_BAD_PORTS.has(port))) {
      continue;
    }
    let allFree = true;
    for (const port of ports) {
      if (!(await isPortFree(port))) {
        allFree = false;
        break;
      }
    }
    if (allFree) {
      return { offset, serverPort, uiPort, moved: offset !== startOffset };
    }
  }
  throw new Error(
    `No free Station dev port pair found scanning all ${span} offsets from ${startOffset} (server base ${STATION_DEV_SERVER_PORT_BASE}, ui base ${STATION_DEV_UI_PORT_BASE}).`,
  );
}
