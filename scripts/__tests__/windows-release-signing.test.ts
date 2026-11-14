import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import {
  assertWindowsReleaseSigningReceipt,
  createWindowsReleaseSigningReceipt,
  windowsPlatformSigningClaim,
  windowsReleaseSigningMode,
} from '../lib/windows-release-signing.mjs';

/**
 * #3591: tagged releases ship the Windows MSI unsigned when no Authenticode
 * credentials exist, refuse partial or unsupported signing authority, and
 * keep the certificate path's Valid requirement. The workflow cases run the
 * desktop-windows bash steps from release.yml itself as child processes.
 */

const root = resolve(import.meta.dirname, '../..');
const TAG = 'v1.2.3';
const SHA = 'a'.repeat(40);
const THUMBPRINT = 'A1'.repeat(20);
const temporaryRoots: string[] = [];
/** A GitHub Actions expression exactly as release.yml spells it. */
const gh = (expression: string) => ['$', '{{ ', expression, ' }}'].join('');

type Step = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
};

const releaseWorkflow = load(
  readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8'),
) as { jobs: Record<string, { steps: Step[] }> };
const windowsJob = releaseWorkflow.jobs['desktop-windows'];

function step(name: string): Step {
  const found = windowsJob.steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing desktop-windows step ${name}`);
  return found;
}

const DECIDE = 'Decide the Windows Authenticode signing mode';
const IMPORT = 'Import Windows Authenticode certificate';
const VERIFY =
  'Verify Windows Authenticode signature and versioned build output';
const STAGE = 'Stage canonical Windows artifacts and their signing receipt';
const UPDATER = 'Fail closed and create tag-bound updater configuration';

function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'station-windows-signing-'));
  temporaryRoots.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** Run a release.yml step the way `shell: bash` does on the runner. */
function runStep(script: string, cwd: string, env: Record<string, string>) {
  return spawnSyncBounded(
    'bash',
    ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      env: { PATH: process.env.PATH ?? '', HOME: cwd, ...env },
    },
  );
}

describe('windowsReleaseSigningMode', () => {
  it.each([
    [{}, 'unsigned'],
    [
      { WINDOWS_CERTIFICATE_BASE64: '  ', WINDOWS_CERTIFICATE_PASSWORD: '' },
      'unsigned',
    ],
    [
      { WINDOWS_CERTIFICATE_BASE64: 'cGZ4', WINDOWS_CERTIFICATE_PASSWORD: 'p' },
      'certificate',
    ],
  ])('derives the mode from %j', (env, mode) => {
    expect(windowsReleaseSigningMode(env)).toBe(mode);
  });

  it.each([
    [{ WINDOWS_CERTIFICATE_BASE64: 'cGZ4' }, 'only WINDOWS_CERTIFICATE_BASE64'],
    [
      { WINDOWS_CERTIFICATE_PASSWORD: 'p' },
      'only WINDOWS_CERTIFICATE_PASSWORD',
    ],
    [{ WINDOWS_SIGN_COMMAND: 'sign %1' }, 'WINDOWS_SIGN_COMMAND is configured'],
    [
      {
        WINDOWS_SIGN_COMMAND: 'sign %1',
        WINDOWS_CERTIFICATE_BASE64: 'cGZ4',
        WINDOWS_CERTIFICATE_PASSWORD: 'p',
      },
      'WINDOWS_SIGN_COMMAND is configured',
    ],
  ])('refuses partially configured authority %j', (env, message) => {
    expect(() => windowsReleaseSigningMode(env)).toThrow(message);
  });
});

describe('Windows release signing receipt', () => {
  const base = {
    tag: TAG,
    sourceSha: SHA,
    installer: `station-${TAG}-windows-x86_64.msi`,
    installerSha256: 'c'.repeat(64),
  };

  it('records NOT_SIGNED only for an unsigned-mode MSI Windows reports as NotSigned', () => {
    const receipt = createWindowsReleaseSigningReceipt({
      ...base,
      mode: 'unsigned',
      authenticodeStatus: 'NotSigned',
      signerThumbprint: null,
    });
    expect(receipt).toMatchObject({
      platformSigningState: 'NOT_SIGNED',
      signerThumbprint: null,
    });
    expect(windowsPlatformSigningClaim(receipt)).toEqual({
      state: 'unsigned',
      proof: 'not-applicable',
    });
  });

  it('records VERIFIED only for a Valid signature with its signer', () => {
    const receipt = createWindowsReleaseSigningReceipt({
      ...base,
      mode: 'certificate',
      authenticodeStatus: 'Valid',
      signerThumbprint: THUMBPRINT,
    });
    expect(receipt.platformSigningState).toBe('VERIFIED');
    expect(windowsPlatformSigningClaim(receipt)).toEqual({
      state: 'signed',
      proof: 'platform-signature',
    });
  });

  it.each([
    ['certificate', 'NotSigned', THUMBPRINT],
    ['certificate', 'HashMismatch', THUMBPRINT],
    ['certificate', 'Valid', null],
    ['unsigned', 'Valid', null],
    ['unsigned', 'UnknownError', null],
  ])('refuses %s mode with status %s', (mode, status, thumbprint) => {
    expect(() =>
      createWindowsReleaseSigningReceipt({
        ...base,
        mode,
        authenticodeStatus: status,
        signerThumbprint: thumbprint,
      }),
    ).toThrow('Windows release signing');
  });

  it('binds the receipt to the release installer bytes', () => {
    const receipt = createWindowsReleaseSigningReceipt({
      ...base,
      mode: 'unsigned',
      authenticodeStatus: 'NotSigned',
      signerThumbprint: null,
    });
    expect(() =>
      assertWindowsReleaseSigningReceipt(receipt, {
        tag: TAG,
        sourceSha: SHA,
        installerSha256: 'd'.repeat(64),
      }),
    ).toThrow('does not bind this release installer');
    expect(() =>
      assertWindowsReleaseSigningReceipt(
        { ...receipt, platformSigningState: 'VERIFIED' },
        { tag: TAG, sourceSha: SHA, installerSha256: base.installerSha256 },
      ),
    ).toThrow('does not bind this release installer');
  });
});

describe('release.yml desktop-windows Authenticode steps', () => {
  function decide(env: Record<string, string>) {
    const runnerTemp = temporary();
    const output = join(runnerTemp, 'output');
    const summary = join(runnerTemp, 'summary');
    writeFileSync(output, '');
    writeFileSync(summary, '');
    const result = runStep(step(DECIDE).run as string, root, {
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      ...env,
    });
    const config = join(runnerTemp, 'tauri.windows.release.conf.json');
    return {
      result,
      output: readFileSync(output, 'utf8'),
      summary: readFileSync(summary, 'utf8'),
      config: existsSync(config) ? readFileSync(config, 'utf8') : null,
    };
  }

  it('wires the protected Windows authority into the decision step only', () => {
    expect(step(DECIDE)).toMatchObject({
      id: 'windows-signing',
      env: {
        WINDOWS_SIGN_COMMAND: gh('vars.WINDOWS_SIGN_COMMAND'),
        WINDOWS_CERTIFICATE_BASE64: gh('secrets.WINDOWS_CERTIFICATE_BASE64'),
        WINDOWS_CERTIFICATE_PASSWORD: gh(
          'secrets.WINDOWS_CERTIFICATE_PASSWORD',
        ),
      },
    });
    expect(step(IMPORT).if).toBe(
      gh("steps.windows-signing.outputs.mode == 'certificate'"),
    );
    const order = [UPDATER, DECIDE, IMPORT, VERIFY, STAGE].map((name) =>
      windowsJob.steps.findIndex((candidate) => candidate.name === name),
    );
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it('builds unsigned and records NOT_SIGNED when no credentials exist', () => {
    const { result, output, summary, config } = decide({});
    expect(result.status, result.stderr).toBe(0);
    expect(output).toBe('mode=unsigned\n');
    expect(summary).toContain('NOT_SIGNED');
    // tauri-action still receives --config for this file; it must sign nothing.
    expect(config).toBe('{}\n');
  });

  it('keeps the certificate path when both credentials exist', () => {
    const { result, output, config } = decide({
      WINDOWS_CERTIFICATE_BASE64: 'cGZ4',
      WINDOWS_CERTIFICATE_PASSWORD: 'secret',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(output).toBe('mode=certificate\n');
    expect(config).toBeNull();
  });

  it.each([
    [{ WINDOWS_CERTIFICATE_BASE64: 'cGZ4' }],
    [{ WINDOWS_CERTIFICATE_PASSWORD: 'secret' }],
    [{ WINDOWS_SIGN_COMMAND: 'signtool sign %1' }],
  ])('fails closed for partial authority %j', (env) => {
    const { result, output, config } = decide(env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Windows release signing');
    expect(output).toBe('');
    expect(config).toBeNull();
  });

  it('keeps every Tauri updater secret mandatory', () => {
    const updater = step(UPDATER);
    expect(Object.keys(updater.env ?? {}).sort()).toEqual([
      'TAURI_SIGNING_PRIVATE_KEY',
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
      'TAURI_SIGNING_PUBLIC_KEY',
    ]);
    const loop = (updater.run as string).slice(
      0,
      (updater.run as string).indexOf('done') + 'done'.length,
    );
    const present = {
      TAURI_SIGNING_PRIVATE_KEY: 'k',
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'p',
      TAURI_SIGNING_PUBLIC_KEY: 'pub',
    };
    expect(runStep(loop, root, present).status).toBe(0);
    for (const name of Object.keys(present)) {
      const missing = runStep(loop, root, { ...present, [name]: '' });
      expect(missing.status, name).not.toBe(0);
      expect(missing.stderr).toContain(
        `Missing required protected secret: ${name}`,
      );
    }
  });

  it('verifies Valid for certificate mode and NotSigned for unsigned mode', () => {
    // pwsh is not executed here (NOT_VERIFIED locally); pin each branch.
    const verify = step(VERIFY);
    expect(verify.env).toEqual({
      WINDOWS_SIGNING_MODE: gh('steps.windows-signing.outputs.mode'),
    });
    expect(verify.run).toContain(
      "if ($env:WINDOWS_SIGNING_MODE -eq 'certificate') {\n  if ($signature.Status -ne 'Valid')",
    );
    expect(verify.run).toContain(
      "} elseif ($env:WINDOWS_SIGNING_MODE -eq 'unsigned') {\n  if ($signature.Status -ne 'NotSigned')",
    );
    expect(verify.run).toContain(
      '} else { throw "Unknown Windows signing mode',
    );
  });

  it('publishes the draft with notes derived from the validated inventory', () => {
    const steps = releaseWorkflow.jobs['assemble-draft'].steps;
    const index = (name: string) =>
      steps.findIndex((candidate) => candidate.name === name);
    const create =
      steps[index('Create exactly one draft and upload validated assets')];
    const notes =
      'node scripts/release-artifacts.mjs draft-notes --inventory release-assets/station-release-inventory.json --output "$RUNNER_TEMP/station-release-notes.md"';
    expect(create.run).toContain(notes);
    expect(create.run).toContain(
      '--notes-file "$RUNNER_TEMP/station-release-notes.md"',
    );
    expect((create.run as string).indexOf(notes)).toBeLessThan(
      (create.run as string).indexOf('gh release create'),
    );
    expect(
      index('Assemble and validate one deterministic inventory'),
    ).toBeLessThan(
      index('Create exactly one draft and upload validated assets'),
    );
  });

  describe('staging the MSI-bound receipt', () => {
    function stage(env: Record<string, string>) {
      const workspace = temporary();
      symlinkSync(resolve(root, 'scripts'), join(workspace, 'scripts'));
      const bundle = join(
        workspace,
        'src-desktop/target/x86_64-pc-windows-msvc/release/bundle/msi',
      );
      mkdirSync(bundle, { recursive: true });
      const msi = Buffer.from('msi bytes\n');
      writeFileSync(join(bundle, 'Station_1.2.3_x64_en-US.msi'), msi);
      writeFileSync(join(bundle, 'Station_1.2.3_x64_en-US.msi.zip'), 'zip\n');
      writeFileSync(
        join(bundle, 'Station_1.2.3_x64_en-US.msi.zip.sig'),
        'sig\n',
      );
      const summary = join(workspace, 'summary');
      writeFileSync(summary, '');
      const result = runStep(step(STAGE).run as string, workspace, {
        RELEASE_TAG: TAG,
        RELEASE_SHA: SHA,
        GITHUB_STEP_SUMMARY: summary,
        SIGNER_THUMBPRINT: '',
        ...env,
      });
      const receipt = join(
        workspace,
        `release-assets/station-${TAG}-windows-x86_64-signing.json`,
      );
      return {
        result,
        summary: readFileSync(summary, 'utf8'),
        receipt: existsSync(receipt)
          ? JSON.parse(readFileSync(receipt, 'utf8'))
          : null,
        msiSha256: createHash('sha256').update(msi).digest('hex'),
      };
    }

    it('takes the mode and observed status from the earlier steps', () => {
      expect(step(STAGE).env).toMatchObject({
        WINDOWS_SIGNING_MODE: gh('steps.windows-signing.outputs.mode'),
        AUTHENTICODE_STATUS: gh('steps.windows-authenticode.outputs.status'),
        SIGNER_THUMBPRINT: gh('steps.windows-authenticode.outputs.thumbprint'),
      });
      expect(step(VERIFY).id).toBe('windows-authenticode');
    });

    it('stages a NOT_SIGNED receipt for an unsigned build', () => {
      const { result, summary, receipt, msiSha256 } = stage({
        WINDOWS_SIGNING_MODE: 'unsigned',
        AUTHENTICODE_STATUS: 'NotSigned',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(receipt).toMatchObject({
        tag: TAG,
        sourceSha: SHA,
        installer: `station-${TAG}-windows-x86_64.msi`,
        installerSha256: msiSha256,
        signingMode: 'unsigned',
        platformSigningState: 'NOT_SIGNED',
        signerThumbprint: null,
      });
      expect(summary).toContain('platformSigningState=NOT_SIGNED');
    });

    it('stages a VERIFIED receipt for a certificate-signed build', () => {
      const { result, receipt } = stage({
        WINDOWS_SIGNING_MODE: 'certificate',
        AUTHENTICODE_STATUS: 'Valid',
        SIGNER_THUMBPRINT: THUMBPRINT,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(receipt).toMatchObject({
        platformSigningState: 'VERIFIED',
        signerThumbprint: THUMBPRINT,
      });
    });

    it.each([
      ['unsigned', 'Valid', THUMBPRINT],
      ['certificate', 'NotSigned', ''],
      ['', 'NotSigned', ''],
    ])(
      'refuses mode %j with observed status %s',
      (mode, status, thumbprint) => {
        const { result, receipt } = stage({
          WINDOWS_SIGNING_MODE: mode,
          AUTHENTICODE_STATUS: status,
          SIGNER_THUMBPRINT: thumbprint,
        });
        expect(result.status).not.toBe(0);
        expect(receipt).toBeNull();
      },
    );
  });
});
