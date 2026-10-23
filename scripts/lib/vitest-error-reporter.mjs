import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { redactVerificationOutput } from './verification-redaction.mjs';

const REPORT_LIMIT = 256 * 1024;
const FAILURE_LIMIT = 20;

function text(value, limit = 2048) {
  const redacted = redactVerificationOutput(String(value ?? ''));
  let result = '';
  for (const point of redacted) {
    if (Buffer.byteLength(result) + Buffer.byteLength(point) > limit) break;
    result += point;
  }
  return result;
}

function errorDetails(error, depth = 0) {
  if (!error || typeof error !== 'object') return { message: text(error) };
  const truncatedFields = ['name', 'message', 'stack'].filter((field) => {
    const limit = field === 'name' ? 512 : 2048;
    return (
      (Array.isArray(error.truncatedFields) &&
        error.truncatedFields.includes(field)) ||
      Buffer.byteLength(redactVerificationOutput(String(error[field] ?? ''))) >
        limit
    );
  });
  return {
    name: text(error.name, 512),
    message: text(error.message),
    stack: text(error.stack),
    ...(truncatedFields.length ? { truncatedFields } : {}),
    ...(typeof error.omitted === 'string'
      ? { omitted: text(error.omitted) }
      : {}),
    ...(error.cause !== undefined
      ? {
          cause:
            depth < 2
              ? errorDetails(error.cause, depth + 1)
              : { omitted: 'cause depth exceeds 2' },
        }
      : {}),
  };
}

export function vitestErrorIdentity(file, name) {
  return createHash('sha256')
    .update(JSON.stringify([file, name]))
    .digest('hex');
}

export function readVitestErrorReport(path) {
  try {
    if (statSync(path).size > REPORT_LIMIT)
      return { omitted: 'structured error report exceeds byte limit' };
    const report = JSON.parse(readFileSync(path, 'utf8'));
    if (
      report?.schemaVersion !== 1 ||
      !Array.isArray(report.tests) ||
      report.tests.length > FAILURE_LIMIT ||
      report.tests.some(
        (test) =>
          !/^[a-f0-9]{64}$/.test(test?.id ?? '') ||
          !Array.isArray(test.errors) ||
          test.errors.length > 2,
      )
    )
      return { omitted: 'structured error report is malformed' };
    return {
      schemaVersion: 1,
      omittedTests: report.omittedTests,
      unhandledErrors: Array.isArray(report.unhandledErrors)
        ? report.unhandledErrors.slice(0, 1).map((error) => errorDetails(error))
        : [],
      omittedUnhandledErrors: report.omittedUnhandledErrors,
      tests: report.tests.map((test) => ({
        id: test.id,
        file: text(test.file, 512),
        name: text(test.name, 512),
        duration: test.duration,
        omittedErrors: test.omittedErrors,
        errors: test.errors.map((error) => errorDetails(error)),
      })),
      suites: Array.isArray(report.suites)
        ? report.suites.slice(0, FAILURE_LIMIT).map((suite) => ({
            file: text(suite.file, 512),
            name: text(suite.name, 512),
            errors: (suite.errors ?? [])
              .slice(0, 2)
              .map((error) => errorDetails(error)),
            omittedErrors: suite.omittedErrors,
          }))
        : [],
      omittedSuites: report.omittedSuites ?? 0,
    };
  } catch {
    return { omitted: 'Vitest wrote no readable structured error report' };
  }
}

export default class VitestErrorReporter {
  onInit(context) {
    this.path =
      typeof context.config.outputFile === 'string'
        ? `${context.config.outputFile}.errors.json`
        : undefined;
  }

  onTestRunEnd(modules, unhandledErrors = []) {
    if (!this.path) return;
    const tests = [];
    const suites = [];
    let failed = 0;
    let failedSuites = 0;
    const visit = (task, file) => {
      if (task.type === 'suite' && task.result?.errors?.length) {
        failedSuites += 1;
        const ancestors = [];
        for (let suite = task.suite; suite; suite = suite.suite)
          ancestors.unshift(suite.name);
        const entry = {
          file: text(file, 512),
          name: text([...ancestors, task.name].filter(Boolean).join(' '), 512),
          errors: task.result.errors
            .slice(0, 2)
            .map((error) => errorDetails(error)),
          omittedErrors: Math.max(0, task.result.errors.length - 2),
        };
        if (
          suites.length < FAILURE_LIMIT &&
          Buffer.byteLength(
            JSON.stringify({ tests, suites: [...suites, entry] }),
          ) <
            REPORT_LIMIT - 16384
        ) {
          suites.push(entry);
          process.stderr.write(
            `[test:changed] suite ${entry.name}: ${entry.errors.map((error) => `${error.message}\n${error.stack}`).join('\n')}\n`,
          );
        }
      }
      if (task.type === 'test' && task.result?.state === 'fail') {
        failed += 1;
        if (tests.length < FAILURE_LIMIT) {
          const ancestors = [];
          for (let suite = task.suite; suite; suite = suite.suite)
            ancestors.unshift(suite.name);
          const name = [...ancestors, task.name].filter(Boolean).join(' ');
          const entry = {
            id: vitestErrorIdentity(file, name),
            file: text(file, 512),
            name: text(name, 512),
            duration: task.result.duration,
            errors: (task.result.errors ?? [])
              .slice(0, 2)
              .map((error) => errorDetails(error)),
            omittedErrors: Math.max(0, (task.result.errors?.length ?? 0) - 2),
          };
          if (
            Buffer.byteLength(
              JSON.stringify({ tests: [...tests, entry], suites }),
            ) <
            REPORT_LIMIT - 16384
          )
            tests.push(entry);
        }
      }
      for (const child of task.tasks ?? []) visit(child, file);
    };
    for (const module of modules) visit(module.task, module.task.filepath);
    try {
      writeFileSync(
        this.path,
        `${JSON.stringify({
          schemaVersion: 1,
          tests,
          omittedTests: failed - tests.length,
          suites,
          omittedSuites: failedSuites - suites.length,
          unhandledErrors: unhandledErrors
            .slice(0, 1)
            .map((error) => errorDetails(error)),
          omittedUnhandledErrors: Math.max(0, unhandledErrors.length - 1),
        })}\n`,
      );
    } catch (error) {
      // Companion diagnostics cannot change the JSON reporter's verdict.
      process.stderr.write(
        `[test:changed] could not retain structured errors: ${text(error, 512)}\n`,
      );
    }
  }
}
