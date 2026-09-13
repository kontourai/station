import { expect, test } from 'vitest';
import {
  fallowCommands,
  summarizeFallowReports,
} from '../run-fallow-audit.mjs';

test('whole-tree scope uses full analyses instead of the changed-file audit', () => {
  expect(fallowCommands('whole-tree')).toEqual([
    'dead-code',
    'health',
    'dupes',
  ]);
  expect(fallowCommands('changed')).toEqual(['audit']);
  expect(() => fallowCommands('unknown')).toThrow('Unknown');
});

test('missing metrics cannot become zero findings or a clean audit', () => {
  expect(() =>
    summarizeFallowReports('changed', [{ verdict: 'pass', summary: {} }]),
  ).toThrow();
  expect(() =>
    summarizeFallowReports('whole-tree', [
      { summary: {} },
      { summary: {} },
      { stats: {} },
    ]),
  ).toThrow();
  expect(() =>
    summarizeFallowReports('changed', [
      {
        summary: {
          dead_code_issues: 0,
          duplication_clone_groups: 0,
          complexity_findings: 0,
        },
        changed_files_count: 0,
      },
    ]),
  ).toThrow('verdict');
});

test('retains full-tree counts and their estimated-coverage qualification', () => {
  expect(
    summarizeFallowReports('whole-tree', [
      { summary: { total_issues: 12 } },
      {
        summary: {
          functions_above_threshold: 30,
          files_analyzed: 100,
          functions_analyzed: 900,
          coverage_model: 'static_estimated',
        },
      },
      { stats: { clone_groups: 7 } },
    ]),
  ).toEqual({
    dead_code_issues: 12,
    complexity_findings: 30,
    duplication_clone_groups: 7,
    files_analyzed: 100,
    functions_analyzed: 900,
    coverage_model: 'static_estimated',
  });
});
