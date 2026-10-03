/**
 * CI wiring is a post-merge operational fact, not a comment-level convention.
 * Keep its checks in one place so the proof-family and guardrail entry points
 * cannot silently claim that this workflow evaluates a candidate pull request.
 */
import { existsSync, readFileSync } from 'node:fs';
import { JSON_SCHEMA, load } from 'js-yaml';
import { FAST_CHECKS_PART_JOBS } from './lib/fast-checks-shards.mjs';

/**
 * This is intentionally a canonical YAML subset, not a general YAML parser.
 * A governed workflow must declare an unquoted top-level `on` mapping. Push,
 * pull-request, and merge-group branch filters are parsed separately so each
 * of those triggers is checked against main. Scalar, sequence, inline-event,
 * quoted-key, duplicate-key, and unknown-filter forms fail closed. Every
 * top-level semantic `on` spelling is counted before the canonical declaration
 * is admitted, so a duplicate cannot override it.
 */
function workflowTriggerDeclaration(workflowText) {
  const lines = workflowText.split('\n');
  const invalid = (triggers = new Set()) => ({
    valid: false,
    triggers,
    pushIncludesMain: false,
    pullRequestIncludesMain: false,
    pullRequestTargetTypes: null,
    mergeGroupIncludesMain: false,
    mergeGroupTypes: null,
  });
  const declarationIndices = lines.flatMap((line, index) =>
    /^(?:on|"on"|'on')\s*:\s*.*$/.test(line) ? [index] : [],
  );
  if (declarationIndices.length !== 1) return invalid();
  const [declarationIndex] = declarationIndices;
  if (!/^on\s*:\s*(?:#.*)?$/.test(lines[declarationIndex])) {
    return invalid();
  }

  const triggers = new Set();
  let triggerIndent = null;
  let activeTrigger = null;
  let filterIndent = null;
  let activeFilter = null;
  const branchesByTrigger = new Map();
  const typesByTrigger = new Map();

  for (const line of lines.slice(declarationIndex + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.search(/\S/);
    if (indent === 0) break;
    if (triggerIndent === null) triggerIndent = indent;
    if (indent < triggerIndent) return invalid(triggers);

    if (indent === triggerIndent) {
      const event = line
        .trim()
        .match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*(?:#.*)?$/);
      if (!event) return invalid(triggers);
      const [, name, value] = event;
      if (
        name === 'push' ||
        name === 'pull_request' ||
        name === 'pull_request_target' ||
        name === 'merge_group'
      ) {
        if (value) return invalid(triggers);
        activeTrigger = name;
        branchesByTrigger.set(name, null);
        typesByTrigger.set(name, null);
      } else if (name === 'workflow_dispatch') {
        if (value && value !== '{}') return invalid(triggers);
        activeTrigger = 'workflow_dispatch';
      } else {
        return invalid(triggers);
      }
      if (triggers.has(name)) return invalid(triggers);
      triggers.add(name);
      filterIndent = null;
      activeFilter = null;
      continue;
    }

    if (
      activeTrigger !== 'push' &&
      activeTrigger !== 'pull_request' &&
      activeTrigger !== 'pull_request_target' &&
      activeTrigger !== 'merge_group'
    ) {
      return invalid(triggers);
    }
    if (filterIndent !== null && indent === filterIndent) {
      filterIndent = null;
      activeFilter = null;
    }
    if (filterIndent === null) {
      const filterMapping = line
        .trim()
        .match(/^(branches|types):\s*(\[[^[]*\]|[A-Za-z0-9_-]+)?\s*(?:#.*)?$/);
      if (!filterMapping) return invalid(triggers);
      const [, filter, value] = filterMapping;
      if (
        filter === 'types' &&
        activeTrigger !== 'pull_request_target' &&
        activeTrigger !== 'merge_group'
      )
        return invalid(triggers);
      filterIndent = indent;
      activeFilter = filter;
      const target = filter === 'branches' ? branchesByTrigger : typesByTrigger;
      if (target.get(activeTrigger) !== null) return invalid(triggers);
      if (!value) {
        target.set(activeTrigger, []);
        continue;
      }
      const values = value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (!values.every((entry) => /^[A-Za-z0-9_-]+$/.test(entry))) {
        return invalid(triggers);
      }
      target.set(activeTrigger, values);
      continue;
    }
    if (indent <= filterIndent) return invalid(triggers);
    const entry = line.trim().match(/^-\s+([A-Za-z0-9_-]+)\s*(?:#.*)?$/);
    if (!entry) return invalid(triggers);
    (activeFilter === 'branches' ? branchesByTrigger : typesByTrigger)
      .get(activeTrigger)
      .push(entry[1]);
  }

  const includesOnlyMain = (trigger) => {
    const branches = branchesByTrigger.get(trigger);
    return branches?.length === 1 && branches[0] === 'main';
  };

  return {
    valid:
      triggerIndent !== null &&
      [...branchesByTrigger.values()].every((branches) => branches !== null),
    triggers,
    pushIncludesMain: includesOnlyMain('push'),
    pullRequestIncludesMain: includesOnlyMain('pull_request'),
    pullRequestTargetIncludesMain: includesOnlyMain('pull_request_target'),
    pullRequestTargetTypes: typesByTrigger.get('pull_request_target'),
    mergeGroupIncludesMain: includesOnlyMain('merge_group'),
    mergeGroupTypes: typesByTrigger.get('merge_group'),
  };
}

export function collectPrimaryCiWorkflowTriggerFindings(workflowText) {
  const {
    valid,
    triggers,
    pushIncludesMain,
    pullRequestIncludesMain,
    pullRequestTargetIncludesMain,
    pullRequestTargetTypes,
    mergeGroupIncludesMain,
    mergeGroupTypes,
  } = workflowTriggerDeclaration(workflowText);
  const findings = [];
  if (!valid) {
    findings.push(
      'Primary CI workflow must declare supported top-level triggers.',
    );
    return findings;
  }
  if (!triggers.has('push') || !pushIncludesMain) {
    findings.push('Primary CI workflow must trigger on pushes to main.');
  }
  if (
    (!triggers.has('pull_request') || !pullRequestIncludesMain) &&
    (!triggers.has('pull_request_target') || !pullRequestTargetIncludesMain)
  ) {
    findings.push('Primary CI workflow must trigger on pull requests to main.');
  }
  if (
    !triggers.has('merge_group') ||
    !mergeGroupIncludesMain ||
    JSON.stringify(mergeGroupTypes) !== JSON.stringify(['checks_requested'])
  ) {
    findings.push(
      'Primary CI workflow must trigger on merge_group checks_requested for main.',
    );
  }
  if (
    triggers.has('pull_request_target') &&
    JSON.stringify(pullRequestTargetTypes) !==
      JSON.stringify(['opened', 'synchronize', 'reopened', 'edited'])
  ) {
    findings.push(
      'Primary CI pull_request_target must include exactly opened, synchronize, reopened, and edited types.',
    );
  }
  if (!triggers.has('workflow_dispatch')) {
    findings.push('Primary CI workflow must support workflow_dispatch.');
  }
  return findings;
}

export function findNamedWorkflowStep(workflowText, name) {
  const lines = workflowText.split('\n');
  const start = lines.findIndex(
    (line) => line.match(/^\s*- name:\s*/) && line.trim() === `- name: ${name}`,
  );
  if (start === -1) return undefined;

  const indent = lines[start].search(/\S/);
  const body = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    const lineIndent = line.search(/\S/);
    if (lineIndent !== -1 && lineIndent <= indent) break;
    body.push(line);
  }
  return body.join('\n');
}

function workflowSteps(workflowText) {
  const lines = workflowText.split('\n');
  const steps = [];
  let current = null;
  const flush = () => {
    if (current) steps.push(current);
    current = null;
  };
  for (const line of lines) {
    const step = line.match(/^(\s*)- name:\s*(.+?)\s*$/);
    if (step) {
      flush();
      current = { indent: step[1].length, name: step[2], lines: [line] };
      continue;
    }
    if (!current) continue;
    const indent = line.search(/\S/);
    if (indent !== -1 && indent <= current.indent) {
      flush();
      continue;
    }
    current.lines.push(line);
  }
  flush();
  return steps;
}

function stepValue(step, key) {
  const pattern = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`);
  const line = step.lines.find((candidate) => pattern.test(candidate));
  return line?.match(pattern)?.[1];
}

function shellForStep(step) {
  const runIndex = step.lines.findIndex((line) => /^\s*run:\s*/.test(line));
  if (runIndex === -1) return '';
  const runLine = step.lines[runIndex];
  const runValue = runLine.replace(/^\s*run:\s*/, '').trim();
  if (runValue !== '|' && runValue !== '|-' && runValue !== '|+') {
    return runValue;
  }
  const runIndent = runLine.search(/\S/);
  return step.lines
    .slice(runIndex + 1)
    .filter((line) => line.trim() === '' || line.search(/\S/) > runIndent)
    .join('\n');
}

function uncommentedShellLines(shell) {
  return shell
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function hasExecutableShellCommand(shell, command) {
  let conditionalDepth = 0;
  let unreachable = false;
  for (const line of uncommentedShellLines(shell)) {
    if (/^(if|while|until)\b/.test(line) || /^case\b/.test(line)) {
      conditionalDepth += 1;
    }
    if (!unreachable) {
      const candidate = line.replace(/^if\s+/, '');
      if (
        !candidate.startsWith('#') &&
        !/^(echo|printf|:)\b/.test(candidate) &&
        !new RegExp(`(?:^|[;&|])\\s*false\\s*&&\\s*${command}`).test(
          candidate,
        ) &&
        candidate.includes(command)
      ) {
        return true;
      }
    }
    if (/^exit\s+\d+\s*(?:;|$)/.test(line) && conditionalDepth === 0) {
      unreachable = true;
    }
    if (/^(fi|esac)\b/.test(line)) {
      conditionalDepth = Math.max(0, conditionalDepth - 1);
    }
  }
  return false;
}

function hasUnconditionalExitBefore(lines, endExclusive) {
  let conditionalDepth = 0;
  for (const line of lines.slice(0, endExclusive)) {
    if (/^(if|while|until)\b/.test(line) || /^case\b/.test(line)) {
      conditionalDepth += 1;
    }
    if (/^exit\s+\d+\s*(?:;|$)/.test(line) && conditionalDepth === 0) {
      return true;
    }
    if (/^(fi|esac)\b/.test(line)) {
      conditionalDepth = Math.max(0, conditionalDepth - 1);
    }
  }
  return false;
}

function hasReadinessExitClassification(shell) {
  const lines = uncommentedShellLines(shell);
  const captureIndex = lines.findIndex((line) =>
    /^READINESS_EXIT=\$\?$/.test(line),
  );
  const caseStart = lines.findIndex((line) =>
    /^case\s+"\$READINESS_EXIT"\s+in$/.test(line),
  );
  if (
    captureIndex === -1 ||
    caseStart === -1 ||
    hasUnconditionalExitBefore(lines, captureIndex) ||
    lines
      .slice(Math.max(0, captureIndex - 3), captureIndex)
      .some((line) => /^exit\s+\d+\s*(?:;|$)/.test(line))
  ) {
    return false;
  }
  const body = lines.slice(caseStart);
  const branchExits = (status, exitCode) => {
    const branchStart = body.findIndex((line) =>
      status === '*'
        ? /^\*\)/.test(line)
        : new RegExp(`^${status}\\)`).test(line),
    );
    return (
      branchStart !== -1 &&
      body
        .slice(branchStart, branchStart + 5)
        .some((line) => new RegExp(`\\bexit\\s+${exitCode}\\b`).test(line))
    );
  };
  return branchExits(1, 1) && branchExits(2, 2) && branchExits('*', 1);
}

function hasExecutableNoDiffNotVerified(shell) {
  const lines = uncommentedShellLines(shell);
  const message =
    'NOT_VERIFIED: Veritas readiness evidence has no diff range available.';
  const messageIndex = lines.findIndex(
    (line) => line.startsWith('echo ') && line.includes(message),
  );
  return (
    messageIndex !== -1 &&
    lines
      .slice(messageIndex, messageIndex + 4)
      .some((line) => /^exit\s+2\s*(?:;|$)/.test(line))
  );
}

/**
 * `continue-on-error` on a step that runs the code under test would let a
 * real failure report green. Artifact uploads are observational and are the
 * sole exemption: an upload quota failure must not rewrite the work verdict.
 */
export function findVerdictBearingContinueOnError(workflowText) {
  const lines = workflowText.split('\n');
  const offenders = [];
  let stepIndent = null;
  let stepName = null;
  let stepBody = [];

  const flush = () => {
    if (stepName === null) return;
    const body = stepBody.join('\n');
    if (/^\s*continue-on-error:\s*true\s*$/m.test(body)) {
      const isArtifactUpload = /uses:\s*actions\/upload-artifact/.test(body);
      const runsCommand = /^\s*run:/m.test(body);
      if (!isArtifactUpload || runsCommand) offenders.push(stepName);
    }
    stepIndent = null;
    stepName = null;
    stepBody = [];
  };

  for (const line of lines) {
    const stepStart = line.match(/^(\s*)- name:\s*(.+?)\s*$/);
    if (stepStart) {
      flush();
      stepIndent = stepStart[1].length;
      stepName = stepStart[2];
      stepBody = [line];
      continue;
    }
    if (stepName === null) continue;
    const indent = line.search(/\S/);
    if (indent !== -1 && indent <= stepIndent) {
      flush();
      continue;
    }
    stepBody.push(line);
  }
  flush();
  return offenders;
}

/** The admission guard of every fast-checks part job that needs `classify`. */
export const REQUIRED_FAST_CHECKS_CONDITION =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal reviewed GitHub Actions predicate.
  "${{ always() && !cancelled() && (github.event_name == 'merge_group' || (github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name == github.repository) || github.event_name == 'workflow_dispatch' || needs.classify.outputs.heavy == 'true') }}";

/**
 * The required `fast-checks` aggregator's guard (#2709): the same event
 * clause as its parts, under `always()` WITHOUT `!cancelled()`. A skipped
 * required check reports success, so an aggregator that skipped itself on a
 * cancelled run would let that run read green; running instead fails it on
 * the cancelled parts.
 */
export const REQUIRED_FAST_CHECKS_AGGREGATE_CONDITION =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal reviewed GitHub Actions predicate.
  "${{ always() && (github.event_name == 'merge_group' || (github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name == github.repository) || github.event_name == 'workflow_dispatch' || needs.classify.outputs.heavy == 'true') }}";

/** The aggregator's base-controlled half: every part job must have succeeded. */
/**
 * The aggregator's base-controlled half: every part job must have succeeded.
 * Its `true)` arm is the TRANSITIONAL legacy branch (#2709): a candidate
 * without scripts/fast-checks-shard.mjs ran its whole unsharded ci:fast in
 * fast-checks-plan, so that job and fast-checks-statics must succeed and the
 * shards must have skipped. Only the exact outputs 'true'/'false' choose a
 * branch. Remove the arm, and the LEGACY constants below, with ci.yml's
 * detection step once open pull requests have merged main.
 */
export const FAST_CHECKS_PART_RESULTS_RUN = `echo "$NEEDS" | jq -r 'to_entries[] | "\\(.key): \\(.value.result)"'
LEGACY="$(echo "$NEEDS" | jq -r '.["fast-checks-plan"].outputs.legacy // ""')"
case "$LEGACY" in
  false)
    echo "$NEEDS" | jq -e '[to_entries[] | select(.key != "classify")] | length == ${FAST_CHECKS_PART_JOBS.length} and all(.value.result == "success")' > /dev/null
    ;;
  true)
    echo "::warning::legacy candidate: fast-checks ran unsharded in fast-checks-plan"
    echo "$NEEDS" | jq -e '.["fast-checks-plan"].result == "success" and .["fast-checks-statics"].result == "success" and .["fast-checks-shard"].result == "skipped"' > /dev/null
    ;;
  *)
    echo "::error::fast-checks-plan reported no valid legacy mode"
    exit 1
    ;;
esac
`;
export const FAST_CHECKS_LEGACY_DETECT_RUN = `if [ -f scripts/fast-checks-shard.mjs ]; then
  echo "legacy=false" >> "$GITHUB_OUTPUT"
else
  echo "::warning::candidate predates the sharded fast-checks lane; running its unsharded ci:fast (merge main to shard)"
  echo "legacy=true" >> "$GITHUB_OUTPUT"
fi
`;
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
export const FAST_CHECKS_LEGACY_OUTPUT = '${{ steps.mode.outputs.legacy }}';
export const FAST_CHECKS_LEGACY_STEP_IF =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
  "${{ steps.mode.outputs.legacy == 'true' }}";
export const FAST_CHECKS_PLANNED_STEP_IF =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
  "${{ steps.mode.outputs.legacy == 'false' }}";
/**
 * The shard admission. It must carry a status function: without one GitHub
 * prefixes success(), which a skipped `classify` (every pull_request_target)
 * makes false even when the plan succeeded -- #2797's shards were skipped on
 * every same-repository pull request that way. So it names the plan's own
 * result instead of inheriting success() over every ancestor.
 */
export const FAST_CHECKS_SHARD_IF =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
  "${{ always() && !cancelled() && needs.fast-checks-plan.result == 'success' && needs.fast-checks-plan.outputs.legacy == 'false' }}";
export const FAST_CHECKS_AGGREGATE_STEP_IF =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
  "${{ needs.fast-checks-plan.outputs.legacy != 'true' }}";
export const FAST_CHECKS_AGGREGATE_RUN =
  'node scripts/fast-checks-shard.mjs aggregate --plan-dir="$RUNNER_TEMP/fast-checks-plan" --receipts-dir="$RUNNER_TEMP/fast-checks-receipts"';
export const FAST_CHECKS_PLAN_RUN =
  'npm run fast-checks:shard -- plan --out="$RUNNER_TEMP/fast-checks-plan/fast-checks-plan.json"';
export const FAST_CHECKS_MATRIX =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
  "${{ fromJSON(needs.fast-checks-plan.outputs.shards || '[1,2,3,4]') }}";
export const FAST_CHECKS_SLICE_RUN = `node scripts/fast-checks-shard.mjs slice --plan="$RUNNER_TEMP/fast-checks-plan/fast-checks-plan.json" --shard="$SHARD/$SHARD_COUNT"`;
export const FAST_CHECKS_SHARD_RUN = `npm run fast-checks:shard -- run --plan="$RUNNER_TEMP/fast-checks-plan/fast-checks-plan.json" --shard="$SHARD/$SHARD_COUNT" --receipt=".kontourai/fast-checks/fast-checks-shard-receipt.json"`;
const FAST_CHECKS_AGGREGATE_NEEDS = ['classify', ...FAST_CHECKS_PART_JOBS];

function needsList(job) {
  return typeof job?.needs === 'string' ? [job.needs] : job?.needs;
}

function sameList(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * A job- or step-level continue-on-error, except on a diagnostics-only
 * artifact upload (the same exemption as findVerdictBearingContinueOnError).
 * The plan and receipt uploads are verdict-bearing and checked by name.
 */
function swallowsFailure(job) {
  return (
    job?.['continue-on-error'] !== undefined ||
    (Array.isArray(job?.steps) &&
      job.steps.some(
        (step) =>
          step?.['continue-on-error'] !== undefined &&
          !(
            typeof step?.uses === 'string' &&
            step.uses.startsWith('actions/upload-artifact@') &&
            step.run === undefined &&
            !VERDICT_BEARING_UPLOADS.includes(step.name)
          ),
      ))
  );
}
const VERDICT_BEARING_UPLOADS = Object.freeze([
  'Upload fast-checks plan',
  'Upload fast-checks shard receipt',
]);

/**
 * Validates the actual required check and the jobs it vouches for, not a
 * similarly named optional lane (#2709): the `fast-checks` aggregator must
 * require the plan, every shard and the statics job, fail on anything but
 * their success, and verify the shard receipts; the browser smoke must run
 * unconditionally inside fast-checks-statics.
 */
export function collectRequiredBrowserSmokeFindings(workflowText) {
  let document;
  try {
    document =
      typeof workflowText === 'string'
        ? load(workflowText, { schema: JSON_SCHEMA })
        : workflowText;
  } catch {
    return ['Required browser smoke needs an unambiguous workflow document.'];
  }
  const jobs = document?.jobs ?? {};
  const job = jobs['fast-checks'];
  if (!job) return ['Required browser smoke must run inside fast-checks.'];
  const findings = [];
  const steps = (candidate) =>
    Array.isArray(candidate?.steps) ? candidate.steps : [];

  if (
    job.if !== REQUIRED_FAST_CHECKS_AGGREGATE_CONDITION ||
    swallowsFailure(job)
  )
    findings.push(
      'Required fast-checks must admit PR and merge candidates without swallowing failures.',
    );
  if (!sameList(needsList(job), FAST_CHECKS_AGGREGATE_NEEDS))
    findings.push(
      'Required fast-checks must not depend on optional or manual completion jobs.',
    );
  const [partResults] = steps(job);
  const aggregate = steps(job).filter(
    (step) => step?.run === FAST_CHECKS_AGGREGATE_RUN,
  );
  if (
    partResults?.run !== FAST_CHECKS_PART_RESULTS_RUN ||
    partResults.if !== undefined ||
    aggregate.length !== 1 ||
    aggregate[0].if !== FAST_CHECKS_AGGREGATE_STEP_IF
  )
    findings.push(
      'Required fast-checks must fail unless every part job succeeded and every shard receipt verifies.',
    );

  for (const partId of ['fast-checks-plan', 'fast-checks-statics']) {
    const part = jobs[partId];
    if (
      !part ||
      part.if !== REQUIRED_FAST_CHECKS_CONDITION ||
      swallowsFailure(part) ||
      !sameList(needsList(part), ['classify'])
    )
      findings.push(
        `Required ${partId} must admit PR and merge candidates without swallowing failures.`,
      );
  }
  const plan = jobs['fast-checks-plan'];
  const planSteps = steps(plan);
  const planned = planSteps.filter(
    (step) => step?.run === FAST_CHECKS_PLAN_RUN,
  );
  const planUpload = planSteps.find(
    (step) => step?.name === 'Upload fast-checks plan',
  );
  if (
    planned.length !== 1 ||
    planned[0].if !== FAST_CHECKS_PLANNED_STEP_IF ||
    planUpload?.if !== FAST_CHECKS_PLANNED_STEP_IF
  )
    findings.push('fast-checks-plan must compute the plan exactly once.');
  // TRANSITIONAL (#2709): the legacy path must run the candidate's WHOLE
  // lane, never less, and only when the detection says so.
  const detect = planSteps.findIndex(
    (step) => step?.run === FAST_CHECKS_LEGACY_DETECT_RUN,
  );
  const legacyLane = planSteps.filter(
    (step) => step?.run === 'npm run ci:fast',
  );
  if (
    detect < 0 ||
    planSteps[detect].id !== 'mode' ||
    planSteps[detect].if !== undefined ||
    detect >
      planSteps.findIndex((step) => step?.run === 'npm run dependencies:ci') ||
    JSON.stringify(plan?.outputs) !==
      JSON.stringify({
        legacy: FAST_CHECKS_LEGACY_OUTPUT,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
        shards: '${{ steps.plan.outputs.shards }}',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
        'shard-count': '${{ steps.plan.outputs.shard-count }}',
      }) ||
    legacyLane.length !== 1 ||
    legacyLane[0].if !== FAST_CHECKS_LEGACY_STEP_IF ||
    legacyLane[0].env?.STATION_CI_FAST_SCOPE !== undefined
  )
    findings.push(
      'fast-checks-plan must run the whole unsharded ci:fast lane exactly when the candidate lacks the sharded lane.',
    );

  const shard = jobs['fast-checks-shard'];
  const matrix = shard?.strategy?.matrix?.shard;
  if (
    !shard ||
    shard.if !== FAST_CHECKS_SHARD_IF ||
    swallowsFailure(shard) ||
    !sameList(needsList(shard), ['fast-checks-plan']) ||
    shard.strategy?.['fail-fast'] !== false ||
    matrix !== FAST_CHECKS_MATRIX
  )
    findings.push(
      'fast-checks-shard must run the planned matrix after the plan without swallowing failures.',
    );
  const shardRuns = steps(shard).filter(
    (step) => step?.run === FAST_CHECKS_SHARD_RUN,
  );
  const receiptUpload = steps(shard).find(
    (step) => step?.name === 'Upload fast-checks shard receipt',
  );
  if (
    shardRuns.length !== 1 ||
    shardRuns[0].if !== undefined ||
    steps(shard).filter((step) => step?.run === FAST_CHECKS_SLICE_RUN)
      .length !== 1 ||
    receiptUpload?.if !== 'always()' ||
    receiptUpload?.with?.['if-no-files-found'] !== 'error'
  )
    findings.push(
      'fast-checks-shard must run its slice unconditionally and always upload its receipt.',
    );

  const statics = jobs['fast-checks-statics'];
  const smoke = steps(statics).filter(
    (step) => step?.name === 'Verify critical browser journeys before merge',
  );
  if (
    smoke.length !== 1 ||
    smoke[0].run !== 'npm run test:e2e:pr-smoke' ||
    smoke[0].if !== undefined ||
    smoke[0]['continue-on-error']
  )
    findings.push(
      'Required browser smoke must execute once, unconditionally, with its real exit status inside fast-checks-statics.',
    );
  const lane = steps(statics).filter((step) => step?.run === 'npm run ci:fast');
  if (
    lane.length !== 1 ||
    lane[0].if !== undefined ||
    lane[0].env?.STATION_CI_FAST_SCOPE !== 'statics'
  )
    findings.push(
      'fast-checks-statics must run the statics-only ci:fast lane once, unconditionally.',
    );
  return findings;
}

/**
 * @param {{
 *   ciWorkflowPath: string;
 *   exists?: (path: string) => boolean;
 *   readFile?: (path: string, encoding: string) => string;
 * }} options
 */
export function collectCiWorkflowGovernanceFindings({
  ciWorkflowPath,
  exists = existsSync,
  readFile = readFileSync,
}) {
  if (!exists(ciWorkflowPath)) return ['Missing .github/workflows/ci.yml.'];

  const workflow = readFile(ciWorkflowPath, 'utf8');
  const steps = workflowSteps(workflow);
  const findings = [
    ...collectPrimaryCiWorkflowTriggerFindings(workflow),
    ...collectRequiredBrowserSmokeFindings(workflow),
  ];
  const verdictBearing = findVerdictBearingContinueOnError(workflow);
  if (verdictBearing.length > 0) {
    findings.push(
      `Post-merge CI workflow must not use continue-on-error on a verdict-bearing step (${verdictBearing.join(', ')}).`,
    );
  }
  if (
    !steps.some((step) =>
      hasExecutableShellCommand(shellForStep(step), 'npm run ci:fast'),
    )
  ) {
    findings.push('Post-merge CI workflow must execute npm run ci:fast.');
  }
  if (
    !steps.some((step) =>
      hasExecutableShellCommand(
        shellForStep(step),
        'npm run test:connected-agents',
      ),
    )
  ) {
    findings.push(
      'Post-merge CI workflow must execute the connected-agents suite.',
    );
  }

  const readinessStep = steps.find(
    (step) => step.name === 'Veritas readiness evidence',
  );
  if (!readinessStep) {
    findings.push(
      'Post-merge CI workflow must execute the named Veritas readiness evidence step.',
    );
  } else {
    if (stepValue(readinessStep, 'if') !== 'always()') {
      findings.push('Veritas readiness evidence must run with if: always().');
    }
    const readinessShell = shellForStep(readinessStep);
    if (
      !hasExecutableShellCommand(
        readinessShell,
        'node scripts/veritas-readiness-evidence.mjs --check evidence',
      )
    ) {
      findings.push(
        'Veritas readiness evidence must execute the Station three-state readiness wrapper.',
      );
    }
    if (/\|\|\s*true\b/.test(readinessShell)) {
      findings.push(
        'Veritas readiness evidence must not discard its exit status with || true.',
      );
    }
    if (!hasReadinessExitClassification(readinessShell)) {
      findings.push(
        'Veritas readiness evidence must classify and propagate a nonzero exit status.',
      );
    }
    if (!hasExecutableNoDiffNotVerified(readinessShell)) {
      findings.push(
        'Veritas readiness evidence must report a missing diff range as NOT_VERIFIED.',
      );
    }
  }
  return findings;
}
