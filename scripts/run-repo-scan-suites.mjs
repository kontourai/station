#!/usr/bin/env node
/**
 * Run every whole-tree source scan (`REPO_SCAN_SUITES`, #2176) through the
 * focused runner. The list lives in the impact manifest so this runner, the
 * `repo-scans` CI job and the classification pin cannot disagree about it.
 */
import { runFocusedTests } from './run-focused-tests.mjs';
import { REPO_SCAN_SUITES } from './test-impact-manifest.mjs';

process.exitCode = await runFocusedTests([...REPO_SCAN_SUITES]);
