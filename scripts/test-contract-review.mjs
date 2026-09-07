#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Review signals only: moved assertions and deliberate contract changes are not defects. */
export function collectTestContractReview(diff) {
  const files = new Map();
  let path = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      path = / b\/(.+)$/.exec(line)?.[1] ?? '';
      continue;
    }
    if (
      !path ||
      line.startsWith('+++') ||
      line.startsWith('---') ||
      !/^[+-]/.test(line)
    )
      continue;
    const signals = files.get(path) ?? new Set();
    if (
      path === 'config/product-laws.json' ||
      path.startsWith('docs/design/') ||
      path === '.github/workflows/ci.yml' ||
      path === 'scripts/ci-workflow-governance.mjs'
    )
      signals.add('contract-or-evidence-policy-changed');
    if (
      /(?:^tests\/|\/__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$)/.test(path)
    ) {
      if (
        line[0] === '+' &&
        /\b(?:test|it|describe)\.(?:skip|skipIf|runIf|todo|fixme|only|fail)\b/.test(
          line,
        )
      )
        signals.add('test-selection-changed');
      if (
        line[0] === '-' &&
        /\b(?:expect|assert)\b|\.(?:toBe\w*|toHave\w*|toEqual|not)\b|\bgetByRole\b/.test(
          line,
        )
      )
        signals.add('assertion-or-selector-removed');
    }
    if (signals.size) files.set(path, signals);
  }
  return [...files].map(([path, signals]) => ({
    path,
    signals: [...signals].sort(),
  }));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const outputPath = '.kontourai/veritas/external/test-contract-review.json';
  let report;
  try {
    const base = execFileSync(
      'git',
      [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${process.env.STATION_REVIEW_BASE || 'origin/main'}^{commit}`,
      ],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    const diff = execFileSync(
      'git',
      ['diff', '--no-ext-diff', '--unified=3', base, '--'],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    const findings = collectTestContractReview(diff);
    report = {
      kind: 'station.test-contract-review-advisory',
      blocking: false,
      status: findings.length ? 'REVIEW_NEEDED' : 'NO_SIGNALS',
      base,
      head,
      diffSha256: createHash('sha256').update(diff).digest('hex'),
      findings,
    };
  } catch {
    report = {
      kind: 'station.test-contract-review-advisory',
      blocking: false,
      status: 'NOT_VERIFIED',
      reason: 'The bounded Git diff could not be inspected.',
      findings: [],
    };
  }
  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    const summary = [
      '### Contract-test review (advisory)',
      '',
      `Status: ${report.status}. These signals require review, not automatic rejection.`,
      ...report.findings.map(
        (finding) =>
          `- ${finding.path.replace(/[`\r\n]/g, '')}: ${finding.signals.join(', ')}`,
      ),
      '',
      'For intentional changes, state the product decision and the replacement behavioral evidence in the PR.',
    ];
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `${summary.join('\n')}\n`,
      );
  } catch {
    report.status = 'NOT_VERIFIED';
    console.warn('Contract-test advisory output could not be retained.');
  }
  console.log(
    `Contract-test review: ${report.status}; ${report.findings.length} file(s). ${outputPath}`,
  );
}
