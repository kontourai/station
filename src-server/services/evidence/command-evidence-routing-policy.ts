/**
 * Command-evidence routing policy (roadmap S1a slice 3).
 *
 * Decides whether an already-run command (captured from a tool call) should
 * become flow gate evidence, and if so, which gate and claim type it satisfies.
 * The policy is deliberately conservative: it only routes commands run through
 * a known command/shell tool, whose command line matches a known claim pattern
 * (test/typecheck/lint/build), AND for which an open gate actually expects that
 * claim type. Anything else is ignored so the spool never produces noise.
 */

import type { FlowDefinition } from '@kontourai/flow';

/**
 * A command captured from a completed tool call, awaiting routing.
 *
 * Station OBSERVED this command; it did not run it (the connected/ACP agent
 * owns tool dispatch). `status` is the runtime's own outcome and the only
 * execution fact reported back, so `exitCode` and `durationMs` are null
 * whenever nothing measured them (archive#4237).
 */
export interface SpooledCommand {
  toolName: string;
  toolCallId: string;
  command: string;
  output: string;
  /** The observing runtime's outcome for the tool call. */
  status: 'success' | 'error' | 'cancelled';
  /** Null unless the runtime reported a real process exit code. */
  exitCode: number | null;
  timedOut: boolean;
  /** Wall-clock duration, or null when nothing measured one. */
  durationMs: number | null;
  outputTruncated: boolean;
}

/** Where a spooled command's evidence should be attached. */
export interface CommandEvidenceRoute {
  gateId: string;
  claimType: string;
  label: string;
}

export interface CommandEvidenceRoutingContext {
  definition: FlowDefinition;
  openGates: Array<{ id: string; step: string }>;
}

export interface CommandEvidenceRoutingPolicy {
  route(
    cmd: SpooledCommand,
    ctx: CommandEvidenceRoutingContext,
  ): CommandEvidenceRoute | null;
  /**
   * Every claim type this policy can produce from a command line. Optional so
   * out-of-tree policies keep compiling. The unreachable-gate diagnostic
   * emits a fixed `reachability-not-evaluable` warning when this capability
   * is absent or cannot safely produce its synchronous inventory.
   */
  routableClaimTypes?(): string[];
}

/** A command-line pattern that maps to a flow claim type. */
export interface CommandClaimPattern {
  pattern: RegExp;
  /**
   * When set, a command matching this never routes to `claimType` even if
   * `pattern` matched. Kept separate from `pattern` because the exclusions
   * are about the command's SCOPE (a partial run, a file being read rather
   * than executed), which reads as noise when folded into one regex.
   *
   * Exclusion is per-pattern, not global: a command excluded here FALLS
   * THROUGH to the remaining patterns and may match a lower one. That is
   * deliberate — `veritas readiness --check test && npm test` is not
   * merge-readiness evidence, but it did run tests, so routing it to
   * `quality.tests` off the trailing `npm test` is the honest outcome rather
   * than dropping it. Only add an exclusion when the lower matches would
   * also be acceptable for that command.
   */
  excludes?: RegExp;
  claimType: string;
}

/** Tool names (case-insensitive) that run a shell command line. */
const DEFAULT_COMMAND_TOOL_NAMES = [
  'Bash',
  'bash',
  'shell',
  'execute_command',
  'run_command',
  'run_terminal_cmd',
  'exec',
];

/**
 * Anchors a claim pattern to the LEADING word of an actual invocation,
 * rather than any mention of the word anywhere in the command line — a
 * STRICTER discipline than the verification pattern below (which only
 * excludes a leading search-tool word via `excludes`, archive#189); this one
 * requires the verb to sit in leading position via a positive anchor, so the
 * generic patterns need no bolt-on exclusion list (archive#1433 round-3
 * ruling). A command is only "leading" when it opens the string or a line
 * (optionally after indentation), or starts a new segment after a single
 * shell chain-operator character (`&`, `;`, `|`), optionally preceded by
 * env-var assignments (`CI=true npm test`).
 *
 * The chain-operator class is intentionally NOT quantified (`[&;|]`, not
 * `[&;|]+`): `.test()` tries a match at every character offset in the
 * string, and a `+`-quantified char class here backtracks once per offset
 * inside every run of operator characters, making a crafted input like
 * `'&;|'.repeat(6000)` quadratic — a synchronous 10s+ stall on a single
 * `route()` call (archive#1433 HIGH-1, probe-confirmed). A lone `[&;|]`
 * still matches `&&`/`||` correctly: `.test()` finds the match starting at
 * the SECOND operator character just as well as the first, with no
 * quantifier to backtrack.
 *
 * Every quantified whitespace gap between tokens in this module uses `WS`
 * (`[ \t]`, horizontal whitespace only) rather than `\s` (which also
 * matches `\n`). This is not cosmetic: once the `m` flag (below) makes `^`
 * match after every newline, an unbounded `\s*`/`\s+` run that CAN cross
 * newlines re-creates HIGH-1 one level up — a string of many blank lines
 * followed by real content gives the engine one valid line-start anchor per
 * newline, and at EACH of those positions a greedy-then-backtracking
 * `\s*` re-scans the entire remaining run of newlines before failing or
 * succeeding, which is quadratic in the newline count (probe-confirmed:
 * `'\n'.repeat(n) + 'npm test'` went from 27ms at n=6000 to 2.9s at
 * n=48000, roughly 4x per doubling). `[ \t]*` cannot cross a newline, so at
 * a blank-line position it matches zero characters — nothing to
 * backtrack — collapsing the per-position cost back to O(1). Newlines only
 * ever participate as line boundaries via `^`, never as fill the engine
 * has to search across.
 */
const WS = String.raw`[ \t]`;
const CHAIN_START = `(?:^${WS}*|[&;|]${WS}*)`;
const ENV_PREFIX = String.raw`(?:[A-Za-z_]\w*=\S+${WS}+)*`;

/**
 * A package/tool-runner token (`npx`, `npm run`, `yarn`, `pnpm`, `bun`, plus
 * the non-JS runners `poetry run` / `uv run`) and the whitespace before the
 * verb. Two variants:
 *
 * - OPTIONAL: for verbs that are themselves real, unambiguous binaries
 *   (`vitest`, `jest`, `pytest`, `tsc`, `biome`, `eslint`, `vite`) — these
 *   route whether invoked directly or through a runner.
 * - REQUIRED: for verbs that are npm-script *names*, not binaries (`test`,
 *   `typecheck`, `lint`, `build`, `compile`) — bare `test` alone is a POSIX
 *   shell builtin (`test -f file`), not a test run, so these only route when
 *   an actual runner token precedes them.
 */
const RUNNER_TOKEN = `(?:npx|npm(?:${WS}+exec|${WS}+run)?|yarn(?:${WS}+run)?|pnpm(?:${WS}+run|${WS}+exec)?|bunx|bun(?:${WS}+run)?|poetry${WS}+run|uv${WS}+run)`;

/**
 * npm's documented `--` argument separator (`npm run <script> -- <args>`,
 * `npm exec -- <bin> <args>`) sits between the runner token and the verb on
 * a real invocation — including the VERBATIM body of this repo's own
 * `veritas:shadow`/`veritas:readiness` scripts (`npm exec -- veritas
 * readiness --working-tree`, package.json). Without accounting for it, an
 * agent that ran that exact command line (rather than the `npm run
 * veritas:shadow` alias) produced governance.merge-readiness NO-ROUTE —
 * found in archive#1451 review. Optional (most invocations have no separator), a
 * single bounded `WS+` after the fixed two-character literal — no new
 * backtracking surface next to `ENV_PREFIX`/`RUNNER_TOKEN` above.
 */
const SEP = `(?:--${WS}+)?`;
const ANCHOR_OPTIONAL = `${CHAIN_START}${ENV_PREFIX}(?:${RUNNER_TOKEN}${WS}+${SEP})?`;
const ANCHOR_REQUIRED = `${CHAIN_START}${ENV_PREFIX}${RUNNER_TOKEN}${WS}+${SEP}`;

/**
 * Builds a claim pattern from an optional-runner branch and a
 * required-runner branch. The `m` flag makes `^` in `CHAIN_START` match
 * after every newline, not just string-start, so a multi-line command
 * (heredocs, `&&`-free multi-statement scripts) routes off any line, not
 * only the first.
 *
 * The trailing lookahead accepts whitespace, end-of-string/line, OR a chain
 * operator directly abutting the verb (`npm test;` with no space before the
 * `;`, as in `if npm test; then …`) — without it, a verb immediately
 * followed by `;`/`&`/`|` failed to match at all.
 */
const VERB_END = String.raw`(?=\s|$|[&;|])`;

function invocationPattern(
  optionalRunnerVerbs: string,
  requiredRunnerVerbs?: string,
): RegExp {
  const branches = [`${ANCHOR_OPTIONAL}(?:${optionalRunnerVerbs})${VERB_END}`];
  if (requiredRunnerVerbs) {
    branches.push(`${ANCHOR_REQUIRED}(?:${requiredRunnerVerbs})${VERB_END}`);
  }
  return new RegExp(branches.join('|'), 'im');
}

/**
 * Flags that make an otherwise-matching invocation a no-op rather than a
 * real run: `--help`/`--version` print and exit, `--dry-run` performs no
 * work, `--init` scaffolds instead of checking, `--list`/`--listTests`
 * enumerate without executing, and `--explain` — the repo's own
 * `test:changed --explain` is documented (AGENTS.md) as emitting only an
 * explanation, "not a lane" — so none of these are execution evidence even
 * though the command line contains a real execution verb (archive#1433
 * MEDIUM-1). Shared across the four generic patterns via `NO_OP_EXCLUDE`.
 *
 * `--list(?:Tests)?` is terminated with `(?=\s|$|=)`, not `\b`: a bare `\b`
 * matches at the word/hyphen boundary too, so `--list-different` (a real
 * prettier flag, nothing to do with listing tests) was tripping the
 * exclude off its `--list` prefix alone (archive#1433 NEW-4 boundary,
 * round-3 review). The lookahead requires the flag to actually END there
 * (whitespace, end of string, or `=value`), so a hyphen-continuation like
 * `-different` correctly fails to match.
 */
const NO_OP_INVOCATION_FLAGS = String.raw`--help\b|--version\b|--dry-run\b|--init\b|--list(?:Tests)?(?=\s|$|=)|--explain\b`;
const NO_OP_EXCLUDE = new RegExp(NO_OP_INVOCATION_FLAGS, 'i');

/**
 * Bounded gap between `tsc` and a `-b`/`--build` flag that can appear
 * anywhere in the invocation (`tsc -p tsconfig.json --build`), used by both
 * the `quality.typecheck` exclude and the `build.success` pattern below.
 *
 * BOUNDED, not `[^&;|]*`: an unquantified negated class here re-creates a
 * form of HIGH-1 one level down — a crafted command repeating `tsc ` many
 * times with no `-b`/`--build` anywhere (`'tsc x '.repeat(8000)`, no chain
 * operators to bound the scan) forces a full backtrack-to-end-of-string on
 * EVERY occurrence, which is quadratic in the number of occurrences
 * (probe-confirmed: 48000 chars already exceeded 250ms, ~4x cost per
 * doubling). 120 characters comfortably covers realistic tsc flag lists
 * (`-p tsconfig.json --build`, `--project ./packages/x/tsconfig.json -b`)
 * while keeping the worst-case backtrack a fixed constant, independent of
 * the surrounding string's length.
 */
const TSC_BUILD_FLAG_GAP = '[^&;|]{0,120}';

/**
 * `run-e2e-suite` (archive#1451) is neither an npm-script name nor an
 * installed binary — it is a plain node script invoked as `node
 * scripts/run-e2e-suite.mjs …` (see every `test:e2e:*` entry in
 * package.json) — so it fits neither `ANCHOR_OPTIONAL`'s runner-token
 * branch nor `ANCHOR_REQUIRED`'s npm-run-only branch. This anchors
 * specifically to a leading `node <path>` invocation, with a BOUNDED
 * negated-class gap for the path segment before the literal — same
 * discipline as `TSC_BUILD_FLAG_GAP` above, not `[^\s&;|]*`: an unbounded
 * negated class here would re-create HIGH-1's backtrack-to-end cost on a
 * crafted `node <120+ non-matching chars>` line repeated many times. A path
 * longer than the bound (120 chars comfortably covers `scripts/run-e2e-suite.mjs`)
 * fails to route rather than searching further — the same accepted,
 * narrower-than-every-shape scope `TSC_BUILD_FLAG_GAP` and
 * `stripConditionalWrapper`'s wrapper-form list already take.
 */
const NODE_SCRIPT_PATH_GAP = '[^\\s&;|]{0,120}';
const NODE_SCRIPT_ANCHOR = `${CHAIN_START}${ENV_PREFIX}node${WS}+${NODE_SCRIPT_PATH_GAP}`;

/**
 * `scripts/run-verification.mjs` is the coordinator behind
 * `verify:static`/`verify:local`/`ci:fast`/`verify:e2e:full` (AGENTS.md:
 * "Use `node scripts/run-verification.mjs status` to inspect host
 * capacity/leases") — an agent that invokes it directly with the same
 * `request <lane>` form the npm scripts use is running the real lane, so it
 * deserves the same coverage `NODE_SCRIPT_ANCHOR` gives `run-e2e-suite`
 * (archive#1451 follow-up). The literal `request` is REQUIRED before the
 * lane name: `node scripts/run-verification.mjs status` only inspects
 * leases — a query, not a run — and must not route, so `status` (or any
 * other subcommand) is excluded by construction rather than by an
 * exclude-list entry. Built from the same audited `NODE_SCRIPT_ANCHOR`
 * prefix — no new quantified construct beyond its already-bounded path gap
 * and the plain `WS+` gaps around the two new fixed literals
 * (`run-verification\.mjs`, `request`).
 */
const RUN_VERIFICATION_REQUEST_ANCHOR = `${NODE_SCRIPT_ANCHOR}run-verification\\.mjs${WS}+request${WS}+`;

/**
 * Strips a leading `if <cmd>; then …` — optionally wrapped in a `(`
 * subshell — before pattern matching, so the repo's own mandated sentinel
 * idiom (`if <cmd>; then echo OK; else echo FAIL; fi`) is recognized as
 * running `<cmd>` rather than an unrecognized shell conditional
 * (archive#1433 MEDIUM-2). A plain linear string strip rather than an
 * addition to `CHAIN_START` itself: teaching the anchor to understand `if`
 * would add a second backtracking-prone construct next to the exact one
 * HIGH-1 just removed. Only the matching view is stripped — `route()`
 * still labels the route with the original, unstripped command.
 *
 * Other wrapper forms (`bash -lc "npm test"`, `ssh host "npm test"`, `time
 * npm test`, `env FOO=bar npm test` beyond simple `VAR=value` prefixes) are
 * NOT unwrapped. That is an accepted, narrower scope than "matches every
 * shape a real execution can take" — not a bug to chase with more regex.
 *
 * This is called unconditionally on every `route()`, so its own regex is
 * held to the same ReDoS discipline as the anchor above. The FIRST version
 * of this fix used `/^\s*\(?\s*if\s+/i` — two adjacent unbounded `\s*`
 * quantifiers separated only by an optional single character is a textbook
 * catastrophic-backtracking shape: the engine can split a run of n
 * whitespace characters between the two groups in ~n different ways before
 * concluding "if" never appears, and it tried all of them (probe-confirmed:
 * 363ms on a 24000-newline string with no "if", isolated from the rest of
 * `route()`). Merging the whitespace and the optional paren into ONE
 * character class (`[\s(]*`) removes the ambiguous split entirely — a
 * single quantifier's failed backtrack is linear, never polynomial.
 */
function stripConditionalWrapper(command: string): string {
  return command.replace(/^[\s(]*if\s+/i, '');
}

/**
 * Truncates a command at the first newline after a heredoc opening marker
 * (`<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`, …). Without this, the `m`-flag
 * multi-line anchor (archive#1433 MEDIUM-3) treats a heredoc BODY line as
 * its own leading invocation: `cat > run.sh <<'EOF'\nnpm test\nEOF` and the
 * equivalent for a Makefile or doc file both routed `npm test`/similar as
 * passing evidence for a command that only wrote those bytes to a file and
 * never ran them (archive#1433 NEW-1, round-3 review, HIGH). A `<<<`
 * here-string is NOT a heredoc and must keep routing normally
 * (`npm test <<< "input"` is a real, single-line invocation) — the marker
 * regex requires `<<` followed immediately by an optional `-`, an optional
 * quote, then a word character, which a bare `<<<` (no word character in
 * that position) never satisfies.
 *
 * Search-then-indexOf, not a second quantified regex: `/<<-?['"]?\w/` has
 * no nested or adjacent unbounded quantifiers (each of `-?`/`['"]?` is a
 * single optional character), so the initial `.exec()` is a single linear
 * scan; the follow-up `.indexOf()` is a native linear string search. No new
 * backtracking surface next to HIGH-1's (probe-confirmed linear at 96000+
 * chars, including inputs with many `<<`-like substrings).
 */
function stripHeredocBodies(command: string): string {
  const marker = /<<-?['"]?\w/.exec(command);
  if (!marker) return command;
  const newlineIndex = command.indexOf('\n', marker.index);
  return newlineIndex === -1 ? command : command.slice(0, newlineIndex);
}

/**
 * Default command-line → claim-type mapping. First match wins, so the more
 * specific patterns precede the broad ones.
 *
 * The first three entries name the claim types Station's own
 * `.flow/definitions/station-delivery.json` gates expect. Without them the
 * expected set and the producible set were disjoint (archive#189 defect 2):
 * every spooled command routed `no-route`, so no gate could ever be satisfied
 * by evidence Station collected itself. They must stay ahead of the generic
 * patterns because their commands also contain generic words — `npx
 * playwright test` would otherwise route as `quality.tests`, and `npm run
 * test:e2e:extended` would otherwise route as `quality.tests` instead of
 * `quality.verification` — order matters.
 *
 * These three are held to a stricter standard than the generic ones, because
 * a false positive here does not merely misfile evidence — it PASSES a gate.
 * All three are now built with the same leading-command verb anchoring as
 * the generic four (archive#1451; the original versions matched a MENTION
 * anywhere in the string — `echo "run npm run ci:fast first"`, `grep -rn
 * "verify:static" docs/`, `git commit -m "chore: speed up ci:fast"`, `git
 * log --grep "veritas readiness"`, and `echo "npm run test:e2e"` all
 * wrongly routed and PASSED a live gate, probe-proven during archive#1433's
 * independent review):
 *
 * - `quality.static-checks` (`verify:static`/`verify:local`/`ci:fast`) are
 *   npm-script NAMES, not installed binaries — POSIX `test`-builtin-style
 *   ambiguity doesn't apply to colon-named scripts, but there is still no
 *   direct-binary form, so only `ANCHOR_REQUIRED` (an actual runner token:
 *   `npm run`, `yarn run`, …) applies. `verify:local` expands to static
 *   checks, so it routes here rather than to `quality.verification`. Also
 *   routes `node scripts/run-verification.mjs request verify-static` (etc,
 *   `RUN_VERIFICATION_REQUEST_ANCHOR`) — the coordinator these npm scripts
 *   shell out to; an agent invoking it directly is still running the real
 *   lane, while `node scripts/run-verification.mjs status` (a lease/capacity
 *   query, AGENTS.md) is excluded by construction (`request` is a required
 *   literal, not an optional one). `VERB_END` right after the literal also
 *   means a private `:raw`/`:bootstrap` suffix (`verify:static:raw`) does
 *   not satisfy the exact three canonical names — not because AGENTS.md
 *   disallows agents from invoking it (a policy document is not a load-
 *   bearing reason for a regex boundary), but because `:raw` BYPASSES
 *   `run-verification.mjs`'s coordinator (host-wide lease, receipt content-
 *   addressing) entirely, so it is not evidence of the same coordinated
 *   lane the claim represents — an over-claim the exact-boundary anchor
 *   prevents regardless of what policy says about invoking it.
 * - `governance.merge-readiness` (`veritas readiness`) is invoked either as
 *   the direct binary + subcommand (optionally through `npx`/`npm exec`,
 *   `ANCHOR_OPTIONAL`) or via the `veritas:shadow`/`veritas:readiness`/
 *   `veritas:readiness:diff` npm-script aliases (`ANCHOR_REQUIRED`) —
 *   replacing the old unbounded `\bveritas\b.*\breadiness\b` (itself a
 *   latent quadratic-scan risk on a `veritas`-heavy, `readiness`-free input,
 *   never mind the mention-matching bug) with two literal alternations and
 *   no free-floating `.*`. The `--check` exclude (a partial readiness run is
 *   not evidence for the whole tree) is preserved unchanged.
 * - `quality.verification` (`playwright test` / `verify:e2e` / `test:e2e` /
 *   `run-e2e-suite`) keeps its existing verb shape and its existing
 *   search-tool + no-op excludes (`rg`/`grep`/`ack`/`ag`/`cat`/`less`/`head`,
 *   `NO_OP_INVOCATION_FLAGS` — already applied since archive#1433's closing round),
 *   now ALSO anchored via `ANCHOR_OPTIONAL` (`playwright test`, direct or
 *   through `npx`/`npm exec`), `ANCHOR_REQUIRED` (`verify:e2e`/`test:e2e`,
 *   npm-script names), the dedicated `NODE_SCRIPT_ANCHOR` (`run-e2e-suite`,
 *   a plain node script, not an npm-script name or binary — see its comment
 *   above), and `RUN_VERIFICATION_REQUEST_ANCHOR` (`request verify-e2e-full`,
 *   the coordinator behind `verify:e2e:full`). The search-tool exclude list
 *   is now redundant against the anchor for LEADING-position matches, but is
 *   kept exactly as-is (archive#1451 explicitly preserves it) since it still
 *   guards a still-anchored mid-chain segment the anchor alone permits
 *   (`… && grep -rn "playwright test"` starts a new leading segment at
 *   `grep` after the `&&`). This closes the exact gap the anchor alone
 *   doesn't: `echo "npm run test:e2e"`, `sed -n "/test:e2e/p" package.json`,
 *   and `find . -name "*run-e2e-suite*"` all have a non-runner, non-`node`,
 *   non-`playwright` leading command, so none of the anchored branches can
 *   start a match anywhere in the string (no `&`/`;`/`|`/newline segment
 *   boundary ever puts `test:e2e`/`run-e2e-suite` in leading position
 *   either).
 *
 * `NO_OP_EXCLUDE` is applied to `quality.static-checks` (new) and folded
 * into `governance.merge-readiness`'s exclude alongside the pre-existing
 * `--check` (new); `quality.verification` already carried the equivalent
 * flags in its exclude before this change.
 *
 * `SEP` (an optional `--` separator, folded into `ANCHOR_OPTIONAL`/
 * `ANCHOR_REQUIRED` themselves so every pattern built from them gets it for
 * free) covers npm's documented `npm run <script> -- <args>` / `npm exec --
 * <bin> <args>` forms — including the VERBATIM body of this repo's own
 * `veritas:shadow`/`veritas:readiness` scripts (`npm exec -- veritas
 * readiness --working-tree`), which NO-ROUTEd before this fix if an agent
 * ran that literal command instead of the `npm run veritas:shadow` alias
 * (archive#1451 review FN-1).
 *
 * The remaining four entries (`quality.tests`, `quality.typecheck`,
 * `quality.lint`, `build.success`) used to be bare word matches
 * (`\btest\b`, `\bbuild\b`, …), which matched *mentions* rather than
 * *executions*: `rm -rf test-results && npm run build` routed to
 * `quality.tests` off the word inside `test-results`, and `rg playwright
 * test` fell through to `quality.tests` off the bare word `test`
 * (archive#1433). They are now built with `invocationPattern()` above,
 * requiring an execution verb anchored to the leading command of an
 * invocation, so a mention inside another command's arguments, a file name,
 * or a search query never matches. `NO_OP_EXCLUDE` additionally keeps
 * `--help`/`--version`/`--dry-run`/`--init`/`--list*`/`--explain`
 * invocations from routing as if they were real runs.
 */
const DEFAULT_CLAIM_PATTERNS: CommandClaimPattern[] = [
  {
    pattern: new RegExp(
      [
        `${ANCHOR_REQUIRED}(?:verify:static|verify:local|ci:fast)${VERB_END}`,
        `${RUN_VERIFICATION_REQUEST_ANCHOR}(?:verify-static|ci-fast|verify-local)${VERB_END}`,
      ].join('|'),
      'im',
    ),
    excludes: NO_OP_EXCLUDE,
    claimType: 'quality.static-checks',
  },
  {
    pattern: invocationPattern(
      `veritas${WS}+readiness`,
      `veritas:(?:shadow|readiness(?::diff)?)`,
    ),
    excludes: new RegExp(`--check\\b|${NO_OP_INVOCATION_FLAGS}`, 'i'),
    claimType: 'governance.merge-readiness',
  },
  {
    pattern: new RegExp(
      [
        `${ANCHOR_OPTIONAL}playwright${WS}+test${VERB_END}`,
        `${ANCHOR_REQUIRED}(?:verify:e2e|test:e2e)(?::[\\w-]*)?${VERB_END}`,
        `${NODE_SCRIPT_ANCHOR}run-e2e-suite(?:\\.mjs)?${VERB_END}`,
        `${RUN_VERIFICATION_REQUEST_ANCHOR}verify-e2e-full${VERB_END}`,
      ].join('|'),
      'im',
    ),
    // Searching for the command is not running it. Anchored to the LEADING
    // word so only the command actually being invoked is judged: a real run
    // that pipes or redirects (`npx playwright test 2>&1 | tail -50`) still
    // routes, while `rg playwright test` and `grep -rn "playwright test" docs/`
    // do not. `NO_OP_EXCLUDE` additionally covers `npm run test:e2e --help`
    // etc — a real gate expects this claim type live in station-delivery
    // (archive#1433 NEW-4, round-3 review), so a no-op invocation passing it
    // is not a diagnostic curiosity, it is a false-passing gate.
    excludes: new RegExp(
      `^\\s*(rg|grep|ack|ag|cat|less|head)\\b|${NO_OP_INVOCATION_FLAGS}`,
      'i',
    ),
    claimType: 'quality.verification',
  },
  {
    // vitest/jest/pytest/go test/cargo test/deno test are real binaries or
    // complete direct-invocation phrases — direct or runner-prefixed. Bare
    // `test` alone is a shell builtin, not a test run, so it only routes
    // behind an actual npm/yarn/pnpm/bun/poetry/uv runner token.
    pattern: invocationPattern(
      `vitest(?:${WS}+run)?|jest|pytest|python3?${WS}+-m${WS}+pytest|go${WS}+test|cargo${WS}+test|deno${WS}+test`,
      'test(?::[\\w-]*)?',
    ),
    excludes: NO_OP_EXCLUDE,
    claimType: 'quality.tests',
  },
  {
    // `tsc` alone type-checks; `tsc -b`/`tsc --build` emits output and is
    // build evidence instead (falls through to `build.success` below). The
    // exclude scans the rest of the tsc invocation (up to the next chain
    // operator), not just the token immediately after `tsc`, so
    // `tsc -p tsconfig.json --build` still falls through correctly.
    pattern: invocationPattern(
      'tsc',
      'typecheck(?::[\\w-]*)?|type-check(?::[\\w-]*)?',
    ),
    excludes: new RegExp(
      `\\btsc\\b${TSC_BUILD_FLAG_GAP}(?:-b|--build)\\b|${NO_OP_INVOCATION_FLAGS}`,
      'i',
    ),
    claimType: 'quality.typecheck',
  },
  {
    pattern: invocationPattern(
      `biome${WS}+(?:check|lint)|eslint`,
      'lint(?::[\\w-]*)?',
    ),
    excludes: NO_OP_EXCLUDE,
    claimType: 'quality.lint',
  },
  {
    // The tsc branch mirrors quality.typecheck's exclude: a build flag
    // anywhere in the tsc invocation counts, not just immediately after
    // `tsc` (`tsc -p tsconfig.json --build` is a real build invocation).
    pattern: invocationPattern(
      `vite${WS}+build|tsc${WS}+${TSC_BUILD_FLAG_GAP}(?:-b|--build)\\b|cargo${WS}+build|go${WS}+build`,
      'build(?::[\\w-]*)?|compile(?::[\\w-]*)?',
    ),
    excludes: NO_OP_EXCLUDE,
    claimType: 'build.success',
  },
];

export interface DefaultCommandEvidenceRoutingPolicyOptions {
  commandToolNames?: Iterable<string>;
  claimPatterns?: CommandClaimPattern[];
}

/**
 * The built-in routing policy. Configurable command tool names and claim
 * patterns; sensible defaults cover the common test/typecheck/lint/build
 * commands across Bash-style tools.
 */
export class DefaultCommandEvidenceRoutingPolicy
  implements CommandEvidenceRoutingPolicy
{
  private readonly commandToolNames: Set<string>;
  private readonly claimPatterns: CommandClaimPattern[];

  constructor(options: DefaultCommandEvidenceRoutingPolicyOptions = {}) {
    this.commandToolNames = new Set(
      [...(options.commandToolNames ?? DEFAULT_COMMAND_TOOL_NAMES)].map(
        (name) => name.toLowerCase(),
      ),
    );
    this.claimPatterns = options.claimPatterns ?? DEFAULT_CLAIM_PATTERNS;
  }

  /** Deduplicated, definition-order-independent set of producible claims. */
  routableClaimTypes(): string[] {
    return [...new Set(this.claimPatterns.map((entry) => entry.claimType))];
  }

  route(
    cmd: SpooledCommand,
    ctx: CommandEvidenceRoutingContext,
  ): CommandEvidenceRoute | null {
    if (!this.commandToolNames.has(cmd.toolName.toLowerCase())) return null;

    // Matching uses the `if`-stripped, heredoc-truncated view; the returned
    // route's `label` (below) still carries the original command text.
    const matchable = stripHeredocBodies(stripConditionalWrapper(cmd.command));
    const claimType = this.claimPatterns.find(
      (entry) =>
        entry.pattern.test(matchable) && !entry.excludes?.test(matchable),
    )?.claimType;
    if (!claimType) return null;

    const gateId = this.findGateExpecting(ctx, claimType);
    if (!gateId) return null;

    return { gateId, claimType, label: cmd.command };
  }

  /**
   * An OPEN gate whose expectations include a trust.bundle claim of this claim type.
   * Only open gates are considered — attaching to a gate the run has already
   * passed would be noise. Preserves definition order for determinism.
   */
  private findGateExpecting(
    ctx: CommandEvidenceRoutingContext,
    claimType: string,
  ): string | null {
    const openIds = new Set(ctx.openGates.map((gate) => gate.id));
    const candidates = Object.keys(ctx.definition.gates ?? {}).filter(
      (gateId) =>
        openIds.has(gateId) &&
        gateExpectsClaim(ctx.definition, gateId, claimType),
    );
    return candidates[0] ?? null;
  }
}

/**
 * The trust.bundle claim types each gate expects, in definition order. This is
 * the demand side of the routing contract, kept per-gate because a definition
 * can be partly routable: one gate's claims producible, another's not. That
 * partial case is the likelier regression, and a whole-definition set hides it.
 */
export function definitionExpectedClaimTypesByGate(
  definition: FlowDefinition,
): Array<{ gateId: string; claimTypes: string[] }> {
  return Object.entries(definition.gates ?? {}).map(([gateId, gate]) => {
    const claimTypes = new Set<string>();
    for (const expectation of gate?.expects ?? []) {
      if (expectation.kind !== 'trust.bundle') continue;
      const claimType = expectation.bundle_claim?.claimType;
      if (typeof claimType === 'string' && claimType.length > 0) {
        claimTypes.add(claimType);
      }
    }
    return { gateId, claimTypes: [...claimTypes] };
  });
}

/** Every claim type the definition expects, deduplicated across its gates. */
export function definitionExpectedClaimTypes(
  definition: FlowDefinition,
): string[] {
  return [
    ...new Set(
      definitionExpectedClaimTypesByGate(definition).flatMap(
        (gate) => gate.claimTypes,
      ),
    ),
  ];
}

/** True when `gateId` declares a trust.bundle expectation of `claimType`. */
export function gateExpectsClaim(
  definition: FlowDefinition,
  gateId: string,
  claimType: string,
): boolean {
  const gate = definition.gates?.[gateId];
  return (gate?.expects ?? []).some(
    (expectation) =>
      expectation.kind === 'trust.bundle' &&
      expectation.bundle_claim?.claimType === claimType,
  );
}
