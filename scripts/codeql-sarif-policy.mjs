#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';

export const SARIF_SCHEMA_URLS = Object.freeze([
  'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
  'https://json.schemastore.org/sarif-2.1.0.json',
]);
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

function resultRule(result, { driver, extensions }, path, findings) {
  const reference = result.rule;
  if (
    reference !== undefined &&
    (!reference || typeof reference !== 'object')
  ) {
    findings.push(issue(path, 'has a malformed rule reference.'));
    return undefined;
  }
  let component = driver;
  if (reference?.toolComponent !== undefined) {
    const index = reference.toolComponent?.index;
    if (!Number.isInteger(index) || index < 0 || index >= extensions.length) {
      findings.push(
        issue(path, 'has an invalid rule.toolComponent reference.'),
      );
      return undefined;
    }
    component = extensions[index];
  }
  if (
    reference?.index !== undefined &&
    result.ruleIndex !== undefined &&
    reference.index !== result.ruleIndex
  ) {
    findings.push(issue(path, 'rule.index and ruleIndex disagree.'));
    return undefined;
  }
  if (
    nonEmptyString(reference?.id) &&
    nonEmptyString(result.ruleId) &&
    reference.id !== result.ruleId
  ) {
    findings.push(issue(path, 'rule.id and ruleId disagree.'));
    return undefined;
  }
  const ruleIndex = reference?.index ?? result.ruleIndex;
  const ruleId = reference?.id ?? result.ruleId;
  const hasRuleIndex = ruleIndex !== undefined;
  const hasRuleId = nonEmptyString(ruleId);
  if (!hasRuleIndex && !hasRuleId) {
    findings.push(
      issue(path, 'must reference a rule with ruleIndex or ruleId.'),
    );
    return undefined;
  }
  let rule;
  if (hasRuleIndex) {
    if (
      !Number.isInteger(ruleIndex) ||
      ruleIndex < 0 ||
      ruleIndex >= componentRules(component).length
    ) {
      findings.push(issue(path, 'has an invalid ruleIndex reference.'));
      return undefined;
    }
    rule = componentRules(component)[ruleIndex];
  }
  if (hasRuleId) {
    const search =
      hasRuleIndex || reference?.toolComponent !== undefined
        ? componentRules(component)
        : [driver, ...extensions].flatMap(componentRules);
    const matches = search.filter(
      (candidate) => candidate?.id === result.ruleId,
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

function validateResult(result, components, path, findings, summaries) {
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
    summaries.push(`${rule.id} [${severity}] ${boundedMessage(message.text)}`);
  }
}

function validateRun(run, index, findings, summaries) {
  const path = `runs[${index}]`;
  if (!run || typeof run !== 'object') {
    findings.push(issue(path, 'must be an object.'));
    return;
  }
  const driver = run.tool?.driver;
  const extensions = Array.isArray(run.tool?.extensions)
    ? run.tool.extensions
    : [];
  if (!driver || !CODEQL_TOOL_NAMES.includes(driver.name))
    findings.push(
      issue(
        path,
        `must identify tool.driver.name as one of: ${CODEQL_TOOL_NAMES.join(', ')}.`,
      ),
    );
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
      const label =
        componentIndex === 0
          ? `${path}.tool.driver`
          : `${path}.tool.extensions[${componentIndex - 1}]`;
      for (const [ruleIndex, rule] of componentRules(component).entries()) {
        if (!nonEmptyString(rule?.id))
          findings.push(
            issue(
              `${label}.rules[${ruleIndex}]`,
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
      summaries,
    );
}

export function evaluateCodeqlSarif(document) {
  const findings = [];
  const summaries = [];
  if (!validateAdmission(document, findings)) return { findings, summaries };
  for (const [index, run] of document.runs.entries())
    validateRun(run, index, findings, summaries);
  return { findings, summaries };
}

export function validateCodeqlSarif(document) {
  return evaluateCodeqlSarif(document).findings;
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

export function parseInputPath(argv) {
  const input = argv.find((argument) => argument.startsWith('--input='));
  if (!input || input.length === '--input='.length)
    throw new Error(
      'Usage: codeql-sarif-policy.mjs --input=<CodeQL SARIF file>.',
    );
  return input.slice('--input='.length);
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
  const document = parseSarifBytes(read(input));
  const { findings, summaries } = evaluateCodeqlSarif(document);
  if (findings.length)
    throw new Error(
      `CodeQL SARIF policy failed:\n${findings.map((finding) => `- ${finding}`).join('\n')}`,
    );
  if (summaries.length > 0) {
    const rendered = summaries.slice(0, MAX_RESULT_SUMMARIES);
    const omitted = summaries.length - rendered.length;
    throw new Error(
      `CodeQL SARIF policy blocked ${summaries.length} result(s):\n${rendered.map((summary) => `- ${summary}`).join('\n')}${omitted > 0 ? `\n- … ${omitted} additional result(s) omitted.` : ''}`,
    );
  }
  return { input, runs: document.runs.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const result = runCodeqlSarifPolicy();
    console.log(
      `Validated ${result.runs} CodeQL SARIF run(s) from ${result.input}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
