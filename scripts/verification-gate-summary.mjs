#!/usr/bin/env node
/**
 * Renders the completion gate's own machine-readable verdict into the two
 * places a GitHub reader actually looks: the run's Summary tab and the
 * annotations rail.
 *
 * `scripts/run-verification.mjs` already ends a run by printing one bounded
 * JSON document naming the terminal status, the counts, and -- on a non-pass
 * -- the causal excerpts that name the failing check. Nothing consumed it.
 * `.github/workflows/full-regression.yml` ran the gate and let that document
 * scroll past in the raw log, so `gh run view --log-failed` and the Summary
 * tab both showed only "Process completed with exit code 1" and the excerpt
 * survived only inside the uploaded artifact (station#1459).
 *
 * Three properties this script holds to, because it runs on the evidence path
 * of a gate whose whole job is telling the truth about a run:
 *
 *  - It NEVER decides the verdict. The gate step's own exit status already
 *    failed (or passed) the job before this runs; this process always exits 0
 *    so a reporting problem here can neither turn a red run green nor a green
 *    run red.
 *  - It never throws on malformed, truncated, or absent input. Whatever it
 *    could not read or parse is stated in the summary rather than swallowed,
 *    because a silent empty section reads exactly like a clean run.
 *  - It reports only what the captured document says. No field is synthesised
 *    from another, and an absent field is absent from the summary.
 */
import {
  appendFileSync,
  closeSync,
  fstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * The gate's JSON verdict is the LAST document on stdout and is itself bounded
 * to 8 KiB (`CONTROL_OUTPUT_CAP` in run-verification.mjs). A full-regression
 * log is tens of megabytes of test output, essentially all of it before that
 * document, so only the tail is read: bounded memory, and the bound cannot
 * clip the document it exists to find.
 */
const MAX_INPUT_TAIL_BYTES = 1024 * 1024;
/** One annotation per distinct failing check; a rail of hundreds is unread. */
const MAX_ANNOTATIONS = 20;
/** GitHub renders long annotation bodies poorly; the summary keeps the rest. */
const MAX_ANNOTATION_CHARS = 800;
const MAX_TAIL_CHARS = 4000;

export function parseArguments(argv) {
  const options = { stdoutFile: null, summaryFile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--stdout-file')
      options.stdoutFile = argv[++index] ?? null;
    else if (argument === '--summary-file')
      options.summaryFile = argv[++index] ?? null;
  }
  return options;
}

/** Reads at most the trailing `MAX_INPUT_TAIL_BYTES` of a file. */
function readTail(path) {
  const descriptor = openSync(path, 'r');
  try {
    const { size } = fstatSync(descriptor);
    const length = Math.min(size, MAX_INPUT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    // A tail slice can begin mid-codepoint; `toString` yields one replacement
    // character there, which affects nothing downstream (the JSON document is
    // whole and far from the cut).
    return buffer.toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Index of the `}` closing the object that opens at `start`, or -1 when the
 * text holds no balanced object from there. String literals and their escapes
 * are respected so a brace inside a message cannot unbalance the scan.
 */
function matchingBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * The last top-level JSON object in `text`, or null.
 *
 * Only a `{` at the start of a line is a candidate: `run-verification.mjs`
 * renders with `JSON.stringify(value, null, 2)`, so every nested object opens
 * indented and only the document itself opens at column zero. npm's `> pkg@ver
 * script` banners and the whole test log precede it and parse as nothing.
 */
export function lastJsonDocument(text) {
  const starts = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '{') continue;
    const previous = index === 0 ? '\n' : text[index - 1];
    if (previous === '\n' || previous === '\r') starts.push(index);
  }
  for (let candidate = starts.length - 1; candidate >= 0; candidate -= 1) {
    const start = starts[candidate];
    const end = matchingBrace(text, start);
    if (end < 0) continue;
    let value;
    try {
      value = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value;
  }
  return null;
}

/** ANSI SGR/CSI sequences and C0 controls, which corrupt both renderings. */
const CONTROL_SEQUENCES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing terminal control bytes is exactly the job.
  /\u001B\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function plainText(value) {
  return String(value ?? '').replace(CONTROL_SEQUENCES, '');
}

/**
 * A GitHub workflow command is one line: an unescaped newline would end the
 * annotation and leave the remainder to be interpreted as further output, so
 * newlines, carriage returns and `%` are percent-encoded exactly as GitHub
 * documents. The result is one line whatever the excerpt contained.
 */
export function annotationMessage(value) {
  const text = plainText(value)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
  return text.length > MAX_ANNOTATION_CHARS
    ? `${text.slice(0, MAX_ANNOTATION_CHARS)}…`
    : text;
}

/** A fence long enough that the fenced content cannot terminate it early. */
function fencedBlock(content) {
  const longestRun = Math.max(
    0,
    ...[...String(content).matchAll(/`+/g)].map(([run]) => run.length),
  );
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${content}\n${fence}`;
}

function terminalStatus(summary) {
  const terminal = summary?.terminal;
  if (typeof terminal === 'string') return terminal;
  if (
    terminal &&
    typeof terminal === 'object' &&
    typeof terminal.status === 'string'
  )
    return terminal.status;
  return null;
}

/**
 * The verdict is READ, never derived: `passed` is the boolean
 * `boundedControlResult` stamps from the receipt's own terminal. When the
 * document does not carry it, this returns null and the summary says the
 * verdict was not stated rather than guessing one from the status string.
 */
export function verdictOf(summary) {
  if (typeof summary?.passed === 'boolean') return summary.passed;
  return null;
}

export function causalExcerptsOf(summary) {
  const excerpts = Array.isArray(summary?.causalExcerpts)
    ? summary.causalExcerpts.filter((entry) => typeof entry === 'string')
    : [];
  if (excerpts.length) return excerpts.slice(0, MAX_ANNOTATIONS);
  return typeof summary?.firstCausalExcerpt === 'string'
    ? [summary.firstCausalExcerpt]
    : [];
}

function countsTable(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts))
    return null;
  const rows = Object.entries(counts)
    .filter(
      ([, value]) => typeof value === 'number' || typeof value === 'string',
    )
    .map(([key, value]) => `| ${key} | ${value} |`);
  if (!rows.length) return null;
  return ['| count | value |', '| --- | --- |', ...rows].join('\n');
}

function bulletList(values, cap) {
  return values
    .slice(0, cap)
    .map((value) => `- ${plainText(value)}`)
    .join('\n');
}

/**
 * The whole rendering, as a string, so the tests can assert on it directly and
 * the process boundary stays a thin `appendFileSync`.
 */
export function renderSummary({ document, unparseableReason, sourcePath }) {
  const lines = ['## Hosted full regression — completion gate', ''];
  if (!document) {
    lines.push(
      `The gate's captured stdout was unparseable: ${unparseableReason ?? 'no JSON verdict document was found'}.`,
      '',
      `Nothing here changes the gate's verdict — the gate step's own exit status did that. Read the raw step log${sourcePath ? ` and \`${sourcePath}\`` : ''}, or the uploaded \`full-regression-*\` artifact, for the real output.`,
      '',
    );
    return lines.join('\n');
  }
  const summary = document.summary ?? {};
  const verdict = verdictOf(summary);
  const status = terminalStatus(summary);
  const verdictText =
    verdict === true
      ? '✅ passed'
      : verdict === false
        ? '❌ did not pass'
        : '⚠️ verdict not stated in the captured document';
  lines.push(`**Verdict:** ${verdictText}`, '');
  const facts = [];
  if (status) facts.push(`- Terminal status: \`${plainText(status)}\``);
  if (typeof document.disposition === 'string')
    facts.push(`- Disposition: \`${plainText(document.disposition)}\``);
  if (typeof summary.failingStep === 'string')
    facts.push(`- Failing step: \`${plainText(summary.failingStep)}\``);
  if (typeof summary.inFlightStep === 'string')
    facts.push(`- In-flight step: \`${plainText(summary.inFlightStep)}\``);
  if (summary.indeterminate === true) facts.push('- Indeterminate: `true`');
  if (document.truncated === true)
    facts.push(
      '- The captured verdict document was truncated by its own byte cap.',
    );
  if (facts.length) lines.push(...facts, '');
  const counts = countsTable(summary.counts);
  if (counts) lines.push(counts, '');
  const excerpts = causalExcerptsOf(summary);
  if (excerpts.length) {
    lines.push('### Causal excerpts', '');
    lines.push(
      fencedBlock(excerpts.map((entry) => plainText(entry)).join('\n')),
      '',
    );
  }
  if (
    Array.isArray(summary.failedCheckTestFiles) &&
    summary.failedCheckTestFiles.length
  ) {
    lines.push(
      '### Failing test files',
      '',
      bulletList(summary.failedCheckTestFiles, MAX_ANNOTATIONS),
      '',
    );
  }
  if (Array.isArray(summary.slowItems) && summary.slowItems.length) {
    lines.push(
      '### Slowest observed items',
      '',
      bulletList(summary.slowItems, 10),
      '',
    );
  }
  if (typeof summary.finalTally === 'string')
    lines.push(
      '### Final tally',
      '',
      fencedBlock(plainText(summary.finalTally)),
      '',
    );
  if (typeof summary.failedCheckRedactedStdoutTail === 'string') {
    const tail = plainText(summary.failedCheckRedactedStdoutTail).slice(
      -MAX_TAIL_CHARS,
    );
    lines.push(
      '<details><summary>Redacted stdout tail</summary>',
      '',
      fencedBlock(tail),
      '',
      '</details>',
      '',
    );
  }
  const requestKey =
    typeof document.request?.key === 'string' ? document.request.key : null;
  lines.push(
    '### Full evidence',
    '',
    `The complete redacted capture is in the run's \`full-regression-*\` artifact under \`.kontourai/verification-output/${requestKey ?? '<request-key>'}/\`, alongside \`.kontourai/verification-receipts/\`.`,
    '',
  );
  return lines.join('\n');
}

export function annotationsFor(document) {
  if (!document) return [];
  const summary = document.summary ?? {};
  if (verdictOf(summary) !== false) return [];
  const excerpts = causalExcerptsOf(summary);
  if (excerpts.length)
    return excerpts.map(
      (excerpt) =>
        `::error title=full-regression::${annotationMessage(excerpt)}`,
    );
  // A non-pass with no excerpt still gets exactly one annotation: silence
  // here is what sent readers to the artifact in the first place.
  const status = terminalStatus(summary) ?? 'non-passing';
  const step =
    typeof summary.failingStep === 'string'
      ? ` in \`${summary.failingStep}\``
      : '';
  return [
    `::error title=full-regression::${annotationMessage(`the completion gate reported ${status}${step} with no causal excerpt; read the full-regression artifact`)}`,
  ];
}

export function main(argv, { log = console.log, warn = console.error } = {}) {
  const options = parseArguments(argv);
  const summaryFile =
    options.summaryFile ?? process.env.GITHUB_STEP_SUMMARY ?? null;
  let document = null;
  let unparseableReason = null;
  if (!options.stdoutFile) unparseableReason = 'no --stdout-file was given';
  else {
    let captured = null;
    try {
      captured = readTail(options.stdoutFile);
    } catch (error) {
      unparseableReason = `the captured stdout at ${options.stdoutFile} could not be read (${error?.code ?? error?.message ?? 'unknown error'})`;
    }
    if (captured !== null) {
      document = lastJsonDocument(captured);
      if (!document)
        unparseableReason = `no JSON verdict document was found in ${options.stdoutFile}`;
    }
  }
  const rendered = renderSummary({
    document,
    unparseableReason,
    sourcePath: options.stdoutFile,
  });
  if (summaryFile) {
    try {
      appendFileSync(summaryFile, `${rendered}\n`);
    } catch (error) {
      warn(
        `[verification-gate-summary] could not write ${summaryFile}: ${error?.message ?? error}`,
      );
    }
  } else {
    warn(
      '[verification-gate-summary] no --summary-file and no GITHUB_STEP_SUMMARY; summary not written',
    );
  }
  if (!document)
    log(
      `::warning title=full-regression::${annotationMessage(unparseableReason ?? 'the gate verdict could not be parsed')}`,
    );
  for (const annotation of annotationsFor(document)) log(annotation);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // Never mask the gate: any failure inside this reporter is reported and the
  // process still exits 0, because the gate step's own status is the verdict.
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`[verification-gate-summary] ${error?.stack ?? error}`);
    process.exitCode = 0;
  }
}
