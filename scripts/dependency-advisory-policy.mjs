#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ALL_DEPENDENCY_SCOPES,
  classifyGitRange,
} from './classify-ci-change.mjs';

const BLOCKING_SEVERITIES = new Set(['critical', 'high']);
const RESIDUAL_SEVERITIES = new Set(['moderate', 'low']);
const REACHABILITY = new Set(['full', 'production']);
const EXCEPTION_FIELDS = new Set([
  'scope',
  'package',
  'advisory',
  'severity',
  'owner',
  'reason',
  'trackingIssue',
  'expires',
]);
const RESIDUAL_FIELDS = new Set([
  'scope',
  'package',
  'version',
  'advisory',
  'severity',
  'reachability',
  'owner',
  'disposition',
  'controls',
  'trackingUrl',
  'expires',
  'recheckTrigger',
]);
const COUNTS = ['info', 'low', 'moderate', 'high', 'critical', 'total'];
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function advisoryIdentity(via) {
  const urlMatch =
    typeof via.url === 'string'
      ? via.url.match(/(?:advisories\/|\/)(GHSA-[0-9a-z-]+)(?:$|[/?#])/i)
      : null;
  if (urlMatch) return urlMatch[1];
  if (
    (Number.isInteger(via.source) && via.source > 0) ||
    (typeof via.source === 'string' && via.source.trim() !== '')
  ) {
    return String(via.source);
  }
  throw new Error(
    `npm audit advisory for ${String(via.name ?? 'unknown')} has no identity`,
  );
}

function vulnerabilitySeverity(vulnerability) {
  return String(vulnerability.severity ?? '').toLowerCase();
}

function collectAdvisories(scope, packageKey, vulnerabilities, traversal = []) {
  if (traversal.includes(packageKey)) {
    throw new Error(
      `npm audit vulnerability cycle for ${scope}: ${[...traversal, packageKey].join(' -> ')}`,
    );
  }
  const vulnerability = assertRecord(
    vulnerabilities[packageKey],
    `vulnerability ${scope}:${packageKey}`,
  );
  if (!Array.isArray(vulnerability.via)) {
    throw new Error(
      `vulnerability ${scope}:${packageKey} has unsupported via data`,
    );
  }

  const advisories = [];
  const nextTraversal = [...traversal, packageKey];
  for (const rawVia of vulnerability.via) {
    if (typeof rawVia === 'string') {
      if (!Object.hasOwn(vulnerabilities, rawVia)) {
        throw new Error(
          `dangling npm audit via reference for ${scope}:${packageKey}: ${rawVia}`,
        );
      }
      advisories.push(
        ...collectAdvisories(scope, rawVia, vulnerabilities, nextTraversal),
      );
      continue;
    }

    const via = assertRecord(rawVia, `advisory ${scope}:${packageKey}`);
    const severity = String(
      via.severity ?? vulnerability.severity ?? '',
    ).toLowerCase();
    if (!severity) {
      throw new Error(
        `npm audit advisory for ${scope}:${packageKey} has no severity`,
      );
    }
    advisories.push({
      package: typeof via.name === 'string' ? via.name : packageKey,
      advisory: advisoryIdentity(via),
      severity,
      title: typeof via.title === 'string' ? via.title : '',
      url: typeof via.url === 'string' ? via.url : '',
    });
  }
  return advisories;
}

function resolvedPackageVersions(
  scope,
  packageName,
  vulnerabilities,
  resolvedVersions,
) {
  const vulnerability = assertRecord(
    vulnerabilities[packageName],
    `root vulnerability ${scope}:${packageName}`,
  );
  if (!Array.isArray(vulnerability.nodes) || vulnerability.nodes.length === 0)
    throw new Error(
      `production residual ${scope}:${packageName} has no resolved package nodes`,
    );
  const versions = new Set();
  for (const node of vulnerability.nodes) {
    const version = resolvedVersions?.[node];
    if (typeof version !== 'string' || version.trim() === '') {
      throw new Error(
        `production residual ${scope}:${packageName} has no resolved version for ${node}`,
      );
    }
    versions.add(version);
  }
  return [...versions].sort();
}

function parseAudit(scope, input, reachability, resolvedVersions = {}) {
  const audit = assertRecord(input, `audit input for ${scope}`);
  if (audit.auditReportVersion !== 2 || !audit.vulnerabilities) {
    throw new Error(
      `unsupported npm audit JSON for ${scope}; expected auditReportVersion 2`,
    );
  }
  const vulnerabilities = assertRecord(
    audit.vulnerabilities,
    `vulnerabilities for ${scope}`,
  );
  const metadata = assertRecord(audit.metadata, `metadata for ${scope}`);
  const countsInput = assertRecord(
    metadata.vulnerabilities,
    `metadata.vulnerabilities for ${scope}`,
  );
  const counts = Object.fromEntries(
    COUNTS.map((name) => {
      const value = countsInput[name];
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`invalid ${name} audit count for ${scope}`);
      }
      return [name, value];
    }),
  );

  const recordCounts = Object.fromEntries(
    COUNTS.filter((severity) => severity !== 'total').map((severity) => [
      severity,
      0,
    ]),
  );
  for (const [packageKey, rawVulnerability] of Object.entries(
    vulnerabilities,
  )) {
    const vulnerability = assertRecord(
      rawVulnerability,
      `vulnerability ${scope}:${packageKey}`,
    );
    const severity = vulnerabilitySeverity(vulnerability);
    if (!Object.hasOwn(recordCounts, severity)) {
      throw new Error(
        `unsupported vulnerability severity for ${scope}:${packageKey}: ${severity || 'missing'}`,
      );
    }
    recordCounts[severity] += 1;
  }
  for (const severity of Object.keys(recordCounts)) {
    if (counts[severity] !== recordCounts[severity]) {
      throw new Error(
        `npm audit metadata ${severity} count mismatch for ${scope}: metadata=${counts[severity]} records=${recordCounts[severity]}`,
      );
    }
  }
  const recordTotal = Object.values(recordCounts).reduce(
    (total, count) => total + count,
    0,
  );
  if (counts.total !== recordTotal) {
    throw new Error(
      `npm audit metadata total count mismatch for ${scope}: metadata=${counts.total} records=${recordTotal}`,
    );
  }

  const findings = [];
  for (const [packageKey, rawVulnerability] of Object.entries(
    vulnerabilities,
  )) {
    const vulnerability = assertRecord(
      rawVulnerability,
      `vulnerability ${scope}:${packageKey}`,
    );
    const severity = vulnerabilitySeverity(vulnerability);
    if (
      !BLOCKING_SEVERITIES.has(severity) &&
      !(reachability === 'production' && RESIDUAL_SEVERITIES.has(severity))
    ) {
      continue;
    }
    const advisories = collectAdvisories(scope, packageKey, vulnerabilities);
    const uniqueAdvisories = new Map(
      advisories.map((advisory) => [
        `${advisory.package}\u0000${advisory.advisory}\u0000${advisory.severity}`,
        advisory,
      ]),
    );
    if (uniqueAdvisories.size === 0) {
      throw new Error(
        `tracked vulnerability ${scope}:${packageKey} has no advisory identities`,
      );
    }
    for (const advisory of uniqueAdvisories.values()) {
      if (
        reachability === 'production' &&
        RESIDUAL_SEVERITIES.has(advisory.severity)
      ) {
        for (const version of resolvedPackageVersions(
          scope,
          advisory.package,
          vulnerabilities,
          resolvedVersions,
        )) {
          findings.push({ scope, reachability, version, ...advisory });
        }
      } else {
        findings.push({ scope, reachability, ...advisory });
      }
    }
  }
  return { counts, findings };
}

function exceptionKey(value) {
  return `${value.scope}\u0000${value.package}\u0000${value.advisory}`;
}

function residualKey(value) {
  return `${value.scope}\u0000${value.package}\u0000${value.version}\u0000${value.advisory}\u0000${value.reachability}`;
}

function validateExpiry(value, label, errors, now) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    errors.push(`${label} expires must be an ISO YYYY-MM-DD date`);
    return;
  }
  const expires = new Date(`${value}T00:00:00.000Z`);
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  if (
    Number.isNaN(expires.valueOf()) ||
    expires.toISOString().slice(0, 10) !== value
  ) {
    errors.push(`${label} expires must be a valid calendar date (${value})`);
  } else if (expires <= today) {
    errors.push(`${label} is expired (${value})`);
  }
}

function validateExceptions(input, scopes, now) {
  const config = assertRecord(input, 'exception config');
  const configFields = Object.keys(config);
  for (const field of configFields) {
    if (
      field !== 'version' &&
      field !== 'exceptions' &&
      field !== 'residuals'
    ) {
      throw new Error(`exception config has unknown field: ${field}`);
    }
  }
  if (
    config.version !== 2 ||
    !Array.isArray(config.exceptions) ||
    !Array.isArray(config.residuals)
  ) {
    throw new Error(
      'exception config must have version 2 plus exceptions and residuals arrays',
    );
  }

  const errors = [];
  const validated = [];
  const keys = new Set();
  for (const [index, rawException] of config.exceptions.entries()) {
    if (
      !rawException ||
      typeof rawException !== 'object' ||
      Array.isArray(rawException)
    ) {
      errors.push(`exception ${index + 1} must be an object`);
      continue;
    }
    const exception = rawException;
    const unknown = Object.keys(exception).filter(
      (field) => !EXCEPTION_FIELDS.has(field),
    );
    if (unknown.length > 0)
      errors.push(
        `exception ${index + 1} has unknown field: ${unknown.join(', ')}`,
      );
    for (const field of EXCEPTION_FIELDS) {
      if (
        typeof exception[field] !== 'string' ||
        exception[field].trim() === ''
      ) {
        errors.push(
          `exception ${index + 1} ${field} must be a non-empty string`,
        );
      }
    }
    if (!scopes.has(exception.scope))
      errors.push(
        `exception ${index + 1} has unknown scope: ${exception.scope}`,
      );
    if (!BLOCKING_SEVERITIES.has(exception.severity)) {
      errors.push(`exception ${index + 1} severity must be high or critical`);
    }
    if (
      typeof exception.trackingIssue === 'string' &&
      !/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(
        exception.trackingIssue,
      )
    ) {
      errors.push(
        `exception ${index + 1} trackingIssue must be an exact GitHub issue URL`,
      );
    }
    if (typeof exception.expires === 'string')
      validateExpiry(exception.expires, `exception ${index + 1}`, errors, now);
    const key = exceptionKey(exception);
    if (keys.has(key))
      errors.push(
        `exception ${index + 1} is a duplicate for ${exception.scope}:${exception.package}:${exception.advisory}`,
      );
    keys.add(key);
    validated.push(exception);
  }
  const residuals = [];
  const residualKeys = new Set();
  for (const [index, rawResidual] of config.residuals.entries()) {
    const label = `residual ${index + 1}`;
    if (
      !rawResidual ||
      typeof rawResidual !== 'object' ||
      Array.isArray(rawResidual)
    ) {
      errors.push(`${label} must be an object`);
      continue;
    }
    const residual = rawResidual;
    const unknown = Object.keys(residual).filter(
      (field) => !RESIDUAL_FIELDS.has(field),
    );
    if (unknown.length > 0)
      errors.push(`${label} has unknown field: ${unknown.join(', ')}`);
    for (const field of RESIDUAL_FIELDS) {
      if (typeof residual[field] !== 'string' || residual[field].trim() === '')
        errors.push(`${label} ${field} must be a non-empty string`);
    }
    if (!scopes.has(residual.scope))
      errors.push(`${label} has unknown scope: ${residual.scope}`);
    if (!RESIDUAL_SEVERITIES.has(residual.severity))
      errors.push(`${label} severity must be moderate or low`);
    if (residual.reachability !== 'production')
      errors.push(`${label} reachability must be production`);
    if (typeof residual.trackingUrl === 'string') {
      try {
        const url = new URL(residual.trackingUrl);
        if (url.protocol !== 'https:') throw new Error('not https');
      } catch {
        errors.push(
          `${label} trackingUrl must be an HTTPS upstream or tracking URL`,
        );
      }
    }
    if (typeof residual.expires === 'string')
      validateExpiry(residual.expires, label, errors, now);
    const key = residualKey(residual);
    if (residualKeys.has(key))
      errors.push(
        `${label} is a duplicate for ${residual.scope}:${residual.package}:${residual.version}:${residual.advisory}`,
      );
    residualKeys.add(key);
    residuals.push(residual);
  }
  return { errors, validated, residuals };
}

export function evaluateAuditPolicy(
  auditDocuments,
  exceptionConfig,
  options = {},
) {
  if (!Array.isArray(auditDocuments) || auditDocuments.length === 0) {
    throw new Error('at least one scoped audit document is required');
  }
  const scopes = new Set();
  const documentKeys = new Set();
  const parsed = [];
  for (const document of auditDocuments) {
    if (
      !document ||
      typeof document.scope !== 'string' ||
      document.scope.trim() === ''
    ) {
      throw new Error('each audit document requires a non-empty scope');
    }
    const reachability = document.reachability ?? 'full';
    if (!REACHABILITY.has(reachability))
      throw new Error(
        `audit document ${document.scope} has unsupported reachability: ${reachability}`,
      );
    const documentKey = `${document.scope}\u0000${reachability}`;
    if (documentKeys.has(documentKey))
      throw new Error(
        `duplicate audit document: ${document.scope}:${reachability}`,
      );
    documentKeys.add(documentKey);
    scopes.add(document.scope);
    parsed.push({
      scope: document.scope,
      reachability,
      ...parseAudit(
        document.scope,
        document.audit,
        reachability,
        document.resolvedVersions,
      ),
    });
  }
  const now = options.now instanceof Date ? options.now : new Date();
  const {
    errors: exceptionErrors,
    validated: exceptions,
    residuals,
  } = validateExceptions(exceptionConfig, scopes, now);
  const allFindings = parsed.flatMap((entry) => entry.findings);
  const acceptedFindings = [];
  const blockingFindings = [];
  const trackedResiduals = [];
  const untrackedResiduals = [];
  const usedExceptions = new Set();
  const usedResiduals = new Set();
  const uniqueFindings = new Map(
    allFindings.map((finding) => [
      finding.version
        ? residualKey(finding)
        : `${finding.scope}\u0000${finding.reachability}\u0000${finding.package}\u0000${finding.advisory}\u0000${finding.severity}`,
      finding,
    ]),
  );
  for (const finding of uniqueFindings.values()) {
    if (
      finding.reachability === 'production' &&
      RESIDUAL_SEVERITIES.has(finding.severity)
    ) {
      const matchingResidual = residuals.find(
        (residual) => residualKey(residual) === residualKey(finding),
      );
      if (!matchingResidual) {
        untrackedResiduals.push(finding);
        continue;
      }
      usedResiduals.add(matchingResidual);
      if (matchingResidual.severity !== finding.severity) {
        exceptionErrors.push(
          `residual severity mismatch for ${finding.scope}:${finding.package}:${finding.version}:${finding.advisory}: expected ${finding.severity}, got ${matchingResidual.severity}`,
        );
        untrackedResiduals.push(finding);
        continue;
      }
      trackedResiduals.push(finding);
      continue;
    }
    if (!BLOCKING_SEVERITIES.has(finding.severity)) continue;
    const matchingIdentity = exceptions.find(
      (exception) => exceptionKey(exception) === exceptionKey(finding),
    );
    if (!matchingIdentity) {
      blockingFindings.push(finding);
      continue;
    }
    usedExceptions.add(matchingIdentity);
    if (matchingIdentity.severity !== finding.severity) {
      exceptionErrors.push(
        `exception severity mismatch for ${finding.scope}:${finding.package}:${finding.advisory}: expected ${finding.severity}, got ${matchingIdentity.severity}`,
      );
      blockingFindings.push(finding);
      continue;
    }
    acceptedFindings.push(finding);
  }
  for (const exception of exceptions) {
    if (!usedExceptions.has(exception)) {
      exceptionErrors.push(
        `unused exception for ${exception.scope}:${exception.package}:${exception.advisory}`,
      );
    }
  }
  for (const residual of residuals) {
    if (!usedResiduals.has(residual)) {
      exceptionErrors.push(
        `unused residual for ${residual.scope}:${residual.package}:${residual.version}:${residual.advisory}`,
      );
    }
  }
  return {
    ok:
      blockingFindings.length === 0 &&
      untrackedResiduals.length === 0 &&
      exceptionErrors.length === 0,
    scopes: Object.fromEntries(
      parsed.map((entry) => [
        `${entry.scope}/${entry.reachability}`,
        entry.counts,
      ]),
    ),
    blockingFindings,
    acceptedFindings,
    trackedResiduals,
    untrackedResiduals,
    exceptionErrors,
  };
}

export function formatPolicyReport(result) {
  const lines = ['Dependency advisory floor'];
  for (const [scope, counts] of Object.entries(result.scopes)) {
    lines.push(
      `${scope}: critical=${counts.critical} high=${counts.high} moderate=${counts.moderate} low=${counts.low} total=${counts.total}`,
    );
  }
  for (const finding of result.acceptedFindings) {
    lines.push(
      `ACCEPTED ${finding.scope}: ${finding.package} ${finding.advisory} (${finding.severity})`,
    );
  }
  for (const finding of result.trackedResiduals) {
    lines.push(
      `TRACKED ${finding.scope}/${finding.reachability}: ${finding.package}@${finding.version} ${finding.advisory} (${finding.severity})`,
    );
  }
  for (const finding of result.untrackedResiduals) {
    lines.push(
      `UNTRACKED ${finding.scope}/${finding.reachability}: ${finding.package}@${finding.version} ${finding.advisory} (${finding.severity})`,
    );
  }
  for (const finding of result.blockingFindings) {
    lines.push(
      `BLOCKED ${finding.scope}: ${finding.package} ${finding.advisory} (${finding.severity})`,
    );
  }
  for (const error of result.exceptionErrors)
    lines.push(`EXCEPTION ERROR: ${error}`);
  lines.push(
    result.ok
      ? 'PASS: no unaccepted critical/high advisories or production residuals'
      : 'FAIL: dependency advisory floor not met',
  );
  return lines.join('\n');
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `${label} is missing or invalid JSON (${file}): ${error.message}`,
    );
  }
}

const AUDIT_TIMEOUT_MS = 4 * 60 * 1000;
const AUDIT_ATTEMPTS = 2;

export function dependencyAuditDecision({
  env = process.env,
  loadEvent = (eventPath) => JSON.parse(readFileSync(eventPath, 'utf8')),
  classifyRange = classifyGitRange,
  cwd = REPO_ROOT,
} = {}) {
  if (env.GITHUB_ACTIONS !== 'true')
    return {
      required: true,
      reason: 'non-github execution',
      scopes: [...ALL_DEPENDENCY_SCOPES],
    };

  const eventName = env.GITHUB_EVENT_NAME;
  if (
    !['pull_request', 'pull_request_target', 'merge_group', 'push'].includes(
      eventName,
    )
  )
    return {
      required: true,
      reason: `${eventName ?? 'unknown'} event`,
      scopes: [...ALL_DEPENDENCY_SCOPES],
    };

  try {
    if (!env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH is missing');
    const event = loadEvent(env.GITHUB_EVENT_PATH);
    const before = eventName.startsWith('pull_request')
      ? event.pull_request?.base?.sha
      : eventName === 'merge_group'
        ? event.merge_group?.base_sha
        : event.before;
    const after = eventName.startsWith('pull_request')
      ? event.pull_request?.head?.sha
      : eventName === 'merge_group'
        ? event.merge_group?.head_sha
        : (event.after ?? env.GITHUB_SHA);
    const classification = classifyRange({ before, after, cwd });
    return {
      required: classification.dependencies,
      reason: classification.classification,
      // A classifier that does not name scopes is not a classifier that means
      // "none": anything short of an explicit list scans everything.
      scopes: Array.isArray(classification.dependencyScopes)
        ? classification.dependencyScopes
        : [...ALL_DEPENDENCY_SCOPES],
    };
  } catch (error) {
    return {
      required: true,
      reason: `range classification failed closed: ${error.message}`,
      scopes: [...ALL_DEPENDENCY_SCOPES],
    };
  }
}

function runAuditAttempt(scope, cwd, productionOnly) {
  const args = ['audit', '--json'];
  if (productionOnly) args.push('--omit=dev');
  if (scope !== 'root') args.push('--workspaces=false');
  return new Promise((resolveAudit, rejectAudit) => {
    execFile(
      'npm',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
        timeout: AUDIT_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        const status = error
          ? typeof error.code === 'number'
            ? error.code
            : null
          : 0;
        try {
          resolveAudit(
            parseAuditCommandResult(scope, {
              error:
                error && status === null && !error.signal ? error : undefined,
              status,
              signal: error?.signal ?? null,
              stdout,
              stderr,
            }),
          );
        } catch (parseError) {
          rejectAudit(parseError);
        }
      },
    );
  });
}

export async function withAuditRetries(
  scope,
  operation,
  attempts = AUDIT_ATTEMPTS,
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts)
        console.warn(
          `npm audit operational attempt ${attempt}/${attempts} failed for ${scope}; retrying: ${error.message}`,
        );
    }
  }
  throw new Error(
    `npm audit failed for ${scope} after ${attempts} attempts: ${lastError?.message ?? 'unknown error'}`,
  );
}

function runAudit(scope, cwd, productionOnly = false) {
  const lockfile = path.join(cwd, 'package-lock.json');
  try {
    if (!statSync(lockfile).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`committed lockfile is missing for ${scope}: ${lockfile}`);
  }
  return withAuditRetries(scope, () =>
    runAuditAttempt(scope, cwd, productionOnly),
  );
}

export function collectAudits(
  scopes,
  auditRunner = runAudit,
  versionResolver = resolvedVersions,
) {
  const requests = scopes.flatMap(({ scope, cwd }) => [
    { scope, cwd, reachability: 'full', productionOnly: false },
    { scope, cwd, reachability: 'production', productionOnly: true },
  ]);
  return Promise.all(
    requests.map(async ({ scope, cwd, reachability, productionOnly }) => ({
      scope,
      reachability,
      audit: await auditRunner(scope, cwd, productionOnly),
      ...(productionOnly ? { resolvedVersions: versionResolver(cwd) } : {}),
    })),
  );
}

function resolvedVersions(cwd) {
  const lockfile = readJson(path.join(cwd, 'package-lock.json'), 'lockfile');
  const packages = assertRecord(lockfile.packages, 'lockfile packages');
  return Object.fromEntries(
    Object.entries(packages).flatMap(([node, value]) => {
      const version = value?.version;
      return typeof version === 'string' && version.trim() !== ''
        ? [[node, version]]
        : [];
    }),
  );
}

export function parseAuditCommandResult(scope, result) {
  if (result.error)
    throw new Error(
      `npm audit failed to execute for ${scope}: ${result.error.message}`,
    );
  if (
    result.signal ||
    result.status === null ||
    ![0, 1].includes(result.status)
  ) {
    throw new Error(
      `npm audit operational failure for ${scope}: status=${String(result.status)} signal=${String(result.signal ?? 'none')}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    const detail = String(result.stderr || result.stdout || 'no output')
      .trim()
      .slice(0, 500);
    throw new Error(
      `npm audit did not provide parseable JSON for ${scope} (exit ${result.status}): ${detail}`,
    );
  }
  if (
    parsed?.auditReportVersion !== 2 &&
    Object.hasOwn(parsed ?? {}, 'error')
  ) {
    // A registry failure puts its reason in a top-level `message` and leaves
    // `error.summary`/`error.detail` empty strings, so quoting `error` alone
    // reports an operational failure with no reason in it (#1403).
    const reason =
      typeof parsed.message === 'string' && parsed.message.trim() !== ''
        ? { message: parsed.message, error: parsed.error }
        : parsed.error;
    const detail = JSON.stringify(reason).slice(0, 500);
    throw new Error(
      `npm audit operational response for ${scope} (exit ${result.status}): ${detail}`,
    );
  }
  return parsed;
}

export async function runPolicyCli() {
  const decision = dependencyAuditDecision();
  if (!decision.required) {
    console.log(
      `Dependency advisory floor: skipped live registry scan (${decision.reason}; no dependency inputs changed)`,
    );
    return 0;
  }
  const allScopes = [
    { scope: 'root', cwd: REPO_ROOT },
    { scope: 'sdk', cwd: path.join(REPO_ROOT, 'packages', 'sdk') },
    { scope: 'shared', cwd: path.join(REPO_ROOT, 'packages', 'shared') },
  ];
  // Each scope costs TWO concurrent `npm audit` processes (full and
  // production), and `packages/sdk`/`packages/shared` have no installed tree
  // -- the repo installs at the root -- so npm resolves theirs from the
  // registry. Auditing all three ran six registry-bound processes against a
  // four-minute per-call timeout that one of them exceeds on its own; #1417
  // has the measurements. Scanning the scopes whose inputs changed is both
  // cheaper and what `.github/workflows/dependency-advisory.yml` already
  // documents this scan as doing.
  const selected = new Set(decision.scopes ?? allScopes.map((s) => s.scope));
  const scopes = allScopes.filter((entry) => selected.has(entry.scope));
  if (scopes.length === 0) {
    throw new Error(
      `dependency advisory scan selected no scopes (decision: ${decision.reason})`,
    );
  }
  console.log(
    `Dependency advisory floor: scanning ${scopes.map((entry) => entry.scope).join(', ')} (${decision.reason})`,
  );
  const audits = await collectAudits(scopes);
  const exceptions = readJson(
    path.join(SCRIPT_DIR, 'dependency-advisory-exceptions.json'),
    'exception config',
  );
  const result = evaluateAuditPolicy(audits, exceptions);
  console.log(formatPolicyReport(result));
  return result.ok ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    process.exitCode = await runPolicyCli();
  } catch (error) {
    console.error(`Dependency advisory policy error: ${error.message}`);
    process.exitCode = 1;
  }
}
