import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import {
  assertWindowsReleaseSigningReceipt,
  createWindowsReleaseSigningReceipt,
  decideWindowsAuthenticode,
  windowsPlatformSigningClaim,
  windowsReleaseSigningMode,
} from '../lib/windows-release-signing.mjs';

/**
 * #3591: tagged releases ship the Windows MSI unsigned when no Authenticode
 * credentials exist, refuse partial or unsupported signing authority, and
 * keep the certificate path's Valid requirement. The workflow cases run the
 * desktop-windows bash steps from release.yml itself as child processes; the
 * PowerShell observation step runs for real against signed and unsigned files
 * in windows-release-authenticode.process.test.ts (Windows only).
 */

const root = resolve(import.meta.dirname, '../..');
const TAG = 'v1.2.3';
const SHA = 'a'.repeat(40);
const THUMBPRINT = 'A1'.repeat(20);
const OTHER_THUMBPRINT = 'B2'.repeat(20);
const MSI_SHA256 = 'c'.repeat(64);

/** The record release.yml's observation step writes (ConvertTo-Json shape). */
function observation(
  authenticodeStatus: string,
  signerThumbprint: string | null,
  installerSha256 = MSI_SHA256,
) {
  return {
    installer:
      'D:\\a\\station\\src-desktop\\target\\x86_64-pc-windows-msvc\\release\\bundle\\msi\\Station_1.2.3_x64_en-US.msi',
    installerSha256,
    authenticodeStatus,
    statusMessage: `Status ${authenticodeStatus}`,
    signerThumbprint,
  };
}
/** A GitHub Actions expression exactly as release.yml spells it. */
const gh = (expression: string) => ['$', '{{ ', expression, ' }}'].join('');

type Step = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  shell?: string;
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
const OBSERVE = 'Observe Windows Authenticode signature';
const PROVENANCE = 'Verify versioned MSI build provenance';
const STAGE = 'Stage canonical Windows artifacts and their signing receipt';
const UPDATER = 'Fail closed and create tag-bound updater configuration';

const makeTempDir = trackTempDirs();
const temporary = () => makeTempDir('station-windows-signing-');

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

describe('decideWindowsAuthenticode', () => {
  it('accepts NotSigned with no signer in unsigned mode', () => {
    expect(
      decideWindowsAuthenticode({
        mode: 'unsigned',
        observation: observation('NotSigned', null),
      }),
    ).toEqual({
      authenticodeStatus: 'NotSigned',
      platformSigningState: 'NOT_SIGNED',
      signerThumbprint: null,
      installerSha256: MSI_SHA256,
    });
  });

  it('accepts Valid only when the imported certificate signed it', () => {
    expect(
      decideWindowsAuthenticode({
        mode: 'certificate',
        observation: observation('Valid', THUMBPRINT),
        expectedThumbprint: THUMBPRINT,
      }),
    ).toMatchObject({
      platformSigningState: 'VERIFIED',
      signerThumbprint: THUMBPRINT,
    });
    expect(() =>
      decideWindowsAuthenticode({
        mode: 'certificate',
        observation: observation('Valid', OTHER_THUMBPRINT),
        expectedThumbprint: THUMBPRINT,
      }),
    ).toThrow('not the imported release certificate');
    expect(() =>
      decideWindowsAuthenticode({
        mode: 'certificate',
        observation: observation('Valid', THUMBPRINT),
      }),
    ).toThrow('requires the imported release certificate thumbprint');
  });

  // Every status Get-AuthenticodeSignature can report other than the one a
  // mode expects refuses, signed or not.
  it.each([
    'HashMismatch',
    'NotTrusted',
    'UnknownError',
    'NotSupportedFileFormat',
    'Incompatible',
  ])('refuses %s in both modes', (status) => {
    expect(() =>
      decideWindowsAuthenticode({
        mode: 'certificate',
        observation: observation(status, THUMBPRINT),
        expectedThumbprint: THUMBPRINT,
      }),
    ).toThrow(
      `certificate mode requires Authenticode status Valid, observed "${status}"`,
    );
    expect(() =>
      decideWindowsAuthenticode({
        mode: 'unsigned',
        observation: observation(status, null),
      }),
    ).toThrow(
      `unsigned mode requires Authenticode status NotSigned, observed "${status}"`,
    );
  });

  it('refuses NotSigned in certificate mode and Valid in unsigned mode', () => {
    expect(() =>
      decideWindowsAuthenticode({
        mode: 'certificate',
        observation: observation('NotSigned', null),
        expectedThumbprint: THUMBPRINT,
      }),
    ).toThrow('observed "NotSigned"');
    expect(() =>
      decideWindowsAuthenticode({
        mode: 'unsigned',
        observation: observation('Valid', THUMBPRINT),
      }),
    ).toThrow('observed "Valid"');
  });

  it('refuses a signer in unsigned mode and an unknown mode', () => {
    expect(() =>
      decideWindowsAuthenticode({
        mode: 'unsigned',
        observation: observation('NotSigned', THUMBPRINT),
      }),
    ).toThrow('unsigned mode observed signer');
    expect(() =>
      decideWindowsAuthenticode({
        mode: '',
        observation: observation('NotSigned', null),
      }),
    ).toThrow('unknown signing mode ""');
  });

  it.each([
    ['a missing field', { authenticodeStatus: 'NotSigned' }],
    ['an extra field', { ...observation('NotSigned', null), verdict: 'ok' }],
    ['an upper-case hash', observation('NotSigned', null, 'C'.repeat(64))],
    [
      'a numeric status',
      { ...observation('NotSigned', null), authenticodeStatus: 2 },
    ],
    ['an empty status', observation('', null)],
    ['no record', null],
  ])('refuses an observation with %s', (_label, value) => {
    expect(() =>
      decideWindowsAuthenticode({ mode: 'unsigned', observation: value }),
    ).toThrow('Authenticode observation is malformed');
  });
});

describe('Windows release signing receipt', () => {
  const base = {
    tag: TAG,
    sourceSha: SHA,
    installer: `station-${TAG}-windows-x86_64.msi`,
    installerSha256: MSI_SHA256,
  };

  it('records NOT_SIGNED only for an unsigned-mode MSI Windows reports as NotSigned', () => {
    const receipt = createWindowsReleaseSigningReceipt({
      ...base,
      mode: 'unsigned',
      observation: observation('NotSigned', null),
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
      observation: observation('Valid', THUMBPRINT),
      expectedThumbprint: THUMBPRINT,
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
        observation: observation(status, thumbprint),
        expectedThumbprint: THUMBPRINT,
      }),
    ).toThrow('Windows release signing');
  });

  it('refuses an observation of different MSI bytes', () => {
    expect(() =>
      createWindowsReleaseSigningReceipt({
        ...base,
        mode: 'unsigned',
        observation: observation('NotSigned', null, 'd'.repeat(64)),
      }),
    ).toThrow('not the staged installer');
  });

  it('binds the receipt to the release installer bytes', () => {
    const receipt = createWindowsReleaseSigningReceipt({
      ...base,
      mode: 'unsigned',
      observation: observation('NotSigned', null),
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
    expect(step(IMPORT)).toMatchObject({
      id: 'windows-certificate',
      if: gh("steps.windows-signing.outputs.mode == 'certificate'"),
    });
    expect(step(IMPORT).run).toContain(
      '"thumbprint=$($imported.Thumbprint)" | Out-File -FilePath $env:GITHUB_OUTPUT',
    );
    const order = [UPDATER, DECIDE, IMPORT, OBSERVE, PROVENANCE, STAGE].map(
      (name) =>
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

  it('feeds the observation step the mode and the imported signer', () => {
    // The step's behaviour runs under real pwsh in
    // windows-release-authenticode.process.test.ts; only its wiring is here.
    expect(step(OBSERVE)).toMatchObject({
      id: 'windows-authenticode',
      shell: 'pwsh',
      env: {
        WINDOWS_SIGNING_MODE: gh('steps.windows-signing.outputs.mode'),
        EXPECTED_SIGNER_THUMBPRINT: gh(
          'steps.windows-certificate.outputs.thumbprint',
        ),
      },
    });
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
    expect(create.run).toContain('--notes-file "$RUNNER_TEMP/server-notes.md"');
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
    function stage(
      status: string,
      thumbprint: string | null,
      env: Record<string, string>,
      observedSha256?: string,
    ) {
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
      const msiSha256 = createHash('sha256').update(msi).digest('hex');
      const observed = join(workspace, 'station-windows-authenticode.json');
      writeFileSync(
        observed,
        JSON.stringify(
          observation(status, thumbprint, observedSha256 ?? msiSha256),
          null,
          2,
        ),
      );
      const result = runStep(step(STAGE).run as string, workspace, {
        RELEASE_TAG: TAG,
        RELEASE_SHA: SHA,
        GITHUB_STEP_SUMMARY: summary,
        AUTHENTICODE_OBSERVATION: observed,
        EXPECTED_SIGNER_THUMBPRINT: '',
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
        msiSha256,
      };
    }

    it('takes the mode, observation and imported signer from the earlier steps', () => {
      expect(step(STAGE).env).toMatchObject({
        WINDOWS_SIGNING_MODE: gh('steps.windows-signing.outputs.mode'),
        AUTHENTICODE_OBSERVATION: gh(
          'steps.windows-authenticode.outputs.observation',
        ),
        EXPECTED_SIGNER_THUMBPRINT: gh(
          'steps.windows-certificate.outputs.thumbprint',
        ),
      });
    });

    it('stages a NOT_SIGNED receipt for an unsigned build', () => {
      const { result, summary, receipt, msiSha256 } = stage('NotSigned', null, {
        WINDOWS_SIGNING_MODE: 'unsigned',
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
      const { result, receipt } = stage('Valid', THUMBPRINT, {
        WINDOWS_SIGNING_MODE: 'certificate',
        EXPECTED_SIGNER_THUMBPRINT: THUMBPRINT,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(receipt).toMatchObject({
        platformSigningState: 'VERIFIED',
        signerThumbprint: THUMBPRINT,
      });
    });

    it.each([
      ['unsigned', 'Valid', THUMBPRINT, ''],
      ['certificate', 'NotSigned', null, THUMBPRINT],
      ['certificate', 'Valid', OTHER_THUMBPRINT, THUMBPRINT],
      ['certificate', 'HashMismatch', THUMBPRINT, THUMBPRINT],
      ['', 'NotSigned', null, ''],
    ])(
      'refuses mode %j with observed status %s',
      (mode, status, thumbprint, expected) => {
        const { result, receipt } = stage(status, thumbprint, {
          WINDOWS_SIGNING_MODE: mode,
          EXPECTED_SIGNER_THUMBPRINT: expected,
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Windows release signing');
        expect(receipt).toBeNull();
      },
    );

    it('refuses an observation of other MSI bytes than the staged one', () => {
      const { result, receipt } = stage(
        'NotSigned',
        null,
        { WINDOWS_SIGNING_MODE: 'unsigned' },
        'd'.repeat(64),
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('not the staged installer');
      expect(receipt).toBeNull();
    });
  });
});
