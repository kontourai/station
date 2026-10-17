import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { invokedDirectly } from './lib/module-entry.mjs';

const KEY = 'STATION_AUTHOR_TELEMETRY_ENDPOINT';
const RELEASE =
  "github.repository == 'kontourai/station' && github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')";
const NIGHTLY =
  "github.repository == 'kontourai/station' && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main' && github.workflow_ref == 'kontourai/station/.github/workflows/nightly.yml@refs/heads/main'";
const NPM =
  "github.repository == 'kontourai/station' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'";
const PORTABLE = `((${RELEASE}) || (${NIGHTLY} && inputs.ring == 'nightly')) && inputs.version != '' && inputs.ring != ''`;
const expression = (condition) => `\${{ ${condition} && vars.${KEY} || '' }}`;

// The allowlist is deliberately at the producer boundary, never workflow-wide:
// release.yml also produces Docker images; this reusable archive job also runs PRs.
const SCOPES = [
  [
    'release.yml',
    'desktop-macos',
    null,
    RELEASE,
    'STATION_CHANNEL',
    `\${{ needs.preflight.outputs.channel }}`,
  ],
  [
    'release.yml',
    'desktop-windows',
    null,
    RELEASE,
    'STATION_CHANNEL',
    `\${{ needs.preflight.outputs.channel }}`,
  ],
  [
    'release.yml',
    'desktop-linux',
    null,
    RELEASE,
    'STATION_CHANNEL',
    `\${{ needs.preflight.outputs.channel }}`,
  ],
  [
    'nightly-native-stage.yml',
    'stage-macos',
    null,
    NIGHTLY,
    'STATION_CHANNEL',
    'nightly',
  ],
  [
    'nightly-native-stage.yml',
    'stage-windows',
    null,
    NIGHTLY,
    'STATION_CHANNEL',
    'nightly',
  ],
  [
    'portable-server-archives.yml',
    'archive',
    'Build server and UI',
    PORTABLE,
    'STATION_CHANNEL',
    `\${{ inputs.ring }}`,
  ],
  [
    'portable-server-archives.yml',
    'archive',
    'Build the archive',
    PORTABLE,
    'RELEASE_RING',
    `\${{ inputs.ring }}`,
  ],
  [
    'publish-packages.yml',
    'publish',
    'Build CLI',
    NPM,
    'STATION_CLI_BUILD_CHANNEL',
    'stable',
  ],
  [
    'nightly.yml',
    'nightly-cli',
    'Build exact-SHA CLI nightly identity',
    NIGHTLY,
    'STATION_CLI_BUILD_CHANNEL',
    'nightly',
  ],
];

export function authorTelemetryWorkflowFindings(workflows) {
  const findings = [];
  const admitted = new Set();
  for (const [
    name,
    jobId,
    stepName,
    condition,
    channelKey,
    channel,
  ] of SCOPES) {
    const file = `.github/workflows/${name}`;
    const workflow = workflows.find((entry) => entry.file === file);
    const job = workflow?.document?.jobs?.[jobId];
    const scope = stepName
      ? job?.steps?.find((step) => step.name === stepName)
      : job;
    if (
      scope?.env?.[KEY] !== expression(condition) ||
      scope?.env?.[channelKey] !== channel
    ) {
      findings.push(
        `${file} ${jobId}/${stepName ?? 'env'}: author endpoint or build channel is missing or not release-gated`,
      );
    }
    if (scope?.env) admitted.add(scope.env);
  }
  for (const { file, document } of workflows) {
    function visit(value, path = '') {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (
          key.includes(KEY) ||
          (typeof child === 'string' && child.includes(KEY))
        ) {
          if (!(key === KEY && admitted.has(value))) {
            findings.push(
              `${file}${path}/${key}: author endpoint leaks outside an official producer`,
            );
          }
        }
        visit(child, `${path}/${key}`);
      }
    }
    visit(document);
  }
  return findings;
}

if (invokedDirectly(import.meta.url)) {
  const root = resolve(process.argv[2] || resolve(import.meta.dirname, '..'));
  const directory = join(root, '.github/workflows');
  const workflows = readdirSync(directory)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => ({
      file: `.github/workflows/${file}`,
      document: load(readFileSync(join(directory, file), 'utf8')),
    }));
  const findings = authorTelemetryWorkflowFindings(workflows);
  for (const finding of findings) console.error(finding);
  console.log(
    `Author telemetry workflow guard: ${findings.length ? 'FAIL' : 'PASS'}`,
  );
  process.exitCode = findings.length ? 1 : 0;
}
