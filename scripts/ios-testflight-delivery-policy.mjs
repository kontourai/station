import { writeFileSync } from 'node:fs';

export const INTERNAL_TESTFLIGHT_ENVIRONMENTS = Object.freeze({
  stable: 'native-release',
  beta: 'ios-beta',
  nightly: 'ios-nightly',
});
export const INTERNAL_TESTFLIGHT_TAG_PATTERN = 'refs/tags/ios-testflight/**';

function fail(message) {
  throw new Error(`Internal iOS TestFlight admission failed: ${message}`);
}

function exactMainPolicy(policy) {
  return policy?.name === 'main' && policy?.type === 'branch';
}

export function assertEnvironmentAdmissions(environments) {
  const receipts = [];
  for (const [channel, name] of Object.entries(
    INTERNAL_TESTFLIGHT_ENVIRONMENTS,
  )) {
    const environment = environments?.[name];
    if (
      environment?.deployment_branch_policy?.protected_branches !== false ||
      environment?.deployment_branch_policy?.custom_branch_policies !== true
    ) {
      fail(`${name} must use explicit custom deployment branch policies`);
    }
    if (
      !Array.isArray(environment?.branch_policies) ||
      !environment.branch_policies.some(exactMainPolicy)
    ) {
      fail(
        `${name} does not admit refs/heads/main, which is the dispatch ref for ${channel}`,
      );
    }
    receipts.push({
      channel,
      environment: name,
      dispatchRef: 'refs/heads/main',
    });
  }
  return receipts;
}

export function assertInternalTagRuleset(rulesets) {
  const matches = (Array.isArray(rulesets) ? rulesets : []).filter(
    (ruleset) =>
      ruleset?.target === 'tag' &&
      ruleset?.enforcement === 'active' &&
      Array.isArray(ruleset?.conditions?.ref_name?.include) &&
      ruleset.conditions.ref_name.include.includes(
        INTERNAL_TESTFLIGHT_TAG_PATTERN,
      ) &&
      Array.isArray(ruleset?.conditions?.ref_name?.exclude) &&
      ruleset.conditions.ref_name.exclude.length === 0 &&
      Array.isArray(ruleset?.bypass_actors) &&
      ruleset.bypass_actors.length === 0,
  );
  if (matches.length !== 1)
    fail(
      `expected exactly one active, unbypassed tag ruleset covering ${INTERNAL_TESTFLIGHT_TAG_PATTERN}; found ${matches.length}`,
    );
  const types = new Set(
    Array.isArray(matches[0].rules)
      ? matches[0].rules.map((rule) => rule?.type)
      : [],
  );
  for (const required of ['non_fast_forward', 'deletion']) {
    if (!types.has(required))
      fail(
        `tag ruleset for ${INTERNAL_TESTFLIGHT_TAG_PATTERN} is missing ${required}`,
      );
  }
  return {
    id: matches[0].id,
    name: matches[0].name,
    pattern: INTERNAL_TESTFLIGHT_TAG_PATTERN,
  };
}

async function request(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`GitHub API ${path} returned HTTP ${response.status}`);
  return response.json();
}

export async function observeDeliveryAdmission({ repository, token }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    fail('repository must be owner/name');
  if (!token) fail('GitHub token is required');
  const environments = {};
  for (const name of Object.values(INTERNAL_TESTFLIGHT_ENVIRONMENTS)) {
    const environment = await request(
      `/repos/${repository}/environments/${encodeURIComponent(name)}`,
      token,
    );
    const policies = await request(
      `/repos/${repository}/environments/${encodeURIComponent(name)}/deployment-branch-policies`,
      token,
    );
    environments[name] = {
      ...environment,
      branch_policies: policies.branch_policies,
    };
  }
  const listed = await request(`/repos/${repository}/rulesets`, token);
  const details = await Promise.all(
    listed.map((ruleset) =>
      request(`/repos/${repository}/rulesets/${ruleset.id}`, token),
    ),
  );
  return {
    environments: assertEnvironmentAdmissions(environments),
    tagRuleset: assertInternalTagRuleset(details),
  };
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repository = option(process.argv, 'repository');
  const output = option(process.argv, 'output');
  if (!repository || !output)
    throw new Error('usage: --repository <owner/name> --output <path>');
  observeDeliveryAdmission({ repository, token: process.env.GITHUB_TOKEN })
    .then((receipt) =>
      writeFileSync(
        output,
        `${JSON.stringify({ schemaVersion: 1, kind: 'ios-testflight-delivery-admission', ...receipt }, null, 2)}\n`,
        { mode: 0o600 },
      ),
    )
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
