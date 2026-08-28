#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';

export const SARIF_SCHEMA_URLS = Object.freeze([
  'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
  'https://json.schemastore.org/sarif-2.1.0.json',
]);
// CodeQL CLI 2.26.x names its driver "CodeQL"; the pinned action's own SARIF
// testdata (and older CLIs) use the long form. Both are the same toolchain.
export const CODEQL_TOOL_NAMES = Object.freeze([
  'CodeQL',
  'CodeQL command-line toolchain',
]);
export const MAX_SARIF_BYTES = 50 * 1024 * 1024;
export const MAX_RESULT_SUMMARIES = 20;
export const MAX_RESULT_MESSAGE_LENGTH = 240;

const RESULT_LEVELS = new Set(['note', 'warning', 'error']);

function issue(path, message) {
  return `${path}: ${message}`;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function notificationIsError(notification) {
  return ['error', 'fatal'].includes(notification?.level);
}

/** The bounded SARIF admission schema, kept dependency-free for base execution. */
function validateAdmission(document, findings) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    findings.push(issue('$', 'must be a SARIF object.'));
    return false;
  }
  if (!SARIF_SCHEMA_URLS.includes(document.$schema))
    findings.push(
      issue('$schema', `must equal one of: ${SARIF_SCHEMA_URLS.join(', ')}.`),
    );
  if (document.version !== '2.1.0')
    findings.push(issue('version', 'must equal SARIF version 2.1.0.'));
  if (!Array.isArray(document.runs) || document.runs.length === 0)
    findings.push(issue('runs', 'must be a nonempty array.'));
  return findings.length === 0;
}

function componentRules(component) {
  return Array.isArray(component?.rules) ? component.rules : [];
}

function componentReference(
  componentReference,
  driver,
  extensions,
  path,
  findings,
) {
  if (
    !componentReference ||
    typeof componentReference !== 'object' ||
    Array.isArray(componentReference)
  ) {
    findings.push(issue(path, 'has an invalid rule.toolComponent reference.'));
    return undefined;
  }
  const hasIndex = componentReference.index !== undefined;
  const hasName = componentReference.name !== undefined;
  const hasGuid = componentReference.guid !== undefined;
  let candidates = [driver];
  if (hasIndex) {
    if (
      !Number.isInteger(componentReference.index) ||
      componentReference.index < 0 ||
      componentReference.index >= extensions.length
    ) {
      findings.push(
        issue(path, 'has an invalid rule.toolComponent reference.'),
      );
      return undefined;
    }
    candidates = [extensions[componentReference.index]];
  }
  if (hasGuid && !hasIndex)
    candidates = [driver, ...extensions].filter(
      (component) => component?.guid === componentReference.guid,
    );
  if (hasName) {
    if (!nonEmptyString(componentReference.name)) {
      findings.push(issue(path, 'has an invalid rule.toolComponent name.'));
      return undefined;
    }
    candidates = candidates.filter(
      (component) => component?.name === componentReference.name,
    );
  }
  if (hasGuid) {
    if (!nonEmptyString(componentReference.guid)) {
      findings.push(issue(path, 'has an invalid rule.toolComponent guid.'));
      return undefined;
    }
    candidates = candidates.filter(
      (component) => component?.guid === componentReference.guid,
    );
  }
  if (candidates.length !== 1) {
    findings.push(
      issue(path, 'has an unknown or ambiguous rule.toolComponent reference.'),
    );
    return undefined;
  }
  return candidates[0];
}

/**
 * Resolve a result to its reporting rule per SARIF 2.1.0. Current CodeQL puts
 * every rule in `tool.extensions[]` (one component per query pack, the driver's
 * own rules array empty) and references them through
 * `result.rule.toolComponent.index` + `result.rule.index`; older emitters put
 * rules on the driver and reference them with `ruleIndex`/`ruleId`. Both forms
 * must resolve, and every ambiguity fails closed.
 */
function resultRule(result, components, path, findings) {
  const { driver, extensions } = components;
  const reference = result.rule;
  const hasReference = reference !== undefined;
  if (
    hasReference &&
    (typeof reference !== 'object' ||
      reference === null ||
      Array.isArray(reference))
  ) {
    findings.push(issue(path, 'has a malformed rule reference.'));
    return undefined;
  }
  if (
    hasReference &&
    reference.id !== undefined &&
    !nonEmptyString(reference.id)
  ) {
    findings.push(issue(path, 'has an invalid rule.id reference.'));
    return undefined;
  }
  if (result.ruleId !== undefined && !nonEmptyString(result.ruleId)) {
    findings.push(issue(path, 'has an invalid ruleId reference.'));
    return undefined;
  }
  let component = driver;
  if (hasReference && reference.toolComponent !== undefined) {
    component = componentReference(
      reference.toolComponent,
      driver,
      extensions,
      path,
      findings,
    );
    if (!component) return undefined;
  }
  if (
    hasReference &&
    reference.index !== undefined &&
    result.ruleIndex !== undefined &&
    reference.index !== result.ruleIndex
  ) {
    findings.push(issue(path, 'rule.index and ruleIndex disagree.'));
    return undefined;
  }
  if (
    hasReference &&
    nonEmptyString(reference.id) &&
    nonEmptyString(result.ruleId) &&
    reference.id !== result.ruleId
  ) {
    findings.push(issue(path, 'rule.id and ruleId disagree.'));
    return undefined;
  }
  const ruleIndex = reference?.index ?? result.ruleIndex;
  const ruleId = reference?.id ?? result.ruleId;
  const ruleGuid = reference?.guid;
  const hasRuleIndex = ruleIndex !== undefined && ruleIndex !== null;
  const hasRuleId = nonEmptyString(ruleId);
  const hasRuleGuid = nonEmptyString(ruleGuid);
  if (!hasRuleIndex && !hasRuleId && !hasRuleGuid) {
    findings.push(
      issue(
        path,
        'must reference a rule with ruleIndex, ruleId, or rule guid.',
      ),
    );
    return undefined;
  }
  let rule;
  if (hasRuleIndex) {
    const rules = componentRules(component);
    if (
      !Number.isInteger(ruleIndex) ||
      ruleIndex < 0 ||
      ruleIndex >= rules.length
    ) {
      findings.push(issue(path, 'has an invalid ruleIndex reference.'));
      return undefined;
    }
    rule = rules[ruleIndex];
  }
  if (hasRuleId || hasRuleGuid) {
    if (rule) {
      if (
        (hasRuleId && rule.id !== ruleId) ||
        (hasRuleGuid && rule.guid !== ruleGuid)
      ) {
        findings.push(
          issue(path, 'rule id or guid does not match its resolved index.'),
        );
        return undefined;
      }
      return rule;
    }
    // With an index resolved, the id is a cross-check within that component.
    // Without one, search the referenced component when the reference names
    // it, otherwise every component — requiring a globally unique id.
    const searchSpace =
      hasRuleIndex || (hasReference && reference.toolComponent !== undefined)
        ? componentRules(component)
        : [driver, ...extensions].flatMap(componentRules);
    const matches = searchSpace.filter(
      (candidate) =>
        (!hasRuleId || candidate?.id === ruleId) &&
        (!hasRuleGuid || candidate?.guid === ruleGuid),
    );
    if (matches.length !== 1) {
      findings.push(
        issue(path, 'has an unknown or ambiguous ruleId reference.'),
      );
      return undefined;
    }
    if (rule && rule !== matches[0]) {
      findings.push(
        issue(path, 'ruleId and ruleIndex refer to different rules.'),
      );
      return undefined;
    }
    rule = matches[0];
  }
  return rule;
}

function boundedMessage(message) {
  const compact = message.replace(/\s+/g, ' ').trim();
  return compact.length > MAX_RESULT_MESSAGE_LENGTH
    ? `${compact.slice(0, MAX_RESULT_MESSAGE_LENGTH - 1)}…`
    : compact;
}

function resultLocation(result) {
  const physical = result.locations?.[0]?.physicalLocation;
  const uri = physical?.artifactLocation?.uri;
  const line = physical?.region?.startLine;
  return nonEmptyString(uri)
    ? `${uri}${Number.isInteger(line) ? `:${line}` : ''}`
    : undefined;
}

// Match on the RESOLVED rule id, not raw result.ruleId — resolution admits
// rule.id-only references, and the two must not diverge in baseline behavior.
function baselineMatches(result, resolvedRuleId, entry) {
  return (
    entry.rule === resolvedRuleId &&
    entry.path ===
      result.locations?.[0]?.physicalLocation?.artifactLocation?.uri &&
    entry.lineHash === result.partialFingerprints?.primaryLocationLineHash
  );
}

export function validateBaseline(baseline, findings) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    findings.push(issue('baseline', 'must be an object.'));
    return [];
  }
  if (!Array.isArray(baseline.findings)) {
    findings.push(issue('baseline.findings', 'must be an array.'));
    return [];
  }
  const entries = [];
  for (const [index, entry] of baseline.findings.entries()) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !nonEmptyString(entry.rule) ||
      !nonEmptyString(entry.path) ||
      !nonEmptyString(entry.lineHash)
    ) {
      findings.push(
        issue(
          `baseline.findings[${index}]`,
          'must contain nonblank rule, path, and lineHash.',
        ),
      );
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

function validateResult(
  result,
  components,
  path,
  findings,
  verdicts,
  baseline,
) {
  if (!result || typeof result !== 'object') {
    findings.push(issue(path, 'must be an object.'));
    return;
  }
  const rule = resultRule(result, components, path, findings);
  // SARIF 2.1 defines an omitted result.level as warning. Explicit none is
  // narrower than this security policy: result.kind defaults to fail, so none
  // alone cannot turn a finding into clean evidence.
  const level = result.level ?? rule?.defaultConfiguration?.level ?? 'warning';
  if (!RESULT_LEVELS.has(level))
    findings.push(
      issue(path, 'must resolve severity level error, warning, or note.'),
    );
  const message = result.message;
  if (!message || typeof message !== 'object' || !nonEmptyString(message.text))
    findings.push(issue(path, 'must contain a nonblank message.text.'));
  const securitySeverity =
    result.properties?.['security-severity'] ??
    rule?.properties?.['security-severity'];
  if (securitySeverity !== undefined) {
    const numeric = Number(securitySeverity);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 10)
      findings.push(
        issue(path, 'has an invalid properties.security-severity.'),
      );
  }
  if (rule && RESULT_LEVELS.has(level) && nonEmptyString(message?.text)) {
    const severity =
      securitySeverity === undefined ? level : `${level}/${securitySeverity}`;
    const location = resultLocation(result);
    const summary = `${rule.id} [${severity}]${location ? ` ${location}` : ''} ${boundedMessage(message.text)}`;
    if (level !== 'error') {
      verdicts.advisories.push(summary);
      return;
    }
    const matched = baseline.find((entry) =>
      baselineMatches(result, rule.id, entry),
    );
    if (matched) {
      baseline.matchedEntries.add(matched);
      verdicts.baselined.push(summary);
    } else {
      verdicts.blocked.push(summary);
    }
  }
}

function validateRun(run, index, findings, verdicts, baseline) {
  const path = `runs[${index}]`;
  if (!run || typeof run !== 'object') {
    findings.push(issue(path, 'must be an object.'));
    return;
  }
  const driver = run.tool?.driver;
  const extensions = Array.isArray(run.tool?.extensions)
    ? run.tool.extensions
    : [];
  if (run.tool?.extensions !== undefined && !Array.isArray(run.tool.extensions))
    findings.push(
      issue(path, 'tool.extensions must be an array when present.'),
    );
  if (!driver || !CODEQL_TOOL_NAMES.includes(driver.name))
    findings.push(
      issue(
        path,
        `must identify tool.driver.name as one of: ${CODEQL_TOOL_NAMES.join(', ')}.`,
      ),
    );
  for (const [extensionIndex, extension] of extensions.entries()) {
    const extensionPath = `${path}.tool.extensions[${extensionIndex}]`;
    if (!extension || typeof extension !== 'object' || Array.isArray(extension))
      findings.push(issue(extensionPath, 'must be a tool component object.'));
    else if (!nonEmptyString(extension.name))
      findings.push(
        issue(extensionPath, 'must contain a nonblank extension name.'),
      );
  }
  const components = { driver, extensions };
  const allRules = [driver, ...extensions].flatMap(componentRules);
  if (allRules.length === 0)
    findings.push(
      issue(
        path,
        'must declare CodeQL rules on the driver or its extensions; a rule-free run is synthetic or incomplete evidence.',
      ),
    );
  else {
    for (const [componentIndex, component] of [
      driver,
      ...extensions,
    ].entries()) {
      const componentPath =
        componentIndex === 0
          ? `${path}.tool.driver`
          : `${path}.tool.extensions[${componentIndex - 1}]`;
      if (
        !component ||
        typeof component !== 'object' ||
        Array.isArray(component)
      ) {
        findings.push(issue(componentPath, 'must be a tool component object.'));
        continue;
      }
      if (component.rules !== undefined && !Array.isArray(component.rules)) {
        findings.push(
          issue(componentPath, 'rules must be an array when present.'),
        );
        continue;
      }
      for (const [ruleIndex, rule] of componentRules(component).entries()) {
        if (!nonEmptyString(rule?.id))
          findings.push(
            issue(
              `${componentPath}.rules[${ruleIndex}]`,
              'must contain a nonblank id.',
            ),
          );
      }
    }
  }
  if (run.invocations !== undefined && !Array.isArray(run.invocations))
    findings.push(issue(path, 'invocations must be an array when present.'));
  else if (Array.isArray(run.invocations)) {
    for (const [invocationIndex, invocation] of run.invocations.entries()) {
      const invocationPath = `${path}.invocations[${invocationIndex}]`;
      if (invocation?.executionSuccessful !== true)
        findings.push(
          issue(invocationPath, 'must declare executionSuccessful: true.'),
        );
      for (const [notificationIndex, notification] of (
        invocation?.toolExecutionNotifications ?? []
      ).entries()) {
        if (notificationIsError(notification))
          findings.push(
            issue(
              `${invocationPath}.toolExecutionNotifications[${notificationIndex}]`,
              'reports an analysis error.',
            ),
          );
      }
    }
  }
  if (!Array.isArray(run.results)) {
    findings.push(issue(path, 'must include a results array.'));
    return;
  }
  for (const [resultIndex, result] of run.results.entries())
    validateResult(
      result,
      components,
      `${path}.results[${resultIndex}]`,
      findings,
      verdicts,
      baseline,
    );
}

/**
 * Evaluate a CodeQL SARIF document against the policy.
 *
 * - `findings` are structural violations; any entry fails the policy.
 * - `blocked` are error-level results outside the baseline; any entry fails.
 * - `baselined` are error-level results grandfathered by the baseline (#688).
 * - `advisories` are warning/note results — reported, never blocking.
 *
 * A baseline entry that matches no error-level result is stale and is
 * reported in `staleBaseline`. The caller decides its severity: the workflow
 * fails on it for push-to-main (the merged tree must keep baseline and
 * findings in lockstep) but only warns on pull_request_target — the gate
 * reads the baseline from the BASE checkout there, so a PR that fixes a
 * baselined finding and removes its entry in the same change would otherwise
 * red on an entry it cannot see removed, and the baseline could never shrink
 * through a green gate.
 */
export function evaluateCodeqlSarif(document, { baseline } = {}) {
  const findings = [];
  const verdicts = { blocked: [], baselined: [], advisories: [] };
  const staleBaseline = [];
  const baselineEntries =
    baseline === undefined ? [] : validateBaseline(baseline, findings);
  baselineEntries.matchedEntries = new Set();
  if (!validateAdmission(document, findings))
    return { findings, staleBaseline, ...verdicts };
  for (const [index, run] of document.runs.entries())
    validateRun(run, index, findings, verdicts, baselineEntries);
  for (const entry of baselineEntries) {
    if (!baselineEntries.matchedEntries.has(entry))
      staleBaseline.push(
        issue(
          'baseline',
          `entry ${entry.rule} at ${entry.path} (${entry.lineHash}) no longer matches any error-level result; remove it.`,
        ),
      );
  }
  return { findings, staleBaseline, ...verdicts };
}

export function validateCodeqlSarif(document, options) {
  const { findings, staleBaseline } = evaluateCodeqlSarif(document, options);
  return [...findings, ...staleBaseline];
}

export function parseSarifBytes(bytes, { requireTerminalNewline = true } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0)
    throw new Error('SARIF input is empty.');
  if (bytes.length > MAX_SARIF_BYTES)
    throw new Error(`SARIF input exceeds the ${MAX_SARIF_BYTES}-byte limit.`);
  if (requireTerminalNewline && !bytes.subarray(-1).equals(Buffer.from('\n')))
    throw new Error('SARIF input is truncated or lacks its terminal newline.');
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('SARIF input is malformed or truncated: invalid UTF-8.');
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(
      `SARIF input is malformed or truncated: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function optionValue(argv, name) {
  const prefix = `--${name}=`;
  const match = argv.find((argument) => argument.startsWith(prefix));
  if (match === undefined) return undefined;
  if (match.length === prefix.length)
    throw new Error(`--${name} requires a value.`);
  return match.slice(prefix.length);
}

export function parseInputPath(argv) {
  const input = optionValue(argv, 'input');
  if (!input)
    throw new Error(
      'Usage: codeql-sarif-policy.mjs --input=<CodeQL SARIF file> [--baseline=<error baseline JSON>].',
    );
  return input;
}

function renderBounded(label, summaries) {
  const rendered = summaries.slice(0, MAX_RESULT_SUMMARIES);
  const omitted = summaries.length - rendered.length;
  return `${label}\n${rendered.map((summary) => `- ${summary}`).join('\n')}${omitted > 0 ? `\n- … ${omitted} additional result(s) omitted.` : ''}`;
}

/**
 * `read` is narrowed to what this function actually asks of it — one path in,
 * the file's bytes out. Defaulting the parameter to `readFileSync` typed the
 * seam as that function's whole overload set, so a test stub returning a
 * Buffer for one string argument was rejected against overloads this code
 * never calls (TS2345, caught by `typecheck:scripts`, invisible to a bare
 * `tsc --noEmit`).
 *
 * @param {string[]} [argv]
 * @param {(path: string) => Buffer | string} [read]
 */
export function runCodeqlSarifPolicy(
  argv = process.argv.slice(2),
  read = (path) => readFileSync(path),
) {
  const input = parseInputPath(argv);
  const baselinePath = optionValue(argv, 'baseline');
  let baseline;
  if (baselinePath !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(read(baselinePath).toString());
    } catch (error) {
      throw new Error(
        `CodeQL error baseline is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    baseline = parsed;
  }
  const staleBaselineMode = optionValue(argv, 'stale-baseline') ?? 'fail';
  if (!['fail', 'warn'].includes(staleBaselineMode))
    throw new Error('--stale-baseline must be fail or warn.');
  const document = parseSarifBytes(read(input));
  const { findings, staleBaseline, blocked, baselined, advisories } =
    evaluateCodeqlSarif(document, { baseline });
  const failing =
    staleBaselineMode === 'fail' ? [...findings, ...staleBaseline] : findings;
  if (failing.length)
    throw new Error(
      `CodeQL SARIF policy failed:\n${failing.map((finding) => `- ${finding}`).join('\n')}`,
    );
  if (blocked.length > 0)
    throw new Error(
      renderBounded(
        `CodeQL SARIF policy blocked ${blocked.length} error-level result(s):`,
        blocked,
      ),
    );
  return {
    input,
    runs: document.runs.length,
    staleBaseline,
    baselined,
    advisories,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const result = runCodeqlSarifPolicy();
    if (result.staleBaseline.length > 0)
      console.log(
        renderBounded(
          `WARNING: ${result.staleBaseline.length} stale baseline entr(ies) — remove them in this change:`,
          result.staleBaseline,
        ),
      );
    if (result.baselined.length > 0)
      console.log(
        renderBounded(
          `Baselined ${result.baselined.length} grandfathered error-level result(s) (#688):`,
          result.baselined,
        ),
      );
    if (result.advisories.length > 0)
      console.log(
        renderBounded(
          `Reported ${result.advisories.length} advisory (warning/note) result(s):`,
          result.advisories,
        ),
      );
    console.log(
      `Validated ${result.runs} CodeQL SARIF run(s) from ${result.input}: 0 blocking, ${result.baselined.length} baselined, ${result.advisories.length} advisory.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
