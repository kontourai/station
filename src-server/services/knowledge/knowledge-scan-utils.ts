import { existsSync, readdirSync, statSync } from 'node:fs';
import {
  extname,
  join,
  relative,
  resolve,
  resolve as resolvePath,
} from 'node:path';
import type {
  KnowledgeNamespaceConfig,
  KnowledgeSearchFilter,
} from '@kontourai/station-contracts/knowledge';
import { isRepoRelativePath } from '@kontourai/station-contracts/project-identity';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import { expandTilde } from '../../utils/paths.js';
import {
  type ProjectWorkspacePathOptions,
  resolveProjectWorkspaceOutcome,
} from '../projects/project-workspace-path.js';

const DEFAULT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.mdx',
  '.json',
  '.csv',
  '.html',
  '.htm',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.sql',
  '.sh',
  '.bash',
  '.css',
  '.scss',
  '.less',
  '.svelte',
  '.vue',
]);

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.cache',
  '__pycache__',
  'target',
  '.next',
]);

export function matchesKnowledgeFilter(
  document: {
    path?: string;
    filename: string;
    status?: string;
    createdAt: string;
    metadata?: Record<string, unknown>;
  },
  filter: KnowledgeSearchFilter,
): boolean {
  if (
    filter.pathPrefix &&
    !(document.path || document.filename).startsWith(filter.pathPrefix)
  ) {
    return false;
  }
  if (filter.status && document.status !== filter.status) return false;
  if (filter.after && document.createdAt < filter.after) return false;
  if (filter.before && document.createdAt > filter.before) return false;
  if (filter.tags?.length) {
    const documentTags: string[] = (document.metadata?.tags as string[]) ?? [];
    if (!filter.tags.every((tag) => documentTags.includes(tag))) return false;
  }
  if (!filter.metadata) return true;

  for (const [key, value] of Object.entries(filter.metadata)) {
    const documentValue = document.metadata?.[key];
    if (Array.isArray(value)) {
      if (!value.includes(String(documentValue))) return false;
      continue;
    }
    if (String(documentValue) !== value) return false;
  }

  return true;
}

/**
 * station#1501 slice 3b, seam S3 (`docs/design/portable-project-identity.md`
 * §2.2.1).
 *
 * The namespace's own `storageDir` still WINS over the project directory, and
 * still short-circuits before any project resolution happens: an explicitly
 * configured namespace store is a deliberate operator choice about where those
 * documents live, and it is not a project resource at all. Only the fallback —
 * "no `storageDir`, so scan the project's own tree" — moved onto the resolver.
 *
 * **Behavior delta for a project without a manifest — this migration fixes a
 * latent bug.** The previous last line was
 * `return project.workingDirectory ?? null` — the value UNEXPANDED, exactly as
 * the user typed it. A project stored as `~/dev/repo` therefore produced the
 * literal string `~/dev/repo`, `scanKnowledgeDirectories`' `existsSync` on it
 * failed, and the scan silently indexed nothing. Tilde-stored projects are the
 * norm for anything created through the UI, so **knowledge scanning has never
 * worked for them.** The resolver's compat branch returns
 * `resolve(expandTilde(...))`, so those projects now scan. A relative stored
 * value is likewise absolutized instead of being evaluated against the server
 * process's cwd.
 *
 * The second delta is the existence check: a project whose directory does not
 * exist now resolves `unbound` and returns `null` here, where it previously
 * returned the string and was rejected one call later by the caller's own
 * `existsSync`. Same observable outcome, one fewer place to get it wrong.
 *
 * `storageAdapter` is retained in the signature (and still gates the fallback)
 * so a caller with no storage wiring keeps getting `null` rather than a
 * resolver that would construct its own `FileStorageAdapter` over the ambient
 * home directory.
 *
 * **Disclosed bypass (slice 3b review, L3).** The source pinning below applies
 * to `options.resolverOptions`. A caller that passes a fully-built
 * `options.resolver` instead supplies its own project source, and this
 * function cannot override it — that is the point of accepting a pre-built
 * resolver at all (a route or poll loop holding one instance instead of
 * constructing stores per call). The bypass is left open deliberately: a
 * caller that constructs a resolver has already chosen its stores explicitly,
 * which is a different act from not thinking about it. What the pinning
 * prevents is the *silent* case — options carrying no source at all, where the
 * resolver would otherwise default to `new FileStorageAdapter(resolveHomeDir())`
 * and answer from `STATION_HOME` rather than from the adapter handed in here.
 */
export async function resolveKnowledgeScanPath(
  projectSlug: string,
  namespace: string,
  storageAdapter: IStorageAdapter | undefined,
  getNamespaceConfig: (
    projectSlug: string,
    namespace: string,
  ) => KnowledgeNamespaceConfig | undefined,
  options: ProjectWorkspacePathOptions = {},
): Promise<string | null> {
  const namespaceConfig = getNamespaceConfig(projectSlug, namespace);
  if (namespaceConfig?.storageDir) {
    // THE SAME expansion resolveKnowledgeStorageDir does. These two functions
    // are two halves of one feature — the scan reads from here and then
    // writes each file through resolveStorageDir — so expanding only the
    // write half would send writes to $HOME/notes/files while the scan kept
    // looking under <cwd>/~/notes/files, making a directory scan a silent
    // permanent no-op. Expanding one side of a pair is the same defect class
    // as not expanding at all (station#3155 review).
    const storageDir = resolve(expandTilde(namespaceConfig.storageDir));
    const filesDir = join(storageDir, 'files');
    return existsSync(filesDir) ? filesDir : storageDir;
  }

  if (!storageAdapter) return null;

  /*
   * station#1503 slice 5 — a namespace anchored to a NAMED repo resolves that
   * repo, not "the project's directory".
   *
   * Why this is the whole point of the slice for knowledge: with one repo per
   * project the two are the same place, so scanning the project directory is
   * accidentally right. With three, a namespace meaning "the docs in the API
   * repo" had no way to say so and the scan indexed whichever checkout the
   * project's working directory happened to hold — silently, and with the
   * indexed documents then answering questions about the wrong codebase.
   *
   * It asks the REPO-question (`resolveProjectWorkspaceOutcome`, `bound` only)
   * with the resource id, so:
   * - a repo bound elsewhere on this Station scans ITS checkout;
   * - a repo that is `unbound`/`missing`/`drifted`/`stale` scans NOTHING and
   *   returns `null`, rather than falling back to the project directory, which
   *   is where the wrong repo lives;
   * - an unknown `repoId` resolves `unbound` for that id (the resolver's
   *   decision 2: an unknown id is never quietly answered with the primary).
   *
   * The path is validated with the contract's own `isRepoRelativePath` — the
   * SAME rule the manifest validator applies — before it is joined onto a
   * resolved checkout. A second copy of a path-escape rule that guards a
   * `join()` is a directory traversal out of the repo the operator named, so
   * there is exactly one copy and this calls it.
   */
  const repoRoot = namespaceConfig?.repoRoot;
  if (repoRoot) {
    if (!isRepoRelativePath(repoRoot.path)) {
      // Fail closed and loudly, exactly as an unknown project does below: a
      // knowledge root Station refuses to join is not "indexed nothing", it is
      // a configuration error whose repair is the operator's.
      throw new Error(
        `Knowledge namespace "${namespace}" of project "${projectSlug}" anchors to repo "${repoRoot.repoId}" at "${repoRoot.path}", which is not a repo-relative path. Nothing was scanned.`,
      );
    }
    const repoOutcome = await resolveProjectWorkspaceOutcome(projectSlug, {
      ...options,
      resourceId: repoRoot.repoId,
      resolverOptions: {
        ...options.resolverOptions,
        source: options.resolverOptions?.source ?? storageAdapter,
      },
    });
    if (repoOutcome.available) {
      // `.`/`./` name the repo root itself; `join` already collapses them, and
      // `resolve` keeps the result absolute for the caller's `existsSync`.
      return resolvePath(join(repoOutcome.path, repoRoot.path));
    }
    if (repoOutcome.state === 'error') throw new Error(repoOutcome.reason);
    return null;
  }

  const outcome = await resolveProjectWorkspaceOutcome(projectSlug, {
    ...options,
    resolverOptions: {
      ...options.resolverOptions,
      // `storageAdapter` REMAINS the project source, exactly as it was when
      // this function read `storageAdapter.getProject(projectSlug)` directly.
      // Letting the resolver fall back to its own `FileStorageAdapter` over
      // the ambient Station home would silently answer from a different
      // project store than the caller handed us — the second-source-of-truth
      // defect this seam migration exists to remove, and it is reachable: the
      // parameter is an injection point.
      source: options.resolverOptions?.source ?? storageAdapter,
    },
  });
  if (outcome.available) return outcome.path;
  // The THROW IS PRESERVED. `storageAdapter.getProject(slug)` threw
  // `Project '<slug>' not found` for an unknown project and this function had
  // no catch, so the throw reached `scanKnowledgeDirectories`' caller.
  // Swallowing it now would turn "that project does not exist" into
  // "indexed: 0, skipped: 0" — a failure rendered as a successful empty scan,
  // which is precisely the honesty failure the delivery protocol §6 names. An
  // unreadable manifest joins it on the same fail-closed path (resolver
  // decision 7): there is nothing trustworthy to scan.
  if (outcome.state === 'error') throw new Error(outcome.reason);
  return null;
}

export function normalizeKnowledgeExtension(extension: string): string {
  return extension.startsWith('.') ? extension : `.${extension}`;
}

export function applyKnowledgeScanPatterns(
  files: string[],
  basePath: string,
  includePatterns?: string[],
  excludePatterns?: string[],
): string[] {
  if (!includePatterns?.length && !excludePatterns?.length) return files;

  return files.filter((filePath) => {
    const relativePath = relative(basePath, filePath);
    if (
      includePatterns?.length &&
      !includePatterns.some((pattern) => globMatch(relativePath, pattern))
    ) {
      return false;
    }
    if (
      excludePatterns?.length &&
      excludePatterns.some((pattern) => globMatch(relativePath, pattern))
    ) {
      return false;
    }
    return true;
  });
}

export function collectKnowledgeFiles(
  dirPath: string,
  allowedExtensions: Set<string>,
  maxFiles = 200,
): string[] {
  const results: string[] = [];
  const walk = (currentPath: string, depth: number) => {
    if (depth > 8 || results.length >= maxFiles) return;

    let entries: string[];
    try {
      entries = readdirSync(currentPath);
    } catch (error) {
      console.debug(
        'Failed to read directory during knowledge scan:',
        currentPath,
        error,
      );
      return;
    }

    for (const name of entries) {
      if (results.length >= maxFiles) break;
      const fullPath = join(currentPath, name);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          if (!SKIP_DIRS.has(name)) walk(fullPath, depth + 1);
          continue;
        }
        if (allowedExtensions.has(extname(name).toLowerCase())) {
          results.push(fullPath);
        }
      } catch (error) {
        console.debug('Failed to stat file during knowledge scan:', error);
      }
    }
  };

  walk(dirPath, 0);
  return results;
}

export { DEFAULT_EXTENSIONS };

/**
 * Longest scan pattern Station will evaluate. Real include/exclude globs are
 * tens of characters; this sits three orders of magnitude above them so no
 * genuine configuration reaches it.
 */
const MAX_GLOB_PATTERN_CHARACTERS = 1_024;

function globMatch(path: string, pattern: string): boolean {
  // Scan configuration is project-controlled. The former regex conversion
  // turned repeated `**` into adjacent `.*` groups, whose failing near-misses
  // have exponential backtracking. This NFA never backtracks and preserves
  // the advertised glob language: ?, !, **/ root matches, and Unicode
  // code-point paths.
  const patternCharacters = Array.from(pattern);

  // Removing the backtracking bounds the *shape* of the work, not its size:
  // the NFA still costs tokens x path length for every file scanned, so
  // `'**'.repeat(50_000)` buys ~100k live states per character. Station
  // refuses to evaluate a pattern this far outside the shape of real scan
  // configuration instead of spending that. The refusal is returned ahead of
  // the `!` negation deliberately — it is not a match decision, and an
  // unevaluated pattern must select nothing in either polarity rather than
  // selecting everything when negated.
  if (patternCharacters.length > MAX_GLOB_PATTERN_CHARACTERS) return false;

  const negated = patternCharacters[0] === '!';
  const source = negated ? patternCharacters.slice(1) : patternCharacters;
  const tokens: Array<'*' | '**' | '**/' | '?' | string> = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '*' && source[index + 1] === '*') {
      if (source[index + 2] === '/') {
        tokens.push('**/');
        index += 2;
      } else {
        tokens.push('**');
        index += 1;
      }
    } else {
      tokens.push(source[index]!);
    }
  }

  const addEmptyTransitions = (
    states: Uint8Array,
    directoryBoundary: boolean,
  ) => {
    for (let index = 0; index < tokens.length; index += 1) {
      if (
        states[index] &&
        (tokens[index] === '*' ||
          tokens[index] === '**' ||
          (tokens[index] === '**/' && directoryBoundary))
      ) {
        states[index + 1] = 1;
      }
    }
  };
  let states = new Uint8Array(tokens.length + 1);
  states[0] = 1;
  addEmptyTransitions(states, true);

  for (const character of path) {
    const next = new Uint8Array(tokens.length + 1);
    for (let index = 0; index < tokens.length; index += 1) {
      if (!states[index]) continue;
      const token = tokens[index];
      if (
        token === '**' ||
        // A globstar slash can consume any complete directory prefix, but it
        // may move to the following token only at a directory boundary.
        token === '**/' ||
        (token === '*' && character !== '/')
      ) {
        next[index] = 1;
      } else if (token === '?' && character !== '/') {
        next[index + 1] = 1;
      } else if (token === character) {
        next[index + 1] = 1;
      }
    }
    addEmptyTransitions(next, character === '/');
    states = next;
  }

  const matches = states[tokens.length] === 1;
  return negated ? !matches : matches;
}
