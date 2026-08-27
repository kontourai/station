/**
 * CI wiring is a post-merge operational fact, not a comment-level convention.
 * Keep its checks in one place so the proof-family and guardrail entry points
 * cannot silently claim that this workflow evaluates a candidate pull request.
 */
import { existsSync, readFileSync } from 'node:fs';

/**
 * This is intentionally a canonical YAML subset, not a general YAML parser.
 * A governed workflow must declare an unquoted top-level `on` mapping. Push
 * and pull-request branch filters are parsed separately so the primary CI
 * workflow can admit candidate feedback without weakening post-merge-only
 * detectors. Scalar, sequence, inline-event, quoted-key, duplicate-key, and
 * unknown-filter forms fail closed. Every top-level semantic `on` spelling is
 * counted before the canonical declaration is admitted, so a duplicate cannot
 * override it.
 */
function workflowTriggerDeclaration(workflowText) {
  const lines = workflowText.split('\n');
  const invalid = (triggers = new Set()) => ({
    valid: false,
    triggers,
    pushIncludesMain: false,
    pullRequestIncludesMain: false,
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
  let branchIndent = null;
  const branchesByTrigger = new Map();

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
        name === 'pull_request_target'
      ) {
        if (value) return invalid(triggers);
        activeTrigger = name;
        branchesByTrigger.set(name, null);
      } else if (name === 'workflow_dispatch') {
        if (value && value !== '{}') return invalid(triggers);
        activeTrigger = 'workflow_dispatch';
      } else {
        return invalid(triggers);
      }
      if (triggers.has(name)) return invalid(triggers);
      triggers.add(name);
      branchIndent = null;
      continue;
    }

    if (
      activeTrigger !== 'push' &&
      activeTrigger !== 'pull_request' &&
      activeTrigger !== 'pull_request_target'
    ) {
      return invalid(triggers);
    }
    if (branchIndent === null) {
      const branchMapping = line
        .trim()
        .match(/^branches:\s*(\[[^[]*\]|[A-Za-z0-9_-]+)?\s*(?:#.*)?$/);
      if (!branchMapping) return invalid(triggers);
      branchIndent = indent;
      const value = branchMapping[1];
      if (!value) {
        branchesByTrigger.set(activeTrigger, []);
        continue;
      }
      const values = value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((branch) => branch.trim())
        .filter(Boolean);
      if (!values.every((branch) => /^[A-Za-z0-9_-]+$/.test(branch))) {
        return invalid(triggers);
      }
      branchesByTrigger.set(activeTrigger, values);
      continue;
    }
    if (indent <= branchIndent) return invalid(triggers);
    const branch = line.trim().match(/^-\s+([A-Za-z0-9_-]+)\s*(?:#.*)?$/);
    if (!branch) return invalid(triggers);
    branchesByTrigger.get(activeTrigger).push(branch[1]);
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
  };
}

export function workflowExecutionScope(workflowText) {
  const { valid, triggers } = workflowTriggerDeclaration(workflowText);
  if (!valid) return 'invalid';
  return triggers.has('pull_request') || triggers.has('pull_request_target')
    ? 'pull-request'
    : 'post-merge';
}

export function collectPostMergeDetectorWorkflowFindings(workflowText) {
  const { valid, triggers, pushIncludesMain } =
    workflowTriggerDeclaration(workflowText);
  const findings = [];
  if (!valid) {
    findings.push(
      'Post-merge detector workflow must declare supported top-level triggers.',
    );
    return findings;
  }
  if (!triggers.has('push') || !pushIncludesMain) {
    findings.push('Post-merge detector workflow must trigger on push to main.');
  }
  if (!triggers.has('workflow_dispatch')) {
    findings.push(
      'Post-merge detector workflow must support workflow_dispatch.',
    );
  }
  if (triggers.has('pull_request') || triggers.has('pull_request_target')) {
    findings.push(
      'Post-merge detector workflow must not trigger on pull_request.',
    );
  }
  return findings;
}

export function collectPrimaryCiWorkflowTriggerFindings(workflowText) {
  const {
    valid,
    triggers,
    pushIncludesMain,
    pullRequestIncludesMain,
    pullRequestTargetIncludesMain,
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
  const findings = collectPrimaryCiWorkflowTriggerFindings(workflow);
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
