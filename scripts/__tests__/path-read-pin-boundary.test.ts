/**
 * The path-read pin boundary (#1807).
 *
 * A test that reads a source file's TEXT
 * (`readFileSync(join(__dirname, ...))`) has no import edge to that file, so
 * `vitest related` cannot see it and the changed-verification selector fell
 * through to a boundary that never named the pin. #1785 moved
 * `useOutboundQueueSnapshot(...)` out of `ChatDock.tsx`; the pin went red on
 * `main` and nobody's pull request selected it.
 *
 * Two properties are proved here.
 *
 * 1. EXISTENCE. Every pin the scanner finds names a file that is on disk.
 *    A rename or delete of a pinned file reds this test, naming the pinning
 *    test and the path it can no longer read — instead of surfacing as a
 *    broad selection on somebody else's pull request days later.
 * 2. ADDITIONS ONLY, IN THE SELECTOR'S RETURN VALUE. For every pinned path
 *    the lanes, related paths, and escalation flag are byte-identical and
 *    only the test list grows. This matters because of the #1563/#1613 hazard
 *    in `selectChangedVerification` — an ordinary edge that names `tests`
 *    sets `hasExplicitBoundary`, which SUPPRESSES the generic `related` edge
 *    for the same path and cancels the `ci-fast` escalation an escalation
 *    path is entitled to. A pin edge built that way would trade the whole
 *    related suite for one pinning test: a narrowing dressed as a fix.
 *    `supplemental` is what prevents it.
 *
 *    A larger selection is not automatically a larger RUN, and this file says
 *    so where it can: a scheduled test that Vitest refuses, or that fails the
 *    resource-classification preflight, converts the addition into a receipt
 *    naming a target that never ran, or into a red gate. Both are asserted
 *    below against `packages/cli/src/cli.ts`, the path where it happened.
 *
 * WHAT THIS GATE DOES NOT COVER. The scan is a partial derivation: many test
 * files read by path with a module anchor and it reports only the subset it
 * can resolve. The remainder is pinned by name below in
 * `UNREPORTED_PATH_READING_SUITES`, so the gap is a reviewable list whose
 * failure names the suite that moved, rather than a count whose failure only
 * said "re-measure". A pin
 * reached through a helper parameter (`const read = (p) =>
 * readFileSync(join(UI_SRC, p))`, at least 14 files, hiding
 * `ChatDockHeader.tsx`, `DockShell.tsx` and `ProjectLayoutRenderer.tsx`) or
 * written as a cwd-relative literal is not seen at all. A green run here is
 * evidence about the pins the scanner reports, not about the class;
 * `path-read-pin-scan.mjs` carries the full statement of the gap.
 *
 * A Playwright pin under `tests/` is SEEN and existence-checked but never
 * scheduled — Vitest excludes `tests/**` and the specs are not in the
 * resource manifest. Scheduling them is #1817.
 *
 * The scanner's own rules are exercised against literal sources so that the
 * repository-wide assertions above cannot be the only thing holding them up.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  invertPathReadPins,
  listSuiteFiles,
  readsFileByPath,
  scanPathReadPins,
  scanPathReadPinsInSource,
} from '../lib/path-read-pin-scan.mjs';
import { selectChangedVerification } from '../run-changed-verification.mjs';
import {
  buildTestImpactManifest,
  E2E_CONTRACT_BOUNDARIES,
  PATH_READ_PIN_BOUNDARY_TEST,
  pathReadPinEdges,
  REPO_SCAN_SUITES,
  TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY,
  TEST_IMPACT_MANIFEST,
  validateTestImpactManifest,
} from '../test-impact-manifest.mjs';
import { partitionVitestResourceSubset } from '../vitest-resource-manifest.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const entries = scanPathReadPins({ root: ROOT });
const pins = invertPathReadPins(entries);
const derived = pathReadPinEdges({ root: ROOT });

/**
 * The coverage gap, pinned BY IDENTITY rather than as a count.
 *
 * This used to be two numbers (`PATH_READING_SUITES` / `REPORTED_SUITES`).
 * A count drifts from any pull request that adds or removes a path read
 * ANYWHERE in the tree, and its failure only ever said "re-measure" — so
 * #1836 moved two pins among 357 files, this went 144 -> 143, and the number
 * carried no hint of which suite had moved. Naming the suites instead makes
 * the failure a diff: a new entry is a suite whose path read the scanner
 * cannot resolve, a disappearing entry is one that gained a real import (the
 * good outcome #1836 actually produced). That is the pattern
 * `orchestration-source-invariants.test.ts` adopted for the same reason,
 * after a `files.length > 300` floor against an actual 960 masked a dropped
 * subtree.
 *
 * Every entry here is a suite that reads a file by path in a way the scanner
 * misses — mostly cwd-relative reads and computed paths, both missed by
 * construction. Shrinking this list is the goal; growing it is a decision.
 */
const UNREPORTED_PATH_READING_SUITES: readonly string[] = Object.freeze([
  'packages/cli/src/__tests__/dev-security.test.ts',
  'packages/contracts/src/__tests__/answer-share-channel-corpus.test.ts',
  'packages/contracts/src/__tests__/flow-agents-vocabulary-drift.test.ts',
  'packages/sdk/src/__tests__/client-entry-portability.test.ts',
  'packages/sdk/src/__tests__/keyedQueryDefaults.test.ts',
  'packages/shared/src/__tests__/plugin-build.test.ts',
  'packages/shared/src/__tests__/plugin-dependency-install.test.ts',
  'packages/shared/src/__tests__/turn-provenance-ref-slot-producers.test.ts',
  'scripts/__tests__/android-network-policy.test.ts',
  'scripts/__tests__/basis-mcp-apps.test.ts',
  'scripts/__tests__/builder-delivery-viewer-import-gate.test.ts',
  'scripts/__tests__/changed-verification.test.ts',
  'scripts/__tests__/guardrail-known-bad-fixtures.test.ts',
  'scripts/__tests__/guardrail-process-boundary.test.ts',
  'scripts/__tests__/publish-oidc-exchange-status.test.ts',
  'scripts/__tests__/publish-surface.test.ts',
  'scripts/__tests__/release-sbom-generation.test.ts',
  'scripts/__tests__/repo-guardrail-source.test.ts',
  'scripts/__tests__/screenshot-diff.test.ts',
  'scripts/__tests__/tauri-webdriver-boundary.test.ts',
  'scripts/__tests__/trust-bundle-claim-prose.test.ts',
  'scripts/__tests__/verification-lanes.test.ts',
  'scripts/__tests__/verification-reporter.test.ts',
  'src-server/knowledge-store/adapters/__tests__/file-transactions.test.ts',
  'src-server/providers/__tests__/claude-adapter.test.ts',
  'src-server/routes/__tests__/smart-routing-plugin.test.ts',
  'src-server/routes/__tests__/sse-response-tripwire.test.ts',
  'src-server/routes/chat/__tests__/chat-turn-dedup.test.ts',
  // #2067's enumeration inventory. Its citation guard reads whichever file a
  // row cites, to require that the file actually REQUESTS the route rather
  // than merely mentioning it — so the path comes from a data structure and
  // the scanner refuses it by construction, the same shape as this file's own
  // entry above. Anchoring is not available: the point of the read is that the
  // path is the citation. Growing this list is a decision, and this is it.
  'src-server/routes/plugins/__tests__/plugin-identity-enumeration.test.ts',
  'src-server/runtime/__tests__/orchestration-transfer-budget.integration.test.ts',
  'src-server/security/__tests__/svg-response-tripwire.test.ts',
  'src-server/services/__tests__/flow-agents-skills.test.ts',
  // Device hosts: these read only their own fixtures (real OpenSSH
  // transcripts, anchored to the test file) or, for the resolver, walk the
  // server source tree to prove a structural rule. Neither names a source
  // file the scanner could pin, so there is nothing to report.
  'src-server/services/devices/__tests__/device-host-resolver.test.ts',
  'src-server/services/devices/hosts/__tests__/ssh-device-hub.test.ts',
  'src-server/services/devices/hosts/__tests__/ssh-device-target.test.ts',
  'src-server/services/evidence/__tests__/console-bridge-service.test.ts',
  'src-server/services/orchestration/__tests__/event-store.test.ts',
  'src-server/services/orchestration/__tests__/orchestration-source-invariants.test.ts',
  'src-server/services/plugins/__tests__/plugin-installation-restart.test.ts',
  'src-server/services/plugins/__tests__/plugin-installation.integration.test.ts',
  'src-server/services/projects/__tests__/task-graph-service.dispatch-claim.test.ts',
  'src-server/services/scheduling/__tests__/scheduler-ledger-corruption.test.ts',
  'src-server/services/scheduling/__tests__/scheduler-ledger.test.ts',
  'src-server/services/search/__tests__/isolated-task-search.test.ts',
  'src-server/tools/__tests__/station-docs-mcp-server.test.ts',
  'src-ui/src/__tests__/activity-rename-sweep.test.ts',
  'src-ui/src/__tests__/connection-host-copy.test.ts',
  'src-ui/src/__tests__/keepPreviousDataConsumers.test.ts',
  'src-ui/src/__tests__/package-css-fork.test.ts',
  'src-ui/src/__tests__/sessionStatusWordCallers.test.ts',
  'src-ui/src/__tests__/shell-chrome-notice-primitive.test.ts',
  'src-ui/src/app-shell/__tests__/RoutePendingSkeleton.test.tsx',
  'src-ui/src/components/first-run/__tests__/tour-steps.test.ts',
  'src-ui/src/views/project-settings/__tests__/ResourcesSection.test.tsx',
  'tests/basis-mcp-interop.spec.ts',
  'tests/builder-delivery-viewer.spec.ts',
  'tests/session-inventory-mcp-interop.spec.ts',
  'tests/survey-review-workbench.spec.ts',
]);

/**
 * The one remaining Playwright pin: seen and existence-checked, never
 * scheduled. If `station-cli.ts` moves, the boundary gate reds at
 * fast-checks instead of the spec breaking at e2e time. The second pin this
 * list used to carry (`mobile-surface-sweep.spec.ts` reading
 * `destination-registry.ts`) is gone for the better reason: #1836 replaced
 * the path read with a real import, which an import-graph selection and the
 * module resolver now guard — a text-pin existence check would be noise.
 */
const E2E_PINS = Object.freeze([
  {
    pin: 'scripts/station-cli.ts',
    spec: 'tests/plugin-dev-hot-reload.spec.ts',
  },
]);

function selectedTests(paths: string[], manifest?: unknown): string[] {
  return selectChangedVerification(paths, manifest as never)
    .tests.map(({ path }: { path: string }) => path)
    .sort();
}

/**
 * #2176: every suite that walks a real source tree is run by the
 * `repo-scans` job (`REPO_SCAN_SUITES`) or says here why it need not be. A
 * tree walk has no impact edge an honest selection can use, so without this
 * a new scanner would run only in the merge queue's full corpus again.
 *
 * HOW A WALK IS FOUND, AND WHAT THAT CANNOT SEE. `realTreeWalks` is a text
 * heuristic over one suite's source with comments removed:
 *
 * - A WALK is a `readdir`/`readdirSync` call, a `git ls-files` invocation or
 *   a glob-family call. A walk written any other way — a lister imported
 *   from a gate module, a shell `find`, `fs.opendir` — is invisible;
 *   `HELPER_BASED_SCANS` names the ones known when this landed.
 * - A walk is exempt, one call at a time, only when its target looks
 *   TEMPORARY at that point in the file: the argument (for `ls-files`, a
 *   `cwd:` inside that same call's arguments — never a neighbour's) contains
 *   a temp-directory call; a whole name token temp/tmp/scratch/temporary
 *   (camelCase, `_`, `-` and `.` split tokens, so `templates`, `itemPath` and
 *   `attempt` are not temp); a call to a local function whose EVERY return is
 *   temp-derived; or an identifier whose NEAREST PRECEDING assignment in the
 *   file is temp-derived, by the same rules. A walk inside a helper, on the
 *   helper's own parameter, is exempt when every outside call of the helper
 *   passes such an argument. A suite that creates temp directories is NOT
 *   exempt as a whole.
 * - LIMITS. Resolution is by file order, not by scope: a binding assigned in
 *   one test and used in another, or a helper called before its definition,
 *   resolves to whatever assignment precedes it textually. Imported fixture
 *   factories, object properties (`f.root`) and parameters of functions that
 *   are not the walking helper are not traced. The untraced forms err toward
 *   REPORTING a walk, and the suites they report are classified by hand below
 *   (`TEMP_VIA_FIXTURE`). The ways a real walk can still hide: a real
 *   directory held in a binding NAMED with a temp token or spelled with one
 *   in a path literal (`'fixtures/tmp-shapes'`); a `return` the regex does
 *   not see (a multi-line return is judged by its first line); file-order
 *   resolution itself, when an earlier test's temp `root` shadows a later
 *   walk of a module-level real `root`; an argument that mentions any temp
 *   value anywhere (`flag ? mkdtempSync() : join(cwd, 'src')`); and mixed
 *   destructuring (`const { tmp, src } = { tmp: mkdtempSync(), src: … }`
 *   marks `src` temp). None of these shapes existed in the suites when this
 *   was written (every exempted walk argument was traced by hand).
 */
const WALK_CALL = new RegExp(['\\bread', 'dir(?:Sync)?\\s*\\('].join(''), 'g');
const LS_FILES = new RegExp(['\\bls', '-files\\b'].join(''), 'g');
const GLOB_CALL = new RegExp(
  ['\\b(?:glob|globSync|globby|fastGlob|tinyglobby)', '\\s*\\('].join(''),
  'g',
);
const TEMP_SOURCE =
  /\bmkdtemp(?:Sync)?\b|\btmpdir\(\)|\bmakeTempDir\b|\bmakeTemp\w*\(|\bcreateTemp\w*\(|\btempDir\(|\btemporaryDirectory\(/;
/** Whole name tokens only: `templates`, `itemPath`, `attempt` are not temp. */
const TEMP_TOKENS = new Set(['temp', 'tmp', 'scratch', 'temporary']);
const FUNCTION_HEAD =
  /function\s+(\w+)\s*(?:<[^>]*>)?\(([^)]*)\)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::[^=]+)?=>/g;
const ASSIGNMENT =
  /(?:(?:const|let|var)\s+|^\s*|[;{]\s*)(?:\{([^}]*)\}|(\w+))\s*(?::[^=\n]+)?=(?![=>])\s*([^;]*)/gm;
const KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'return',
  'await',
  'new',
  'true',
  'false',
  'null',
  'undefined',
  'function',
  'async',
]);

/** True when some identifier or word in `text` has a whole temp token. */
function hasTempToken(text: string): boolean {
  for (const word of text.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [])
    for (const token of word.split(/(?<=[a-z0-9])(?=[A-Z])/))
      if (TEMP_TOKENS.has(token.toLowerCase())) return true;
  return false;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function callArgument(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length && i < open + 400; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1, open + 200);
}

function mentions(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(text);
}

/** Every local function, with its body span and parameters. */
function localFunctions(source: string) {
  return [...source.matchAll(FUNCTION_HEAD)].map((head) => {
    const start = head.index ?? 0;
    let open = start + head[0].length;
    while (open < source.length && /\s/.test(source[open])) open += 1;
    if (source.startsWith('=>', open)) open += 2;
    while (open < source.length && /[\s:\w<>[\]|]/.test(source[open]))
      open += 1;
    const braced = source[open] === '{';
    let end = source.indexOf('\n', open);
    if (braced) {
      let depth = 0;
      for (end = open; end < source.length; end += 1) {
        if (source[end] === '{') depth += 1;
        else if (source[end] === '}' && --depth === 0) break;
      }
    }
    end = end === -1 ? source.length : end;
    return {
      name: head[1] ?? head[3],
      start,
      bodyStart: open,
      end,
      braced,
      params: (head[2] ?? head[4])
        .split(',')
        .map((param) =>
          param
            .trim()
            .split(/[:=\s]/)[0]
            .replace(/^\.\.\./, ''),
        )
        .filter(Boolean),
    };
  });
}

/**
 * Temp-ness of an expression AT a position: a temp call, a whole temp token,
 * a call to a local function that ALWAYS returns a temp-derived value, or an
 * identifier whose nearest preceding assignment is itself temp.
 */
function tempResolver(source: string) {
  const functions = localFunctions(source);
  const assignments = [...source.matchAll(ASSIGNMENT)].map((match) => ({
    index: match.index ?? 0,
    names: match[2]
      ? [match[2]]
      : (match[1] ?? '')
          .split(',')
          .map((part) => part.split(':').pop()?.trim() ?? '')
          .filter(Boolean),
    value: match[3],
  }));
  const assignmentMemo = new Map<number, boolean>();
  const factoryMemo = new Map<string, boolean>();

  const resolveName = (name: string, before: number): boolean => {
    let nearest: (typeof assignments)[number] | undefined;
    for (const assignment of assignments)
      if (assignment.index < before && assignment.names.includes(name))
        nearest = assignment;
    if (!nearest) return false;
    const known = assignmentMemo.get(nearest.index);
    if (known !== undefined) return known;
    assignmentMemo.set(nearest.index, false); // cycle guard
    const result =
      nearest.names.some(hasTempToken) ||
      valueIsTemp(nearest.value, nearest.index);
    assignmentMemo.set(nearest.index, result);
    return result;
  };

  const alwaysReturnsTemp = (name: string): boolean => {
    const known = factoryMemo.get(name);
    if (known !== undefined) return known;
    factoryMemo.set(name, false); // cycle guard
    const fn = functions.find((candidate) => candidate.name === name);
    let result = false;
    if (fn) {
      const body = source.slice(fn.bodyStart, fn.end + 1);
      const returns = fn.braced
        ? [...body.matchAll(/\breturn\s+([^;\n]+)/g)].map((match) => ({
            text: match[1],
            at: fn.bodyStart + (match.index ?? 0),
          }))
        : [{ text: body, at: fn.bodyStart }];
      result =
        returns.length > 0 &&
        returns.every(({ text, at }) => valueIsTemp(text, at + 1));
    }
    factoryMemo.set(name, result);
    return result;
  };

  const valueIsTemp = (text: string, at: number): boolean => {
    if (TEMP_SOURCE.test(text) || hasTempToken(text)) return true;
    for (const call of text.matchAll(/\b(\w+)\s*\(/g))
      if (alwaysReturnsTemp(call[1])) return true;
    for (const identifier of new Set(text.match(/\b[A-Za-z_$][\w$]*\b/g)))
      if (!KEYWORDS.has(identifier) && resolveName(identifier, at)) return true;
    return false;
  };

  return { functions, valueIsTemp };
}

/** The argument text of the innermost call that contains `index`. */
function enclosingCallArguments(source: string, index: number): string {
  let depth = 0;
  for (let i = index; i >= 0 && i > index - 600; i -= 1) {
    if (source[i] === ')') depth += 1;
    else if (source[i] === '(') {
      if (depth === 0) return callArgument(source, i);
      depth -= 1;
    }
  }
  return '';
}

/** Every walk in `raw` whose target does not look temporary. */
function realTreeWalks(raw: string): string[] {
  const source = stripComments(raw);
  const { functions, valueIsTemp } = tempResolver(source);
  const enclosing = (index: number) =>
    functions
      .filter((fn) => fn.start < index && index <= fn.end)
      .sort((left, right) => right.start - left.start)[0];
  const tempTarget = (text: string, at: number) => {
    if (valueIsTemp(text, at)) return true;
    // A walk inside a helper, on the helper's own parameter: temp only when
    // every outside call site passes a temp-derived argument.
    const fn = enclosing(at);
    if (!fn?.params.some((param) => mentions(text, param))) return false;
    const outside = [
      ...source.matchAll(new RegExp(`\\b${fn.name}\\s*\\(`, 'g')),
    ].filter(
      (call) =>
        call.index !== fn.start &&
        !source.slice((call.index ?? 0) - 9, call.index).includes('function') &&
        enclosing(call.index ?? 0)?.name !== fn.name,
    );
    return (
      outside.length > 0 &&
      outside.every((call) =>
        valueIsTemp(
          callArgument(source, (call.index ?? 0) + call[0].length - 1),
          call.index ?? 0,
        ),
      )
    );
  };
  const walks: string[] = [];
  for (const pattern of [WALK_CALL, GLOB_CALL])
    for (const match of source.matchAll(pattern)) {
      const at = match.index ?? 0;
      const argument = callArgument(source, at + match[0].length - 1);
      if (!tempTarget(argument, at)) walks.push(argument.slice(0, 80));
    }
  for (const match of source.matchAll(LS_FILES)) {
    const at = match.index ?? 0;
    // Only a `cwd:` inside THIS call's own arguments counts; a neighbour's
    // `cwd: tempRepo` says nothing about where this one runs.
    const cwd = /\bcwd:\s*([^,}\n]+)/.exec(enclosingCallArguments(source, at));
    if (!cwd || !valueIsTemp(cwd[1], at))
      walks.push(`ls-files cwd=${cwd?.[1] ?? '.'}`);
  }
  return walks;
}

/** Scans whose walk is not visible in their own text. */
const HELPER_BASED_SCANS = Object.freeze([
  // Lists its scope through the gate module's `scopedFiles()`.
  'scripts/__tests__/builder-delivery-viewer-import-gate.test.ts',
]);

const TEMP_VIA_FIXTURE =
  'hand-checked: walks only a temporary directory the text heuristic cannot ' +
  'trace (a fixture object, a caller in another scope, or a same-named ' +
  'binding in another test)';
const WRAPS_FS =
  'wraps fs.readdir in a mock; walks whatever the code under test asks';

/** Detected real-tree walkers that are not repo scans, and why. */
const DIRECTORY_WALKS_THAT_ARE_NOT_REPO_SCANS: Readonly<
  Record<string, string>
> = Object.freeze({
  'packages/contracts/src/__tests__/answer-share-channel-corpus.test.ts':
    'walks its own fixture directory',
  'packages/contracts/src/__tests__/channel-fixture-corpus.test.ts':
    'walks its own fixture directory',
  'packages/sdk/src/__tests__/client-entry-portability.test.ts':
    'walks packages/sdk/src/client; its packages/sdk/src/client/** edge selects it',
  'packages/shared/src/__tests__/workspace-package.test.ts': TEMP_VIA_FIXTURE,
  'scripts/__tests__/android-channel-release-generation.test.ts':
    'lists .github/workflows; the .github/workflows/** edge selects it',
  'scripts/__tests__/android-firebase-workflow-env.test.ts':
    'lists .github/workflows; the .github/workflows/** edge selects it',
  'scripts/__tests__/basis-mcp-apps.test.ts':
    'git ls-files over its own generated outputs, to prove they are untracked',
  'scripts/__tests__/generate-app-icons.test.ts':
    'incidental: compares the committed icon sets and .icns files it regenerates',
  'scripts/__tests__/guardrail-known-bad-fixtures.test.ts':
    'walks its own fixture root',
  'scripts/__tests__/path-read-pin-boundary.test.ts':
    "this file: the detector's own strings name the calls it looks for; the prepush floor runs it (#1913)",
  'scripts/__tests__/release-workflow.test.ts':
    'lists .github/workflows; the .github/workflows/** edge selects it',
  'scripts/__tests__/verification-policy-gate.test.ts':
    'stubs git ls-files to test the gate; walks nothing real',
  'scripts/__tests__/vitest-resource-manifest.test.ts':
    'packages/connect tests; the check rides the suite-wide Vitest discovery ' +
    'the whole file shares, and verification:policy:gate re-derives the ' +
    'corpus partition in ci:fast',
  'scripts/__tests__/worktree-hygiene-git.test.ts': TEMP_VIA_FIXTURE,
  'src-server/knowledge-index/__tests__/migration-path-traversal.test.ts':
    TEMP_VIA_FIXTURE,
  'src-server/knowledge-index/__tests__/migration.test.ts': TEMP_VIA_FIXTURE,
  'src-server/providers/__tests__/claude-skills-materialization.test.ts':
    TEMP_VIA_FIXTURE,
  'src-server/providers/app-home/__tests__/app-home-profiles.test.ts':
    TEMP_VIA_FIXTURE,
  'src-server/routes/orchestration/__tests__/tasks.routes.test.ts':
    TEMP_VIA_FIXTURE,
  'src-server/routes/projects/__tests__/coding-git-security.routes.test.ts':
    'git ls-files inside the temporary project it creates',
  'src-server/runtime/conversation/__tests__/runtime-event-log.test.ts':
    WRAPS_FS,
  'src-server/services/plugins/__tests__/example-manifest-fields.test.ts':
    'walks examples/; its examples/** edge selects it',
  'src-server/services/projects/__tests__/plugin-publish-service.test.ts':
    TEMP_VIA_FIXTURE,
  'src-server/services/ssh/__tests__/environment-security-lock-race.test.ts':
    WRAPS_FS,
  'packages/cli/src/__tests__/install-registry.test.ts': TEMP_VIA_FIXTURE,
  'scripts/__tests__/ios-channel-icons.test.ts':
    'incidental: checks the committed iOS icon sets against their catalog, like generate-app-icons',
  'scripts/__tests__/server-build-portability.test.ts': TEMP_VIA_FIXTURE,
  'scripts/__tests__/typecheck-host-slots.test.ts':
    'walks a directory handed to a fixture child on its argv',
  'src-server/providers/__tests__/muse-adapter.real-child.process.test.ts':
    TEMP_VIA_FIXTURE,
  'src-server/routes/knowledge/__tests__/knowledge-source.routes.test.ts':
    TEMP_VIA_FIXTURE,
  'src-server/runtime/bootstrap/__tests__/station-runtime-store-quarantine.test.ts':
    TEMP_VIA_FIXTURE,
  'src-server/services/agents/__tests__/playbook-skill-migration.test.ts':
    TEMP_VIA_FIXTURE,
  'src-server/services/browser/__tests__/chromium-acquisition.test.ts':
    TEMP_VIA_FIXTURE,
  'src-server/services/checkpoints/__tests__/checkpoint-index-store.test.ts':
    TEMP_VIA_FIXTURE,
  'src-server/services/infra/__tests__/server-log-store.test.ts':
    TEMP_VIA_FIXTURE,
  'src-server/utils/__tests__/git-exec.hardening.test.ts':
    'git ls-files inside the temporary repository its helper creates',
  'tests/learning-source.spec.ts':
    'a Playwright spec; Vitest cannot schedule it (#1817)',
  'src-ui/src/__tests__/station-vocabulary.test.ts':
    'walks src-ui/src only; its src-ui/src/** edge selects it on every change there',
  'tests/builder-delivery-viewer.spec.ts':
    'a Playwright spec (examples/builder-delivery-viewer); Vitest cannot schedule it (#1817)',
});

describe('whole-tree scans are run or classified (#2176)', () => {
  const suites = listSuiteFiles(ROOT);
  const walkers = suites.filter(
    (file) => realTreeWalks(readFileSync(join(ROOT, file), 'utf8')).length > 0,
  );

  it('the walk heuristic exempts a temporary target and reports a real one', () => {
    // Directional controls on literal sources, so the repository-wide
    // assertions below are not the only thing holding the heuristic up.
    const read = ['read', 'dirSync'].join('');
    // Assembled, so this file does not trip the raw temp-dir ratchet (#2421).
    const mk = ['mk', 'dtempSync'].join('');
    expect(
      realTreeWalks(`const dir = ${mk}(join(tmpdir(), 'x'));\n${read}(dir);`),
    ).toEqual([]);
    expect(realTreeWalks(`${read}(join(ROOT, 'docs'));`)).toHaveLength(1);
    // One real walk in a suite that also makes temp directories still counts.
    expect(
      realTreeWalks(`const t = ${mk}('x');\n${read}(t);\n${read}('examples');`),
    ).toEqual(["'examples'"]);
    // A helper walking its own parameter follows its call sites.
    const helper = `function walk(dir) { return ${read}(dir); }\n`;
    expect(
      realTreeWalks(`${helper}const home = makeTempDir('h');\nwalk(home);`),
    ).toEqual([]);
    expect(realTreeWalks(`${helper}walk('src-ui/src');`)).toHaveLength(1);
    // Adversarial controls from the #2176 final review: each must SURFACE.
    // (a) A temp token must be a whole name token, not a substring.
    expect(
      realTreeWalks(`${read}(join(ROOT, 'src-server/templates'));`),
    ).toHaveLength(1);
    expect(
      realTreeWalks(`const itemPath = join(cwd, 'src');\n${read}(itemPath);`),
    ).toHaveLength(1);
    // (b) A shadowed name resolves to its nearest preceding assignment.
    expect(
      realTreeWalks(
        `let root = ${mk}('x');\n${read}(root);\nroot = join(REPO, 'src');\n${read}(root);`,
      ),
    ).toEqual(['root']);
    // (c) A helper that returns a temp dir on only one branch is not a temp
    // factory; one that always does is.
    expect(
      realTreeWalks(
        `function resolveDir(p) {\n  if (p) return makeTempDir('x');\n  return join(REPO, p);\n}\nconst d = resolveDir(p);\n${read}(d);`,
      ),
    ).toHaveLength(1);
    expect(
      realTreeWalks(
        `function fresh() {\n  return makeTempDir('x');\n}\nconst d = fresh();\n${read}(d);`,
      ),
    ).toEqual([]);
    // (d) Only a \`cwd:\` in the call's OWN arguments counts.
    const ls = ['ls', '-files'].join('');
    expect(
      realTreeWalks(
        `execFileSync('git', ['init'], { cwd: tempRepo });\nexecFileSync('git', ['${ls}']);`,
      ),
    ).toHaveLength(1);
    expect(
      realTreeWalks(`execFileSync('git', ['${ls}'], { cwd: tempRepo });`),
    ).toEqual([]);
    // A comment naming the call is not a walk.
    expect(realTreeWalks(`// ${read}('docs')\n`)).toEqual([]);
  });

  it('every real-tree walker is a repo scan or classified with a reason', () => {
    // Population first: the check below is satisfied by an empty list.
    expect(walkers.length).toBeGreaterThan(REPO_SCAN_SUITES.length);
    expect(
      walkers.filter(
        (file) =>
          !REPO_SCAN_SUITES.includes(file) &&
          !(file in DIRECTORY_WALKS_THAT_ARE_NOT_REPO_SCANS),
      ),
      'a suite walks a real directory but is neither in REPO_SCAN_SUITES ' +
        '(scripts/test-impact-manifest.mjs) nor classified here',
    ).toEqual([]);
  });

  it('no classification outlives the walk it explains', () => {
    expect(
      Object.keys(DIRECTORY_WALKS_THAT_ARE_NOT_REPO_SCANS).filter(
        (file) => !walkers.includes(file),
      ),
    ).toEqual([]);
  });

  it('every repo scan suite exists, is runnable by Vitest, and is not also classified away', () => {
    expect(REPO_SCAN_SUITES.length).toBeGreaterThan(0);
    for (const file of REPO_SCAN_SUITES) {
      expect(existsSync(join(ROOT, file)), file).toBe(true);
      expect(file.startsWith('tests/'), file).toBe(false);
      expect(file in DIRECTORY_WALKS_THAT_ARE_NOT_REPO_SCANS, file).toBe(false);
    }
    for (const file of HELPER_BASED_SCANS)
      expect(REPO_SCAN_SUITES, file).toContain(file);
    expect(new Set(REPO_SCAN_SUITES).size).toBe(REPO_SCAN_SUITES.length);
  });

  it('the repo-scans CI job runs exactly the one list, on same-repository pull requests', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['test:repo-scans']).toBe(
      'node scripts/run-repo-scan-suites.mjs',
    );
    // What the runner hands the focused runner is asserted behaviourally in
    // run-repo-scan-suites.test.ts.
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const job = ci.slice(
      ci.indexOf('\n  repo-scans:\n'),
      ci.indexOf('\n  fork-smoke:\n'),
    );
    expect(job).toContain('run: npm run test:repo-scans');
    expect(job).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
    // The checkout's own `ref:` line, not the concurrency group (which also
    // names the head sha).
    expect(job).toMatch(
      /\n {10}ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}\n/,
    );
  });
});

describe('path-read pins are discovered', () => {
  it('finds pins across the repository', () => {
    // A near-empty result means the scanner stopped resolving, not that the
    // repository stopped pinning. The floor is far below today's count so it
    // does not become a number people raise.
    expect(pins.length).toBeGreaterThan(40);
    expect(entries.length).toBeGreaterThan(20);
  });

  it('finds the pin whose silent break motivated this gate', () => {
    // The whole story in one fixture. #1785 moved the outbound-queue call
    // out of `ChatDock.tsx` into `useConversationBoundaryDialogs.ts`; this
    // test's pin still read `ChatDock.tsx`, went red on `main`, and nobody's
    // pull request selected it because a path read has no import edge. #1808
    // fixed it forward by repointing the pin at the hook — which is where it
    // reads today, and why this fixture names that file rather than the dock.
    // Had this gate existed, the move would have scheduled the pin at
    // fast-checks instead.
    const outboundQueuePin = pins.find(
      ({ pin }) =>
        pin ===
        'src-ui/src/components/chat-dock/useConversationBoundaryDialogs.ts',
    );
    expect(outboundQueuePin?.tests).toContain(
      'src-ui/src/__tests__/useOutboundQueueSnapshot.test.tsx',
    );
  });

  it('names every suite whose path read the scanner cannot resolve', () => {
    const reading = listSuiteFiles(ROOT).filter((file) =>
      readsFileByPath(readFileSync(join(ROOT, file), 'utf8')),
    );
    const reported = new Set(entries.map(({ test }) => test));
    const unreported = reading
      .filter((file) => !reported.has(file))
      .sort((left, right) => left.localeCompare(right));

    // A diff of names, not a moved number. Vitest prints the added and
    // removed entries, so the failure says WHICH suite changed and in which
    // direction — an added name is a new blind spot, a removed one is a path
    // read that became a real import and is now guarded by the module graph.
    expect(
      unreported,
      'the set of path-reading suites the scanner cannot resolve changed. ' +
        'An ADDED entry is a new blind spot: prefer converting the read to ' +
        'an import, or anchor it (new URL(..., import.meta.url)) so the ' +
        'scanner can pin it. A REMOVED entry is the good case — drop it ' +
        'from UNREPORTED_PATH_READING_SUITES.',
    ).toEqual([...UNREPORTED_PATH_READING_SUITES]);

    // The scanner still has to be doing real work: an empty reported set
    // would satisfy the pin above by reporting nothing at all.
    expect(entries.length).toBeGreaterThan(unreported.length / 2);
  });

  it('finds a pin the read call site alone cannot resolve', () => {
    // `conversationContextBoundaryStatusCache.test.tsx` reads
    // `[join(...), join(...)].map((path) => readFileSync(path))`, so the
    // argument at the read is a callback parameter and names nothing.
    const dialogsPin = pins.find(
      ({ pin }) =>
        pin ===
        'src-ui/src/components/chat-dock/useConversationBoundaryDialogs.ts',
    );
    expect(dialogsPin?.tests).toContain(
      'src-ui/src/__tests__/conversationContextBoundaryStatusCache.test.tsx',
    );

    // The helper-parameter idiom (#2221's blind spot): the suite reads
    // chat.css through `read(...)`, so no import edge reaches it and the
    // call site alone names nothing. mobile-chrome-safety was the suite
    // whose stale pins only the nightly corpus saw while three redesigns
    // of the chip landed green.
    const chatCssPin = pins.find(
      ({ pin }) => pin === 'src-ui/src/components/chat/chat.css',
    );
    expect(chatCssPin?.tests).toContain(
      'src-ui/src/__tests__/mobile-chrome-safety.test.ts',
    );
  });
});

describe('every pinned path still exists', () => {
  it('names the pinning test and the path when a pin is broken', () => {
    const broken = pins
      .filter(({ pin }) => !existsSync(join(ROOT, pin)))
      .map(({ pin, tests }) => `${pin} — pinned by ${tests.join(', ')}`);
    expect(
      broken,
      'A test reads these paths as text and they are not on disk. Either the ' +
        'file moved and the pin must follow it, or the pin is stale and must ' +
        'be deleted. Do not silence this by loosening the scanner.',
    ).toEqual([]);
  });
});

describe('derived pin edges only add to selection', () => {
  const built = buildTestImpactManifest({ root: ROOT });

  it('supplements the committed manifest rather than replacing it', () => {
    expect(built.slice(0, TEST_IMPACT_MANIFEST.length)).toEqual(
      TEST_IMPACT_MANIFEST,
    );
    expect(built.length).toBe(TEST_IMPACT_MANIFEST.length + derived.length);
    expect(derived.length).toBeGreaterThan(40);
  });

  it('declares every derived edge supplemental and tests-only', () => {
    // `supplemental` is the whole reason these edges cannot narrow anything:
    // `selectChangedVerification` excludes them from the boundary,
    // escalation, and related decisions. An edge carrying `lanes` or
    // `related` would re-enter those decisions.
    for (const edge of derived) {
      expect(edge.supplemental, edge.pattern).toBe(true);
      expect(edge.related, edge.pattern).toBeUndefined();
      expect(edge.lanes, edge.pattern).toBeUndefined();
      expect(edge.tests?.length ?? 0, edge.pattern).toBeGreaterThan(0);
      expect(edge.tests, edge.pattern).toContain(PATH_READ_PIN_BOUNDARY_TEST);
    }
  });

  it('leaves lanes, related paths, and escalation exactly as they were', () => {
    for (const { pattern } of derived) {
      const before = selectChangedVerification([pattern]);
      const after = selectChangedVerification([pattern], built as never);
      expect(after.lanes, pattern).toEqual(before.lanes);
      expect(after.relatedPaths, pattern).toEqual(before.relatedPaths);
      expect(after.escalated, pattern).toBe(before.escalated);
      expect(
        before.tests
          .map(({ path }: { path: string }) => path)
          .filter(
            (test: string) =>
              !after.tests.some(({ path }: { path: string }) => path === test),
          ),
        `selection for ${pattern} lost tests`,
      ).toEqual([]);
    }
  });

  it('adds every schedulable pinning test for every pin', () => {
    for (const { pin, tests } of pins) {
      const selected = selectedTests([pin], built);
      for (const test of tests) {
        // A `tests/` spec is deliberately omitted (#1817); everything Vitest
        // can run must be there.
        if (test.startsWith('tests/')) {
          expect(selected, `${pin} -> ${test}`).not.toContain(test);
          continue;
        }
        expect(selected, pin).toContain(test);
      }
    }
  });

  it('selects the pinning test and this gate for a pinned path', () => {
    // Touching the hook #1785 moved the call into must schedule the pin that
    // reads it (#1808 repointed that pin), and must not have done so before.
    const hook =
      'src-ui/src/components/chat-dock/useConversationBoundaryDialogs.ts';
    const after = selectedTests([hook], built);
    expect(after).toContain(
      'src-ui/src/__tests__/useOutboundQueueSnapshot.test.tsx',
    );
    expect(after).toContain(PATH_READ_PIN_BOUNDARY_TEST);
    expect(selectedTests([hook])).not.toContain(
      'src-ui/src/__tests__/useOutboundQueueSnapshot.test.tsx',
    );
  });

  it('keeps a supplemental edge from cancelling an escalation', () => {
    // `vitest.global-setup.ts` escalates (it matches `isEscalationPath` and
    // no committed edge names it) and a test also pins it. Without the
    // supplemental exclusion its pin edge would set `hasExplicitBoundary` and
    // trade `ci-fast` for one focused test.
    const path = 'vitest.global-setup.ts';
    expect(pins.map(({ pin }) => pin)).toContain(path);
    expect(selectChangedVerification([path]).escalated).toBe(true);
    const selection = selectChangedVerification([path], built as never);
    expect(selection.escalated).toBe(true);
    expect(selection.lanes.map(({ id }: { id: string }) => id)).toContain(
      'ci-fast',
    );
    // ...and the pin is still named, on top of the escalation.
    expect(
      selection.tests.map(({ path: test }: { path: string }) => test),
    ).toContain('scripts/__tests__/vitest-teardown-race.test.ts');
  });
});

describe('a scheduled pin has to be runnable', () => {
  const built = buildTestImpactManifest({ root: ROOT });

  it('never schedules a Playwright spec', () => {
    // `selection.tests` is handed to Vitest, which excludes `tests/**`, so a
    // spec here is a target the receipt names and nothing runs.
    for (const edge of derived)
      for (const test of edge.tests ?? [])
        expect(test.startsWith('tests/'), `${edge.pattern} -> ${test}`).toBe(
          false,
        );
  });

  it('still existence-checks the pins only a Playwright spec makes', () => {
    // Not scheduling them is the trade; not SEEING them would give up the
    // property #1807 exists for. If `station-cli.ts` moves, the boundary
    // gate reds at fast-checks instead of the spec breaking at e2e time.
    for (const { pin, spec } of E2E_PINS) {
      const found = pins.find((entry: { pin: string }) => entry.pin === pin);
      expect(found?.tests, pin).toContain(spec);
      expect(
        entries.some(({ test }: { test: string }) => test === spec),
        spec,
      ).toBe(true);
    }
  });

  it('drops a Playwright pin rather than scheduling it', () => {
    // Known-bad: hand the derivation a scan entry naming a spec. The pin has
    // one pinning test and it is ineligible, so no edge is produced at all.
    const edges = pathReadPinEdges({
      root: ROOT,
      entries: [
        {
          test: 'tests/plugin-dev-hot-reload.spec.ts',
          pins: ['packages/cli/src/cli.ts'],
        },
        {
          test: 'src-ui/src/__tests__/useOutboundQueueSnapshot.test.tsx',
          pins: ['packages/cli/src/cli.ts'],
        },
      ],
    });
    expect(edges).toHaveLength(1);
    expect(edges[0].tests).toEqual([
      PATH_READ_PIN_BOUNDARY_TEST,
      'src-ui/src/__tests__/useOutboundQueueSnapshot.test.tsx',
    ]);
    expect(
      pathReadPinEdges({
        root: ROOT,
        entries: [
          {
            test: 'tests/plugin-dev-hot-reload.spec.ts',
            pins: ['packages/cli/src/cli.ts'],
          },
        ],
      }),
    ).toEqual([]);
  });

  it('leaves packages/cli/src/cli.ts selecting a runnable set', () => {
    // The live break: `tests/plugin-dev-hot-reload.spec.ts` imports
    // `node:child_process` and no Playwright spec is in the Vitest resource
    // manifest, so the resource plan raised an infrastructure error and
    // `run-ci-fast` (which tolerates only exit 3) went red for every pull
    // request touching this file.
    const selected = selectedTests(['packages/cli/src/cli.ts'], built);
    expect(selected.length).toBeGreaterThan(0);
    expect(() =>
      partitionVitestResourceSubset(selected, { root: ROOT }),
    ).not.toThrow();
  });

  it('keeps every scheduled pin inside the Vitest resource plan', () => {
    const scheduled = [
      ...new Set(derived.flatMap((edge) => [...(edge.tests ?? [])])),
    ].sort();
    expect(() =>
      partitionVitestResourceSubset(scheduled, { root: ROOT }),
    ).not.toThrow();
  });

  it('pins the boundary test path itself', () => {
    // Every derived edge names this constant. Existence alone is too weak: a
    // rename that repoints it at any other existing test passes while all 108
    // pins schedule the wrong file. If it points nowhere,
    // `escalateUnavailableExplicitTests` escalates every pinned path to
    // `test-full`, which nobody reads as a defect.
    expect(
      PATH_READ_PIN_BOUNDARY_TEST,
      'PATH_READ_PIN_BOUNDARY_TEST in scripts/test-impact-manifest.mjs must ' +
        'name this file; every derived pin edge schedules it',
    ).toBe(
      fileURLToPath(import.meta.url)
        .slice(ROOT.length)
        .replace(/\\/g, '/')
        .replace(/^\//, ''),
    );
    expect(existsSync(join(ROOT, PATH_READ_PIN_BOUNDARY_TEST))).toBe(true);
  });
});

describe('the derivation cannot produce an invalid manifest', () => {
  const uniquePatterns = [
    ...E2E_CONTRACT_BOUNDARIES,
    TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY.pattern,
  ];

  it('derives no edge for a pattern the validator requires to be unique', () => {
    for (const pattern of uniquePatterns) {
      const entries = [
        {
          test: 'scripts/__tests__/verification-lanes.test.ts',
          pins: [pattern],
        },
      ];
      expect(pathReadPinEdges({ root: ROOT, entries }), pattern).toEqual([]);
      expect(
        validateTestImpactManifest(
          buildTestImpactManifest({ root: ROOT, entries }),
        ),
        pattern,
      ).toEqual([]);
    }
  });

  it('known-bad: the naive edge for those patterns is rejected', () => {
    // Proves the skip is load-bearing. Without it the validator throws inside
    // `selectChangedVerification`, failing the whole gate and naming the E2E
    // contract edge rather than the test that added the read call.
    for (const pattern of uniquePatterns) {
      const naive = [
        ...TEST_IMPACT_MANIFEST,
        { pattern, supplemental: true, tests: ['scripts/__tests__/x.test.ts'] },
      ] as never;
      expect(validateTestImpactManifest(naive).join(' '), pattern).toContain(
        pattern,
      );
      expect(() => selectChangedVerification([pattern], naive)).toThrow(
        /impact manifest invalid/,
      );
    }
  });

  it('skips every committed pattern a uniqueness rule protects', () => {
    // The skip set and the validator's uniqueness rules are two hand-written
    // lists; iterating the same two constants the skip set is built from
    // cannot notice a NEW uniqueness rule keyed on some other pattern, which
    // would reintroduce the throw in full. Derive the property instead: add a
    // supplemental duplicate for every committed pattern and see which ones
    // the validator refuses.
    const patterns = [
      ...new Set(
        TEST_IMPACT_MANIFEST.map(({ pattern }: { pattern: string }) => pattern),
      ),
    ].sort();
    const refused = patterns.filter(
      (pattern) =>
        validateTestImpactManifest([
          ...TEST_IMPACT_MANIFEST,
          {
            pattern,
            supplemental: true,
            tests: ['scripts/__tests__/x.test.ts'],
          },
        ] as never).length > 0,
    );
    expect(refused.sort()).toEqual([...uniquePatterns].sort());
    for (const pattern of refused)
      expect(
        pathReadPinEdges({
          root: ROOT,
          entries: [
            {
              test: 'scripts/__tests__/verification-lanes.test.ts',
              pins: [pattern],
            },
          ],
        }),
        `${pattern} is refused by the validator but not skipped`,
      ).toEqual([]);
  });

  it('validates the live derived manifest', () => {
    expect(
      validateTestImpactManifest(buildTestImpactManifest({ root: ROOT })),
    ).toEqual([]);
  });

  it('known-bad: a supplemental edge carrying lanes or related is rejected', () => {
    // scripts/AGENTS.md: new policy needs a known-bad catch test and a
    // false-positive control. Both shapes would be silently ignored by
    // `selectChangedVerification`, so a reader would believe a lane was
    // scheduled that never was.
    const base = {
      pattern: 'src-ui/src/App.tsx',
      supplemental: true,
      tests: ['scripts/__tests__/x.test.ts'],
    };
    const withEdge = (edge: unknown) =>
      validateTestImpactManifest([...TEST_IMPACT_MANIFEST, edge] as never);
    const rejection =
      'supplemental impact edge may only add tests: src-ui/src/App.tsx';
    expect(withEdge({ ...base, lanes: ['ci-fast'] })).toEqual([rejection]);
    expect(withEdge({ ...base, related: true })).toEqual([rejection]);
    // False-positive controls: the tests-only supplemental edge, and an
    // ORDINARY edge carrying exactly those fields, are both accepted.
    expect(withEdge(base)).toEqual([]);
    expect(
      withEdge({
        pattern: base.pattern,
        related: true,
        lanes: ['ci-fast'],
        tests: base.tests,
      }),
    ).toEqual([]);
  });
});

describe('the scanner resolves only what it can justify', () => {
  const scan = (source: string, repoPath = 'src-ui/src/__tests__/x.test.ts') =>
    scanPathReadPinsInSource(source, { repoPath, root: ROOT });

  it('resolves a module-anchored read', () => {
    expect(
      scan(
        "import { readFileSync } from 'node:fs';\n" +
          "readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');\n",
      ),
    ).toEqual(['src-ui/src/App.tsx']);
  });

  it('resolves through a const and a file URL', () => {
    expect(
      scan(
        'const ROOT = dirname(fileURLToPath(import.meta.url));\n' +
          "const target = join(ROOT, '..', 'main.tsx');\n" +
          'readFileSync(target);\n',
      ),
    ).toEqual(['src-ui/src/main.tsx']);
  });

  it('resolves a read-helper parameter (arrow and function forms)', () => {
    // The idiom behind #2221's blind spot: the literal sits at the CALL, the
    // anchor sits in the helper body, and no import edge connects them.
    const helperForms = [
      "const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');\n" +
        "read('App.tsx');\n",
      'const read = (p: string): string =>\n' +
        "  readFileSync(join(__dirname, '..', p), 'utf-8');\n" +
        "read('App.tsx');\n",
      'function read(p: string): string {\n' +
        "  return readFileSync(join(__dirname, '..', p), 'utf-8');\n" +
        '}\n' +
        "read('App.tsx');\n",
    ];
    for (const source of helperForms)
      expect(scan(source), source).toEqual(['src-ui/src/App.tsx']);
  });

  it('resolves a helper whose parameter sits mid-path', () => {
    expect(
      scan(
        'const read = (p) => readFileSync(join(__dirname, p, "k.ts"));\n' +
          "read('..');\n",
      ),
    ).toEqual(['src-ui/src/k.ts']);
  });

  it('refuses a helper it cannot justify', () => {
    // Two parameters: which one carries the path is a guess, so no pin.
    expect(
      scan(
        "const read = (a, b) => readFileSync(join(__dirname, '..', a, b));\n" +
          "read('x', 'App.tsx');\n",
      ),
    ).toEqual([]);
    // The parameter used twice across TWO read calls: each call yields its
    // own justifiable template, so both reads pin.
    expect(
      scan(
        "const pair = (p) => [readFileSync(join(__dirname, p)), readFileSync(join(__dirname, '..', p))];\n" +
          "pair('App.tsx');\n",
      ).sort(),
    ).toEqual(['src-ui/src/App.tsx', 'src-ui/src/__tests__/App.tsx']);
    // The parameter used twice within ONE read argument: the template is
    // ambiguous, so that read resolves nothing.
    expect(
      scan(
        'const doubled = (p) => readFileSync(join(__dirname, p, p));\n' +
          "doubled('x');\n",
      ),
    ).toEqual([]);
    // A non-literal call site cannot be substituted.
    expect(
      scan(
        "const read = (p) => readFileSync(join(__dirname, '..', p));\n" +
          "read(nameFor('App.tsx'));\n",
      ),
    ).toEqual([]);
    // A name defined twice is poisoned, mirroring collectBindings.
    expect(
      scan(
        "const read = (p) => readFileSync(join(__dirname, '..', p));\n" +
          'const read = (p) => readFileSync(join(__dirname, p));\n' +
          "read('App.tsx');\n",
      ),
    ).toEqual([]);
    // The read lives in a nested definition, so the outer body's read is
    // not the outer helper's own.
    expect(
      scan(
        'const outer = (p) => {\n' +
          "  const inner = (q) => readFileSync(join(__dirname, '..', q));\n" +
          '  return inner(p);\n' +
          '};\n' +
          "outer('App.tsx');\n",
      ),
    ).toEqual([]);
  });

  it('does not pin a helper read of a file the test writes', () => {
    expect(
      scan(
        "const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');\n" +
          "const planted = 'planted.ts';\n" +
          "writeFileSync(join(__dirname, '..', planted), 'x');\n" +
          'read(planted);\n',
      ),
    ).toEqual([]);
  });

  it('resolves a path written inside a template interpolation', () => {
    expect(
      scan(
        'readFileSync(__filename);\n' +
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder IS the fixture — the scan matches this text shape.
          "const entry = `export * from ${JSON.stringify(join(__dirname, '..', 'App.tsx'))};`;\n",
      ),
    ).toEqual(['src-ui/src/App.tsx']);
  });

  it('refuses a path that is not anchored to the module', () => {
    // `resolve('src-ui/src/App.tsx')` is relative to the process cwd, which
    // is not a repository fact.
    expect(
      scan(
        "readFileSync(resolve('src-ui/src/App.tsx'));\n" +
          "readFileSync(join(tmpdir(), 'App.tsx'));\n",
      ),
    ).toEqual([]);
  });

  it('refuses an expression it cannot fully resolve', () => {
    expect(
      scan(
        "readFileSync(join(__dirname, computeName()), 'utf8');\n" +
          'readFileSync(somethingElse);\n',
      ),
    ).toEqual([]);
  });

  it('does not pin a file the test itself creates', () => {
    // False-positive control: a planted negative control resolves exactly
    // like a pin but is the test's own output.
    expect(
      scan(
        "const planted = join(__dirname, '..', '__planted__.ts');\n" +
          "readFileSync(planted, 'utf8');\n" +
          "writeFileSync(planted, 'x');\n",
      ),
    ).toEqual([]);
  });

  it('still pins the source of a symlink it creates', () => {
    expect(
      scan(
        'readFileSync(__filename);\n' +
          "symlinkSync(join(__dirname, '..', 'App.tsx'), join(__dirname, 'link.ts'));\n",
      ),
    ).toEqual(['src-ui/src/App.tsx']);
  });

  it('does not pin a synthesized extensionless location', () => {
    // False-positive control: an extensionless path that is not on disk is a
    // location handed to a resolver, not a file that could have been renamed.
    expect(
      scan(
        'readFileSync(__filename);\n' +
          "const nested = join(__dirname, '..', '..', '..', 'examples', 'no-such-plugin');\n" +
          'hostWorkspaceRootFor(nested);\n',
      ),
    ).toEqual([]);
  });

  it('pins an extensionless file that does exist', () => {
    expect(
      scan(
        'readFileSync(__filename);\n' +
          "const hook = join(__dirname, '..', '..', '..', '.githooks', 'commit-msg');\n" +
          'readFileSync(hook);\n',
      ),
    ).toEqual(['.githooks/commit-msg']);
  });

  it('ignores a file that never reads by path', () => {
    expect(
      scanPathReadPins({
        root: ROOT,
        testFiles: ['src-ui/src/__tests__/x.test.ts'],
        readSource: () => "import App from '../App';\nrender(<App />);\n",
      }),
    ).toEqual([]);
  });

  it('does not pin a generated or gitignored path', () => {
    // A pin is reported whether or not its target exists, so a resolved path
    // under a generated root would pass for whoever built it and red the
    // existence gate on a clean checkout — with a message telling the reader
    // to chase a rename that never happened.
    const generated = [
      "readFileSync(join(__dirname, '..', '..', '..', 'dist-ui', 'index.html'));",
      "readFileSync(join(__dirname, '..', '..', '..', 'dist-server-nightly', 'x.mjs'));",
      "readFileSync(join(__dirname, '..', '..', '..', 'src-desktop', 'gen', 'schemas', 'd.json'));",
      "readFileSync(join(__dirname, '..', '..', '..', '.kontourai', 'verification-output', 'x.json'));",
      "readFileSync(join(__dirname, '..', '..', '..', 'playwright-report', 'index.html'));",
      "readFileSync(join(__dirname, '..', '..', '..', 'packages', 'basis-pane', 'src', 'app.generated.ts'));",
      "readFileSync(join(__dirname, '..', '..', '..', '.station-dependency-install', 'x.json'));",
    ];
    for (const source of generated) expect(scan(source), source).toEqual([]);
    // False-positive controls. `.gitignore` generates only
    // `packages/basis-pane/src/*.generated.ts` and only `src-desktop/gen/
    // schemas/`; widening either drops TRACKED files, and a dropped pin loses
    // its edge and its existence check together, silently.
    expect(scan("readFileSync(join(__dirname, '..', 'App.tsx'));")).toEqual([
      'src-ui/src/App.tsx',
    ]);
    expect(
      scan(
        "readFileSync(join(__dirname, '..', '..', '..', 'packages', 'shared', 'src', 'channel-ports.generated.ts'));",
      ),
    ).toEqual(['packages/shared/src/channel-ports.generated.ts']);
    expect(
      scan(
        "readFileSync(join(__dirname, '..', '..', '..', 'src-desktop', 'gen', 'android', 'app', 'build.gradle.kts'));",
      ),
    ).toEqual(['src-desktop/gen/android/app/build.gradle.kts']);
  });

  it('does not pin a fixture or the pinning file itself', () => {
    expect(
      scan(
        "readFileSync(join(__dirname, 'fixtures', 'sample.ts'), 'utf8');\n" +
          'readFileSync(__filename);\n',
      ),
    ).toEqual([]);
  });
});
