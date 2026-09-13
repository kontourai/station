import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { localLabEnvironment } from './lib/local-collaboration-process.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write(
    'Local collaboration lab: --check=security | --check=accounts | --check=all [--keep]\n' +
      'Security runs real TLS and Station pairing in isolated fixtures. All reports incomplete until Project/compute/plugin integration lands.\n',
  );
} else {
  if (
    args.some(
      (arg) =>
        ![
          '--check=security',
          '--check=accounts',
          '--check=all',
          '--keep',
        ].includes(arg),
    ) ||
    args.filter((arg) => arg.startsWith('--check=')).length !== 1
  )
    throw new Error(
      'Choose --check=security, --check=accounts or --check=all; use --help for scope',
    );
  process.umask(0o077);
  const root = mkdtempSync(join(tmpdir(), 'station-collaboration-lab-'));
  chmodSync(root, 0o700);
  const launchEnvironment = localLabEnvironment();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, launchEnvironment, {
    STATION_HOME: join(root, 'fixture-composition'),
    STATION_ROOT: root,
    STATION_INSTANCE: 'local-collaboration-lab',
    STATION_LOG_LEVEL: 'error',
    OTEL_SDK_DISABLED: 'true',
  });
  const abort = new AbortController();
  const interrupted = () => abort.abort(new Error('Local lab interrupted'));
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  let passed = false;
  try {
    const security = args.includes('--check=accounts')
      ? undefined
      : await (
          await import('./lib/local-collaboration-check.js')
        ).checkLocalCollaborationSecurity(root, abort.signal);
    const accounts = args.includes('--check=security')
      ? undefined
      : await (
          await import('./lib/local-collaboration-accounts.js')
        ).checkLocalCollaborationAccounts(root, abort.signal);
    const result =
      accounts && security
        ? {
            stationIds: [...security.stationIds, ...accounts.stationIds],
            ports: [...new Set([...security.ports, ...accounts.ports])],
            checks: [...security.checks, ...accounts.checks],
          }
        : (accounts ?? security);
    const report = {
      schemaVersion: 1,
      scope: accounts
        ? security
          ? 'local-collaboration-stages'
          : 'account-and-membership-runtime'
        : 'transport-and-enrollment-fixture',
      status: 'passed',
      ...result,
      scenarios: {
        security: security
          ? { status: 'passed', ...security }
          : { status: 'not-run' },
        accounts: accounts
          ? { status: 'passed', ...accounts }
          : { status: 'not-run' },
      },
      fullScenario: {
        status: 'incomplete',
        missing: [
          'shared-Project content and guest UI with approved Device access',
          'offered compute and plugin authorization',
          'production key enrollment and browser/native transport',
          'real two-human/device and tenant-isolation acceptance',
        ],
      },
    };
    writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
    process.stdout.write(
      `STATION_LOCAL_LAB_REPORT ${JSON.stringify(report)}\n`,
    );
    passed = true;
    if (args.includes('--check=all')) process.exitCode = 3;
  } catch (error) {
    // Error messages may contain an assertion's fixture secret. Retain the
    // diagnostic in the owner-only lab home, never echo it into CI logs.
    writeFileSync(join(root, 'failure.txt'), inspect(error, { depth: 5 }), {
      mode: 0o600,
    });
    process.stderr.write(
      'Local lab FAILED; see retained private failure.txt.\n',
    );
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    if (passed && !args.includes('--keep') && !process.exitCode)
      rmSync(root, { recursive: true, force: true });
    else process.stdout.write(`Local lab evidence: ${root}\n`);
  }
}
