import {
  type ExecFileOptionsWithStringEncoding,
  execFile,
  execFileSync,
} from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runAuditAttempt,
  withAuditRetries,
} from '../dependency-advisory-policy.mjs';
import { createAuditAttemptDiagnostics } from '../lib/dependency-audit-diagnostics.mjs';

const roots: string[] = [];
function temporary() {
  const root = mkdtempSync(
    path.join(tmpdir(), 'station-audit-diagnostics-test-'),
  );
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function records(root: string, suffix: string) {
  return readdirSync(root)
    .filter((name) => name.endsWith(`.${suffix}.json`))
    .map((name) => JSON.parse(readFileSync(path.join(root, name), 'utf8')));
}
const audit = {
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 0,
    },
  },
};
function runner(script: string, timeout?: number, command = process.execPath) {
  return vi.fn((_command, _args, options, callback) =>
    execFile(
      command,
      ['-e', script],
      {
        ...options,
        ...(timeout === undefined ? {} : { timeout }),
        windowsHide: true,
      },
      callback,
    ),
  );
}

describe('dependency audit attempt diagnostics', () => {
  it('captures actual npm and Node versions using the runner flags on a non-network command', async () => {
    const root = temporary();
    const npmCli = process.env.npm_execpath;
    if (!npmCli || !existsSync(npmCli))
      throw new Error('Run through the repository npm test:focused entry');
    let actualVersion = '';
    const execute = vi.fn(
      (_command, args, options: ExecFileOptionsWithStringEncoding, callback) =>
        execFile(
          process.execPath,
          [
            npmCli,
            '--version',
            ...args.filter(
              (arg: string) =>
                arg === '--timing' ||
                arg.startsWith('--loglevel=') ||
                arg.startsWith('--logs-'),
            ),
          ],
          { ...options, encoding: 'utf8', windowsHide: true },
          (error, stdout, stderr) => {
            actualVersion = stdout.trim();
            callback(error, stdout, stderr);
          },
        ),
    );
    // npm --version is deliberately not an audit document. Parsing still
    // refuses it; only the real child version/diagnostic path is under test.
    await expect(
      runAuditAttempt('sdk', root, false, { execute, diagnosticsRoot: root }),
    ).rejects.toThrow('parseable JSON');
    const terminal = records(root, 'terminal')[0];
    expect(actualVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(terminal.npmVersion).toBe(actualVersion);
    expect(terminal.childNodeVersion).toBe(process.version);
  });

  it('executes the child seam, preserving full/production arguments and audit result', async () => {
    const root = temporary();
    const execute = runner(`
      const fs = require('node:fs');
      const files = fs.readdirSync(${JSON.stringify(root)});
      if (!files.some(f => f.endsWith('.started.json'))) process.exit(99);
      process.stderr.write('npm info using npm@11.19.0\\nnpm info using node@v24.19.0\\n');
      process.stderr.write('npm timing auditReport:getReport Completed in 123ms\\n');
      process.stderr.write('npm timing auditReport:init Completed in 4ms\\n');
      process.stderr.write('npm http fetch POST 200 https://user:secret@registry.example/-/npm/v1/security/advisories/bulk?token=secret 120ms\\n');
      process.stderr.write('npm timing metavuln:packument:private-package Completed in 3ms\\n');
      process.stdout.write(${JSON.stringify(JSON.stringify(audit))});
    `);
    expect(
      await runAuditAttempt('sdk', root, true, {
        execute,
        diagnosticsRoot: root,
      }),
    ).toEqual(audit);
    const [, args, options] = execute.mock.calls[0];
    expect(args.slice(0, 4)).toEqual([
      'audit',
      '--json',
      '--omit=dev',
      '--workspaces=false',
    ]);
    expect(options).toMatchObject({
      timeout: 240000,
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true,
    });
    expect(args).toContain('--logs-max=0');
    expect(args).toContain('--timing');
    expect(args).toContain('--loglevel=info');
    const rawLogs = args
      .find((arg: string) => arg.startsWith('--logs-dir='))
      .slice('--logs-dir='.length);
    expect(rawLogs.startsWith(root)).toBe(false);
    expect(existsSync(rawLogs)).toBe(false);
    const [terminal] = records(root, 'terminal');
    expect(terminal).toMatchObject({
      state: 'settled',
      complete: true,
      status: 0,
      signal: null,
      npmVersion: '11.19.0',
      childNodeVersion: 'v24.19.0',
      completedTimersMs: {
        'auditReport:getReport': 123,
        'auditReport:init': 4,
      },
      bulkResponse: {
        endpoint: 'bulk-advisories',
        status: 200,
        elapsedMs: 120,
      },
      metavulnerability: { packument: { count: 1, totalMs: 3, maxMs: 3 } },
    });
    expect(terminal.elapsedMs).toBeGreaterThan(0);
    const persisted = readdirSync(root)
      .map((file) => readFileSync(path.join(root, file), 'utf8'))
      .join('\n');
    for (const secret of [
      'secret',
      'registry.example',
      'private-package',
      rawLogs,
    ])
      expect(persisted).not.toContain(secret);
  });

  it('retains timeout attempt evidence before the ordinary retry and never invents phase completion', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = temporary();
    const executions: ReturnType<typeof runner>[] = [];
    const result = await withAuditRetries('shared', (attempt: number) => {
      const execute =
        attempt === 1
          ? runner(
              "process.stderr.write('npm timing npm:load Completed in 2ms\\n'); setInterval(() => {}, 1000)",
              200,
            )
          : runner(
              `process.stdout.write(${JSON.stringify(JSON.stringify(audit))})`,
            );
      executions.push(execute);
      return runAuditAttempt('shared', root, false, {
        attempt,
        execute,
        diagnosticsRoot: root,
      });
    });
    expect(result).toEqual(audit);
    const attempts = records(root, 'terminal').sort(
      (a, b) => a.attempt - b.attempt,
    );
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((item) => item.id)).size).toBe(2);
    expect(attempts[0]).toMatchObject({
      attempt: 1,
      status: null,
      signal: 'SIGTERM',
      complete: true,
    });
    expect(attempts[0].elapsedMs).toBeGreaterThanOrEqual(180);
    expect(attempts[0].completedTimersMs).not.toHaveProperty(
      'auditReport:getReport',
    );
    expect(attempts[0].bulkResponse).toBeNull();
    expect(attempts[1]).toMatchObject({ attempt: 2, status: 0 });
    expect(executions).toHaveLength(2);
  });

  it.each([
    { stdout: JSON.stringify(audit), exit: 1, resolves: true },
    { stdout: 'not-json secret', exit: 0, resolves: false },
    { stdout: '', exit: 2, resolves: false },
  ])(
    'does not change parsing or process disposition: $exit/$resolves',
    async ({ stdout, exit, resolves }) => {
      const root = temporary();
      const execute = runner(
        `process.stdout.write(${JSON.stringify(stdout)}); process.exitCode=${exit}`,
      );
      const result = runAuditAttempt('root', root, false, {
        execute,
        diagnosticsRoot: root,
      });
      if (resolves) expect(await result).toEqual(audit);
      else await expect(result).rejects.toThrow();
      expect(records(root, 'terminal')[0].status).toBe(exit);
      expect(records(root, 'terminal')[0].operationalCode).toBeNull();
    },
  );

  it('keeps diagnostics storage failure separate from a successful audit', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = temporary();
    const blocked = path.join(root, 'not-a-directory');
    writeFileSync(blocked, 'fixture');
    expect(
      await runAuditAttempt('sdk', root, false, {
        execute: runner(
          `process.stdout.write(${JSON.stringify(JSON.stringify(audit))})`,
        ),
        diagnosticsRoot: blocked,
      }),
    ).toEqual(audit);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('verdict is unchanged'),
    );
  });

  it('records a real spawn failure without changing its rejected outcome', async () => {
    const root = temporary();
    const execute = runner(
      '',
      undefined,
      path.join(root, 'missing-executable'),
    );
    await expect(
      runAuditAttempt('root', root, false, { execute, diagnosticsRoot: root }),
    ).rejects.toThrow('failed to execute');
    expect(records(root, 'terminal')[0]).toMatchObject({
      status: null,
      operationalCode: 'ENOENT',
    });
  });

  it('caps recognized-event accumulation and retains safe integer totals', () => {
    const root = temporary();
    const diagnostics = createAuditAttemptDiagnostics({
      scope: 'root',
      reachability: 'full',
      attempt: 1,
      outputRoot: root,
      timeoutMs: 240000,
    });
    for (let i = 0; i < 16385; i++)
      diagnostics.consume(
        'npm timing metavuln:packument:private Completed in 999999999ms\n',
      );
    diagnostics.settle({ status: 0, signal: null, operationalCode: undefined });
    const record = records(root, 'terminal')[0];
    expect(record.captureTruncated).toBe(true);
    expect(record.metavulnerability.packument).toEqual({
      count: 16384,
      totalMs: 16384 * 999999999,
      maxMs: 999999999,
    });
    expect(
      Number.isSafeInteger(record.metavulnerability.packument.totalMs),
    ).toBe(true);
    expect(readdirSync(root)).toHaveLength(3);
  });

  it('bounds split and oversized lines before projection, with no raw output retention', () => {
    const root = temporary();
    const diagnostics = createAuditAttemptDiagnostics({
      scope: 'sdk',
      reachability: 'full',
      attempt: 1,
      outputRoot: root,
      timeoutMs: 240000,
    });
    diagnostics.consume('npm timing auditReport:');
    diagnostics.consume('getReport Completed in 7ms\n');
    diagnostics.consume(`token=${'s'.repeat(3000)}`);
    diagnostics.consume('npm timing audit Completed in 99ms\n');
    diagnostics.consume('npm timing auditReport:init Completed in 1ms\n');
    diagnostics.settle({ status: 0, signal: null, operationalCode: undefined });
    const record = records(root, 'terminal')[0];
    expect(record.captureTruncated).toBe(true);
    expect(record.completedTimersMs).toEqual({
      'auditReport:getReport': 7,
      'auditReport:init': 1,
    });
    expect(JSON.stringify(record)).not.toContain('token');
    for (const file of readdirSync(root))
      expect(
        Buffer.byteLength(readFileSync(path.join(root, file))),
      ).toBeLessThanOrEqual(16384);
  });

  it('an owner exiting before settlement leaves started/progress but never a terminal success', () => {
    const root = temporary();
    const module = new URL(
      '../lib/dependency-audit-diagnostics.mjs',
      import.meta.url,
    ).href;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { createAuditAttemptDiagnostics } from ${JSON.stringify(module)};
      const d = createAuditAttemptDiagnostics({ scope: 'root', reachability: 'full', attempt: 1, outputRoot: ${JSON.stringify(root)}, timeoutMs: 240000 });
      d.consume('npm timing npm:load Completed in 2ms\\n');
      process.stdout.write(d.args.find(a => a.startsWith('--logs-dir=')));
      process.exit(0);
    `,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 },
    );
    // Abrupt process.exit bypasses settlement exactly as external termination
    // does. Clean only the fixture's privately returned temp directory.
    const privateLogs = output.slice('--logs-dir='.length);
    roots.push(privateLogs);
    expect(records(root, 'started')).toHaveLength(1);
    expect(records(root, 'progress')[0]).toMatchObject({
      complete: false,
      state: 'incomplete',
    });
    expect(records(root, 'terminal')).toEqual([]);
  });
});
