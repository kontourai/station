/**
 * Public contribution surfaces are a small, user-facing contract spread over
 * GitHub forms, the PR handoff, contributor routing, ownership, and Pages.
 * Parse those sources here instead of relying on review memory or prose alone.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { BACKLOG_POLICY } from './backlog-priority-policy.mjs';

export const OWNER = '@briananderson1222';
/** Labels only maintainers may apply after they classify the report. */
export const REPORTER_INELIGIBLE_LABELS = Object.freeze([
  ...BACKLOG_POLICY.classificationLabels,
]);
export const TRUST_ROOTS = Object.freeze([
  '.github/CODEOWNERS',
  '.github/ISSUE_TEMPLATE/',
  '.github/pull_request_template.md',
  '.github/workflows/',
  '.github/actionlint.yaml',
  '.github/labels.json',
  'scripts/actionlint-gate.mjs',
  'scripts/ci-workflow-governance.mjs',
  'scripts/dependency-advisory-policy.mjs',
  'scripts/dependency-advisory-exceptions.json',
  'scripts/issue-lifecycle-reducer.mjs',
  'scripts/issue-availability.mjs',
  'scripts/source-availability-driver.mjs',
  'scripts/lib/github-merged-issue-facts.mjs',
  'scripts/label-manifest.mjs',
  'scripts/generate-issue-lifecycle-reference.mjs',
  'scripts/codeql-sarif-policy.mjs',
  'SECURITY.md',
  'docs/privacy-policy.md',
  'docs/guides/dependency-security.md',
  'src-server/services/privacy-inventory.ts',
  'src-server/services/usage-telemetry-inventory.ts',
  'src-desktop/gen/apple/PrivacyInfo.xcprivacy',
  'scripts/apply-android-release-signing.mjs',
  'scripts/check-ios-store-profile.mjs',
  'scripts/check-mobile-package.mjs',
  'scripts/release-artifacts.mjs',
  'scripts/lib/release-artifacts.mjs',
  'scripts/lib/native-release-config.mjs',
  'scripts/native-update-feed.mjs',
  'scripts/verify-android-apk-signature.mjs',
  'scripts/verify-android-aab-signature.mjs',
  'scripts/verify-release-checksums.sh',
  'schemas/release-artifact-manifest.schema.json',
  'src-desktop/tauri.conf.json',
]);

const REQUIRED_CONTACTS = new Map([
  [
    'Security Report',
    'https://github.com/kontourai/station/security/advisories/new',
  ],
  ['Get Support', 'https://kontourai.io/support/'],
  [
    'Contribution Guide',
    'https://github.com/kontourai/station/blob/main/CONTRIBUTING.md',
  ],
]);
const PRIVACY_WARNING = /do not include secrets[\s\S]*unredacted logs/i;
const ROUTES = [
  'Issue-first',
  'Safe-direct',
  'Discuss-first',
  'Support',
  'Security',
];

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readText(path, read) {
  try {
    const content = read(path, 'utf8');
    return typeof content === 'string' ? content : content.toString('utf8');
  } catch {
    return null;
  }
}

export function parseYamlDocument(path, read = readFileSync) {
  const source = readText(path, read);
  if (source === null) return { error: `missing ${path}` };
  try {
    const document = load(source);
    return isRecord(document)
      ? { document, source }
      : { error: `${path} must be a YAML mapping` };
  } catch (error) {
    return { error: `${path} is invalid YAML: ${error.message}` };
  }
}

function bodyEntries(form) {
  return Array.isArray(form.body) ? form.body.filter(isRecord) : [];
}

function fieldById(form, id) {
  return bodyEntries(form).find((entry) => entry.id === id);
}

function requiredField(form, id, findings, formName) {
  const field = fieldById(form, id);
  if (!field) {
    findings.push(`${formName} must include '${id}'.`);
    return;
  }
  if (field.validations?.required !== true) {
    findings.push(`${formName} field '${id}' must be required.`);
  }
}

function serializedForm(form) {
  try {
    return JSON.stringify(form);
  } catch {
    return '';
  }
}

function validateContacts(config, findings) {
  if (config.blank_issues_enabled !== false) {
    findings.push('Issue-template config must disable blank issues.');
  }
  if (!Array.isArray(config.contact_links)) {
    findings.push('Issue-template config must define contact_links.');
    return;
  }
  const contacts = new Map();
  for (const entry of config.contact_links) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== 'string' ||
      typeof entry.url !== 'string'
    ) {
      findings.push(
        'Every issue-template contact link must have string name and url fields.',
      );
      continue;
    }
    contacts.set(entry.name, entry.url);
  }
  for (const [name, url] of REQUIRED_CONTACTS) {
    if (contacts.get(name) !== url) {
      findings.push(
        `Issue-template contact '${name}' must target its canonical route.`,
      );
    }
  }
  if (contacts.size !== REQUIRED_CONTACTS.size) {
    findings.push(
      'Issue-template config must expose exactly security, support, and contribution contacts.',
    );
  }
}

function validateBugForm(form, findings) {
  const source = serializedForm(form);
  if (!PRIVACY_WARNING.test(source)) {
    findings.push(
      'Bug form must warn reporters not to include private or unredacted diagnostics.',
    );
  }
  for (const id of [
    'user-impact',
    'observed-behavior',
    'build-identity',
    'platform-install',
    'frequency',
    'recent-change',
    'redacted-diagnostic',
    'prior-issue',
  ]) {
    requiredField(form, id, findings, 'Bug form');
  }
}

function validateFormLabels(form, formName, findings) {
  if (!Array.isArray(form.labels)) {
    findings.push(`${formName} must define a labels array.`);
    return;
  }
  for (const label of form.labels) {
    const reporterIneligible = REPORTER_INELIGIBLE_LABELS.find(
      (forbidden) =>
        typeof label === 'string' &&
        forbidden.localeCompare(label, undefined, { sensitivity: 'accent' }) ===
          0,
    );
    if (typeof label !== 'string' || reporterIneligible) {
      findings.push(
        reporterIneligible
          ? `${formName} must not assign reporter-ineligible label '${reporterIneligible}'.`
          : `${formName} labels must be strings.`,
      );
      return;
    }
  }
}

function validateFeatureForm(form, findings) {
  const source = serializedForm(form);
  if (!PRIVACY_WARNING.test(source)) {
    findings.push(
      'Feature form must warn reporters not to include private or unredacted diagnostics.',
    );
  }
  for (const id of [
    'problem',
    'workaround',
    'core-or-extension',
    'non-goals',
    'alternatives',
  ]) {
    requiredField(form, id, findings, 'Feature form');
  }
  const solution = fieldById(form, 'proposed-solution');
  if (!solution) {
    findings.push('Feature form must include an optional proposed solution.');
  } else if (solution.validations?.required === true) {
    findings.push('Feature form proposed solution must remain optional.');
  }
  if (
    /\b(?:priority|priorities|prioritize|prioritise|triage|disposition)\b/i.test(
      source,
    )
  ) {
    findings.push(
      'Feature form must not assign priority or disposition fields.',
    );
  }
}

export function parseCodeowners(source) {
  const entries = [];
  const findings = [];
  for (const [index, rawLine] of source.split('\n').entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    if (fields.length !== 2) {
      findings.push(
        `CODEOWNERS line ${index + 1} must contain one path and one owner.`,
      );
      continue;
    }
    entries.push({ line: index + 1, path: fields[0], owner: fields[1] });
  }
  return { entries, findings };
}

function validateCodeowners(source, root, exists, findings) {
  const parsed = parseCodeowners(source);
  findings.push(...parsed.findings);
  const expected = new Set(TRUST_ROOTS);
  const actual = new Set();
  for (const entry of parsed.entries) {
    actual.add(entry.path);
    if (
      entry.path === '/' ||
      entry.path.includes('*') ||
      entry.path.includes('?')
    ) {
      findings.push(
        `CODEOWNERS line ${entry.line} must not use a broad root or wildcard.`,
      );
    }
    if (entry.owner !== OWNER) {
      findings.push(
        `CODEOWNERS line ${entry.line} must be owned only by ${OWNER}.`,
      );
    }
    if (!expected.has(entry.path)) {
      findings.push(
        `CODEOWNERS path '${entry.path}' is not an approved narrow trust root.`,
      );
    }
    if (!exists(resolve(root, entry.path))) {
      findings.push(`CODEOWNERS path '${entry.path}' does not exist.`);
    }
  }
  for (const path of expected) {
    if (!actual.has(path))
      findings.push(`CODEOWNERS is missing trust root '${path}'.`);
  }
  if (actual.size !== parsed.entries.length) {
    findings.push('CODEOWNERS must not duplicate a trust-root entry.');
  }
}

function validatePrTemplate(source, findings) {
  for (const heading of [
    '## User outcome',
    '## Issue and closure condition',
    '## Documentation impact',
    '### Exact commands and receipts',
    '### NOT_VERIFIED',
    '## Personal or manual verification',
    '## Risk and rollback',
    '## AI-assisted work',
  ]) {
    if (!source.includes(heading))
      findings.push(`PR template is missing '${heading}'.`);
  }
  for (const phrase of [
    '| Claim or surface | Owner | Reason |',
    'Material areas affected',
    'Personal inspection performed',
    'Affected public docs and generated sources (exact repository-relative paths):',
    'No documentation impact (explicit reason; do not write "none", "N/A", or leave this blank):',
    'Intentional NOT_VERIFIED platform/UI claims retained or introduced (claim and reason, if applicable):',
  ]) {
    if (!source.includes(phrase))
      findings.push(`PR template is missing '${phrase}'.`);
  }
  if (/\bprompts?\b/i.test(source)) {
    findings.push('PR template must not ask contributors to disclose prompts.');
  }
}

function validateContributing(source, findings) {
  for (const route of ROUTES) {
    if (!source.includes(`| ${route} |`))
      findings.push(`CONTRIBUTING must route '${route}'.`);
  }
  for (const phrase of [
    '`main`',
    'exact commands and receipts',
    'AI tool',
    'NOT_VERIFIED',
    'form rendering',
    'CODEOWNERS ruleset enforcement',
    'external-fork\ndrill',
    'hosted Pages deployment',
  ]) {
    if (!source.includes(phrase))
      findings.push(`CONTRIBUTING must state '${phrase}'.`);
  }
  if (!/external-fork[\s\S]*NOT_VERIFIED/i.test(source)) {
    findings.push(
      'CONTRIBUTING must state the external-fork boundary as NOT_VERIFIED.',
    );
  }
  if (!source.includes('https://kontourai.io/support/')) {
    findings.push(
      'CONTRIBUTING must route support to https://kontourai.io/support/.',
    );
  }
  if (
    !source.includes(
      'https://github.com/kontourai/station/issues/new/choose',
    ) ||
    !source.includes('discussion/architecture proposal')
  ) {
    findings.push(
      'CONTRIBUTING must route discuss-first through the issue chooser.',
    );
  }
  if (source.includes('github.com/kontourai/station/discussions')) {
    findings.push(
      'CONTRIBUTING must not claim GitHub Discussions is available.',
    );
  }
  if (
    /\b(?:priority|priorities|triage|disposition|lifecycle labels?)\b/i.test(
      source,
    )
  ) {
    findings.push('CONTRIBUTING must not prescribe lifecycle labels.');
  }
}

function validatePublicGuide(source, manifest, findings) {
  const matching = Array.isArray(manifest.documents)
    ? manifest.documents.filter(
        (document) =>
          document?.source === 'user/contributing.md' &&
          document?.section === 'Contribute',
      )
    : [];
  if (matching.length !== 1) {
    findings.push(
      'Public docs manifest must admit user/contributing.md exactly once under Contribute.',
    );
  }
  if (
    source.includes('```') ||
    /live (?:issue |delivery |release )?state/i.test(source)
  ) {
    findings.push(
      'Public contribution guide must not duplicate commands or live delivery state.',
    );
  }
  if (!/external-fork[\s\S]*NOT_VERIFIED/i.test(source)) {
    findings.push(
      'Public contribution guide must preserve the external-fork NOT_VERIFIED boundary.',
    );
  }
  if (!source.includes('https://kontourai.io/support/')) {
    findings.push(
      'Public contribution guide must route support to kontourai.io/support/.',
    );
  }
  if (
    !source.includes(
      'https://github.com/kontourai/station/issues/new/choose',
    ) ||
    !source.includes('discussion/architecture proposal')
  ) {
    findings.push(
      'Public contribution guide must route discuss-first through the issue chooser.',
    );
  }
  if (source.includes('github.com/kontourai/station/discussions')) {
    findings.push(
      'Public contribution guide must not claim GitHub Discussions is available.',
    );
  }
}

export function collectPublicContributionSurfaceFindings({
  root = process.cwd(),
  read = readFileSync,
  exists = existsSync,
} = {}) {
  const findings = [];
  const path = (relative) => resolve(root, relative);
  const config = parseYamlDocument(
    path('.github/ISSUE_TEMPLATE/config.yml'),
    read,
  );
  const bug = parseYamlDocument(
    path('.github/ISSUE_TEMPLATE/bug-report.yml'),
    read,
  );
  const feature = parseYamlDocument(
    path('.github/ISSUE_TEMPLATE/feature-request.yml'),
    read,
  );
  for (const [name, parsed] of [
    ['Issue-template config', config],
    ['Bug form', bug],
    ['Feature form', feature],
  ]) {
    if (parsed.error) findings.push(`${name}: ${parsed.error}`);
  }
  if (config.document) validateContacts(config.document, findings);
  if (bug.document) {
    validateBugForm(bug.document, findings);
    validateFormLabels(bug.document, 'Bug form', findings);
  }
  if (feature.document) {
    validateFeatureForm(feature.document, findings);
    validateFormLabels(feature.document, 'Feature form', findings);
  }

  const prTemplate = readText(path('.github/pull_request_template.md'), read);
  if (prTemplate === null)
    findings.push('Missing .github/pull_request_template.md.');
  else validatePrTemplate(prTemplate, findings);

  const contributing = readText(path('CONTRIBUTING.md'), read);
  if (contributing === null) findings.push('Missing CONTRIBUTING.md.');
  else validateContributing(contributing, findings);

  const codeowners = readText(path('.github/CODEOWNERS'), read);
  if (codeowners === null) findings.push('Missing .github/CODEOWNERS.');
  else validateCodeowners(codeowners, root, exists, findings);

  const guide = readText(path('docs/user/contributing.md'), read);
  const manifestSource = readText(path('docs/pages/public-docs.json'), read);
  if (guide === null) findings.push('Missing docs/user/contributing.md.');
  if (manifestSource === null)
    findings.push('Missing docs/pages/public-docs.json.');
  if (guide !== null && manifestSource !== null) {
    try {
      validatePublicGuide(guide, JSON.parse(manifestSource), findings);
    } catch {
      findings.push('docs/pages/public-docs.json must be valid JSON.');
    }
  }
  return findings;
}

function main() {
  const findings = collectPublicContributionSurfaceFindings();
  if (findings.length) {
    console.error('FAIL: public contribution surfaces');
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log('Public contribution surfaces are structurally valid.');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
