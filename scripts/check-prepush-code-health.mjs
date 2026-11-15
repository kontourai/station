#!/usr/bin/env node
/**
 * Pre-push: the code-health gate's unused-export check, while the change is
 * still the author's.
 *
 * `scripts/code-health-gate.mjs` runs in CI's statics job and refuses a pull
 * request that introduces an unused export or type. Over 732 pull-request CI
 * runs (2026-11-13 to 15) that refusal failed 16, each found a CI round trip
 * after the push. This runs the same gate, unchanged, against the same base CI
 * uses (the merge base with `origin/main`), and decides only whether a push
 * can produce such a finding at all.
 *
 * That decision follows how the gate attributes findings, not a file-type
 * guess. The gate runs `fallow audit --changed-since <base> --gate new-only`,
 * and fallow reports dead-code findings only in files changed since the base
 * (checked: removing the last caller of an export in an unchanged file is not
 * reported). So a push can introduce a blocker only through a changed file
 * that (a) fallow analyzes, read from `fallow list --files`, and (b) the
 * repository's `.fallowrc.json` does not exempt from both `unused-exports` and
 * `unused-types` (tests, examples and the published package sources). A path
 * absent from the working tree (deleted, or a hypothetical `gate:for` path) is
 * judged by the extensions fallow analyzes, read from the same list. A push
 * with no such path skips the gate; anything unreadable runs it.
 *
 * Fallow reads the working tree, so the gate can only judge the commit that
 * is checked out. When the hook pushes a different commit, this says so and
 * leaves the check to CI rather than judging the wrong tree. Uncommitted edits
 * to analyzed files are included in the analysis, and this says that too.
 *
 * Measured on a 15-core Mac at load ~8: 24-30 s with fallow's per-worktree
 * cache warm, ~51 s for the first run against a new base (fallow builds a
 * base snapshot then). The hook runs it through a heavy-check slot.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTURE_MAX_BYTES } from './lib/bounded-capture.mjs';
import { changedPathsSince } from './lib/change-scope.mjs';
import { mergeBaseWith } from './lib/git-ref.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const BASE_REF = process.env.STATION_BASE_REF ?? 'origin/main';
const BLOCKER_RULES = Object.freeze(['unused-exports', 'unused-types']);
const SHOWN_BLOCKERS = 20;

/** Is one rule `off` for this path, after fallow's override order? */
function ruleIsOff(path, rule, config) {
  let severity = config?.rules?.[rule];
  for (const override of config?.overrides ?? []) {
    if (!(rule in (override?.rules ?? {}))) continue;
    if ((override.files ?? []).some((glob) => matchesGlob(path, glob)))
      severity = override.rules[rule];
  }
  return severity === 'off';
}

/**
 * The analyzer's own view of which paths can carry an unused-export finding:
 * fallow's file list plus the repository's fallow config. Null when either
 * cannot be read, which the decider treats as "run".
 */
export function readCodeHealthAnalyzer(root = process.cwd()) {
  try {
    const listed = spawnSync(
      process.execPath,
      [
        fileURLToPath(import.meta.resolve('fallow/bin/fallow')),
        'list',
        '--files',
        '--format',
        'json',
        '--quiet',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: CAPTURE_MAX_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (listed.status !== 0) return null;
    const files = JSON.parse(listed.stdout).files;
    if (!Array.isArray(files) || files.length === 0) return null;
    const config = JSON.parse(readFileSync(`${root}/.fallowrc.json`, 'utf8'));
    return {
      files,
      extensions: [...new Set(files.map((file) => extname(file)))].sort(),
      config,
    };
  } catch {
    return null;
  }
}

/**
 * `run: false` only when the analyzer's view was read AND no changed path can
 * carry a blocker. `candidates` names the paths that made it run.
 */
export function decideCodeHealthScope({
  baseSha,
  changedPaths,
  analyzer,
  exists = existsSync,
}) {
  if (!baseSha)
    return {
      run: true,
      candidates: [],
      reason: `${BASE_REF} could not be resolved, so there is no base to compare against`,
    };
  if (!analyzer)
    return {
      run: true,
      candidates: [],
      reason:
        "fallow's file list or .fallowrc.json could not be read; running rather than assuming",
    };
  const analyzed = new Set(analyzer.files);
  const candidates = changedPaths.filter((path) => {
    const inScope = exists(path)
      ? analyzed.has(path)
      : analyzer.extensions.includes(extname(path));
    return (
      inScope &&
      !BLOCKER_RULES.every((rule) => ruleIsOff(path, rule, analyzer.config))
    );
  });
  if (candidates.length === 0)
    return {
      run: false,
      candidates,
      reason: `none of the ${changedPaths.length} changed path(s) is a file fallow can report an unused export or type in`,
    };
  const shown = candidates.slice(0, 3).join(', ');
  return {
    run: true,
    candidates,
    reason: `${candidates.length} changed file(s) can carry an unused export or type: ${shown}${candidates.length > 3 ? `, +${candidates.length - 3} more` : ''}`,
  };
}

function git(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function describeBlocker(blocker) {
  const where = `${blocker.path ?? '?'}${blocker.line ? `:${blocker.line}` : ''}`;
  const kind = blocker.kind === 'unused_types' ? 'type' : 'export';
  return `  ${where}  unused ${kind} ${blocker.export_name ?? blocker.name ?? '?'}`;
}

function main() {
  const head = git(['rev-parse', 'HEAD']);
  const pushed = (process.env.STATION_PREPUSH_PUSHED_SHAS ?? '')
    .split(/\s+/)
    .filter(Boolean);
  if (pushed.length > 0 && !pushed.includes(head)) {
    console.log(
      `Code health: skipped — this push does not include the checked-out commit (${head?.slice(0, 12)}), and the analyzer reads the working tree, so it cannot judge the pushed commit here. CI's statics job runs it.`,
    );
    return 0;
  }
  const baseSha = mergeBaseWith(BASE_REF);
  const decision = decideCodeHealthScope({
    baseSha,
    changedPaths: baseSha ? changedPathsSince(BASE_REF) : [],
    analyzer: readCodeHealthAnalyzer(),
  });
  if (!decision.run) {
    console.log(`Code health: skipped — ${decision.reason}.`);
    return 0;
  }
  if (!baseSha) {
    // The gate needs a base and there is none, so nothing was checked. Say
    // that rather than "clean", and leave the verdict to CI's statics job.
    console.log(
      `Code health: NOT CHECKED — ${decision.reason}; CI's statics job runs it. \`git fetch origin main\` lets the next push check it here.`,
    );
    return 0;
  }
  console.log(`Code health: checking — ${decision.reason}.`);
  const dirty = (
    git(['status', '--porcelain', '--', ...decision.candidates]) ?? ''
  )
    .split('\n')
    .filter(Boolean);
  if (dirty.length > 0)
    console.log(
      `  note: ${dirty.length} of these file(s) have uncommitted edits, and the analyzer reads the working tree, so they are part of this verdict.`,
    );
  const reproduce = `node scripts/code-health-gate.mjs --base=${baseSha}`;
  const result = spawnSync(
    process.execPath,
    ['scripts/code-health-gate.mjs', `--base=${baseSha}`],
    {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: CAPTURE_MAX_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.error) throw result.error;
  if (result.status === 0) {
    console.log('Code health: no new unused export or type.');
    return 0;
  }
  let gate;
  try {
    // The gate prints its result object, then one sentence.
    const text = result.stdout;
    gate = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    gate = null;
  }
  if (result.status === 1 && Array.isArray(gate?.blockers)) {
    const shown = gate.blockers.slice(0, SHOWN_BLOCKERS);
    console.error(
      [
        '',
        `FAIL: this push introduces ${gate.blockers.length} unused export(s) or type(s), so it is refused:`,
        ...shown.map(describeBlocker),
        ...(gate.blockers.length > shown.length
          ? [`  … and ${gate.blockers.length - shown.length} more`]
          : []),
        '',
        'Give each a real caller, stop exporting it, or record the entrypoint or',
        'public-API contract that uses it (scripts/AGENTS.md, code-health',
        "prevention). CI's statics job refuses the same findings. Full report:",
        `  ${gate.report ?? '(not written)'}`,
        'Reproduce with:',
        '',
        `  ${reproduce}`,
        '',
      ].join('\n'),
    );
    return 1;
  }
  process.stderr.write(`${result.stdout}${result.stderr}`);
  console.error(
    `\nFAIL: the code-health gate did not complete (exit ${result.status ?? result.signal}), so this push is refused rather than assumed clean. Reproduce with:\n\n  ${reproduce}\n`,
  );
  return 1;
}

if (invokedDirectly(import.meta.url)) process.exitCode = main();
