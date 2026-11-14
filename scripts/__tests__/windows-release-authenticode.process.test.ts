import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import { createWindowsReleaseSigningReceipt } from '../lib/windows-release-signing.mjs';

/**
 * #3591: release.yml's desktop-windows "Observe Windows Authenticode
 * signature" step, extracted from the workflow and run under real pwsh
 * against files Windows itself judges: an unsigned MSI, a PE signed at test
 * time with a throwaway self-signed code-signing certificate, that PE
 * tampered after signing, and a publisher-signed PE (a copy of this Node
 * executable). The step must record what Get-AuthenticodeSignature returned,
 * and the signing module must accept only the status each mode allows. A step
 * that fabricated its observation instead of reporting the real call fails
 * here: the recorded status, signer and hash are checked against the file.
 *
 * Windows only. The throwaway certificate lives in Cert:\CurrentUser\My just
 * long enough to sign one fixture and is removed before any assertion; no
 * trust store is changed, so the self-signed PE is never Valid.
 */

const onWindows = process.platform === 'win32';
const SKIP_REASON =
  'skipped off Windows: Get-AuthenticodeSignature and New-SelfSignedCertificate exist only on Windows';
const root = resolve(import.meta.dirname, '../..');
const TAG = 'v1.2.3';
const SHA = 'a'.repeat(40);
const OBSERVE = 'Observe Windows Authenticode signature';
const STEP_TIMEOUT_MS = 60_000;

type Step = { name?: string; run?: string };
const releaseWorkflow = load(
  readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8'),
) as { jobs: Record<string, { steps: Step[] }> };
const observeScript = releaseWorkflow.jobs['desktop-windows'].steps.find(
  (candidate) => candidate.name === OBSERVE,
)?.run;

/** Builds the fixtures and reports the two signer thumbprints. */
const FIXTURES = String.raw`
$ErrorActionPreference = 'Stop'
$dir = $env:FIXTURE_DIR
$msi = Join-Path $dir 'unsigned.msi'
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase($msi, 3)
$database.Commit()
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($database)
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($installer)
$library = Join-Path $dir 'self-signed.dll'
Add-Type -TypeDefinition 'public static class StationAuthenticodeFixture { public static int Answer() { return 42; } }' -OutputAssembly $library
$certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Station Authenticode test fixture' -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddHours(1)
try {
  $signed = Set-AuthenticodeSignature -LiteralPath $library -Certificate $certificate -HashAlgorithm SHA256
  if (-not $signed.SignerCertificate) { throw "Set-AuthenticodeSignature did not sign the fixture: $($signed.Status) $($signed.StatusMessage)" }
} finally {
  Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)"
}
$bytes = [IO.File]::ReadAllBytes($library)
$bytes[0x300] = $bytes[0x300] -bxor 0xFF
[IO.File]::WriteAllBytes((Join-Path $dir 'tampered.dll'), $bytes)
$publisher = Join-Path $dir 'publisher-signed.exe'
Copy-Item -LiteralPath $env:NODE_EXE -Destination $publisher
[ordered]@{
  selfSignedThumbprint = $certificate.Thumbprint
  publisherThumbprint = [Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($publisher).GetCertHashString()
} | ConvertTo-Json -Compress
`;

function pwsh(
  scriptPath: string,
  cwd: string,
  env: Record<string, string | undefined>,
) {
  // GitHub runs a `shell: pwsh` step as `pwsh -command ". '{0}'"`.
  return spawnSyncBounded(
    'pwsh',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `. '${scriptPath}'`,
    ],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: STEP_TIMEOUT_MS,
      env: { ...process.env, ...env },
    },
  );
}

describe.skipIf(!onWindows)(
  `release.yml Authenticode observation under real pwsh${onWindows ? '' : ` (${SKIP_REASON})`}`,
  { timeout: STEP_TIMEOUT_MS * 2 },
  () => {
    // Fixtures are shared by every test; each test's workspace is its own.
    const makeFixtureDir = trackTempDirs({ lifetime: 'file' });
    const makeWorkspace = trackTempDirs();
    let fixtureDir = '';
    let selfSignedThumbprint = '';
    let publisherThumbprint = '';

    beforeAll(() => {
      fixtureDir = makeFixtureDir('station-authenticode-fixtures-');
      const script = join(fixtureDir, 'fixtures.ps1');
      writeFileSync(script, FIXTURES);
      const result = pwsh(script, fixtureDir, {
        FIXTURE_DIR: fixtureDir,
        NODE_EXE: process.execPath,
      });
      if (result.status !== 0)
        throw new Error(
          `fixture generation failed (${result.status}): ${result.stderr}${result.stdout}`,
        );
      ({ selfSignedThumbprint, publisherThumbprint } = JSON.parse(
        String(result.stdout).trim(),
      ));
    }, STEP_TIMEOUT_MS * 2);

    /** Run the extracted step with `fixture` as the bundle's only MSI. */
    function observe(fixture: string, mode: string, expectedThumbprint = '') {
      if (!observeScript)
        throw new Error(`Missing desktop-windows step ${OBSERVE}`);
      const workspace = makeWorkspace('station-authenticode-');
      symlinkSync(
        resolve(root, 'scripts'),
        join(workspace, 'scripts'),
        'junction',
      );
      const bundle = join(
        workspace,
        'src-desktop/target/x86_64-pc-windows-msvc/release/bundle/msi',
      );
      mkdirSync(bundle, { recursive: true });
      const msi = join(bundle, 'Station_1.2.3_x64_en-US.msi');
      copyFileSync(join(fixtureDir, fixture), msi);
      const runnerTemp = join(workspace, 'runner-temp');
      mkdirSync(runnerTemp);
      const output = join(runnerTemp, 'github-output');
      writeFileSync(output, '');
      const script = join(runnerTemp, 'observe.ps1');
      // The prologue and epilogue GitHub wraps around a `shell: pwsh` step.
      writeFileSync(
        script,
        `$ErrorActionPreference = 'stop'\n${observeScript}\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }\n`,
      );
      const result = pwsh(script, workspace, {
        RUNNER_TEMP: runnerTemp,
        GITHUB_OUTPUT: output,
        RELEASE_VERSION: '1.2.3',
        WINDOWS_SIGNING_MODE: mode,
        EXPECTED_SIGNER_THUMBPRINT: expectedThumbprint,
      });
      const observationPath = join(
        runnerTemp,
        'station-windows-authenticode.json',
      );
      return {
        result,
        output: readFileSync(output, 'utf8'),
        observationPath,
        observation: existsSync(observationPath)
          ? JSON.parse(readFileSync(observationPath, 'utf8'))
          : null,
        msiSha256: createHash('sha256').update(readFileSync(msi)).digest('hex'),
      };
    }

    it('records NotSigned for an unsigned MSI and accepts it as NOT_SIGNED in unsigned mode', () => {
      const run = observe('unsigned.msi', 'unsigned');
      expect(
        run.result.status,
        `${run.result.stderr}${run.result.stdout}`,
      ).toBe(0);
      expect(run.observation).toEqual({
        // Hosted runners spell the temporary directory in 8.3 form.
        installer: expect.stringMatching(
          /[\\/]Station_1\.2\.3_x64_en-US\.msi$/,
        ),
        installerSha256: run.msiSha256,
        authenticodeStatus: 'NotSigned',
        statusMessage: expect.any(String),
        signerThumbprint: null,
      });
      expect(run.output.replace(/\r/g, '')).toContain(
        `observation=${run.observationPath}\n`,
      );
      const receipt = createWindowsReleaseSigningReceipt({
        tag: TAG,
        sourceSha: SHA,
        mode: 'unsigned',
        observation: run.observation,
        installer: `station-${TAG}-windows-x86_64.msi`,
        installerSha256: run.msiSha256,
      });
      expect(receipt).toMatchObject({
        authenticodeStatus: 'NotSigned',
        platformSigningState: 'NOT_SIGNED',
        signerThumbprint: null,
      });
    });

    it('refuses an unsigned MSI in certificate mode', () => {
      const run = observe('unsigned.msi', 'certificate', selfSignedThumbprint);
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        'certificate mode requires Authenticode status Valid, observed "NotSigned"',
      );
      expect(run.observation?.authenticodeStatus).toBe('NotSigned');
      expect(run.output).not.toContain('observation=');
    });

    it.each(['certificate', 'unsigned'])(
      'refuses a PE signed by an untrusted self-signed certificate in %s mode',
      (mode) => {
        const run = observe(
          'self-signed.dll',
          mode,
          mode === 'certificate' ? selfSignedThumbprint : '',
        );
        expect(run.result.status).not.toBe(0);
        expect(run.observation).toMatchObject({
          installerSha256: run.msiSha256,
          signerThumbprint: selfSignedThumbprint,
        });
        // Windows reports an untrusted root as UnknownError or NotTrusted;
        // what matters is that it is a real, non-Valid signed state.
        expect(['UnknownError', 'NotTrusted']).toContain(
          run.observation?.authenticodeStatus,
        );
        expect(run.result.stderr).toContain(
          `${mode} mode requires Authenticode status ${mode === 'certificate' ? 'Valid' : 'NotSigned'}, observed "${run.observation?.authenticodeStatus}"`,
        );
      },
    );

    it.each(['certificate', 'unsigned'])(
      'refuses a signed PE tampered after signing as HashMismatch in %s mode',
      (mode) => {
        const run = observe(
          'tampered.dll',
          mode,
          mode === 'certificate' ? selfSignedThumbprint : '',
        );
        expect(run.result.status).not.toBe(0);
        expect(run.observation).toMatchObject({
          authenticodeStatus: 'HashMismatch',
          installerSha256: run.msiSha256,
        });
        expect(run.result.stderr).toContain('observed "HashMismatch"');
      },
    );

    it('records a publisher-signed PE as Valid and accepts it as VERIFIED for its own signer', () => {
      const run = observe(
        'publisher-signed.exe',
        'certificate',
        publisherThumbprint,
      );
      expect(
        run.result.status,
        `this host's Node executable must carry a valid publisher signature: ${run.result.stderr}`,
      ).toBe(0);
      expect(run.observation).toMatchObject({
        installerSha256: run.msiSha256,
        authenticodeStatus: 'Valid',
        signerThumbprint: publisherThumbprint,
      });
      const receipt = createWindowsReleaseSigningReceipt({
        tag: TAG,
        sourceSha: SHA,
        mode: 'certificate',
        observation: run.observation,
        expectedThumbprint: publisherThumbprint,
        installer: `station-${TAG}-windows-x86_64.msi`,
        installerSha256: run.msiSha256,
      });
      expect(receipt).toMatchObject({
        platformSigningState: 'VERIFIED',
        signerThumbprint: publisherThumbprint,
      });
    });

    it('refuses a Valid signature by another signer and any signature in unsigned mode', () => {
      const other = observe(
        'publisher-signed.exe',
        'certificate',
        selfSignedThumbprint,
      );
      expect(other.result.status).not.toBe(0);
      expect(other.result.stderr).toContain(
        'not the imported release certificate',
      );
      expect(other.observation?.authenticodeStatus).toBe('Valid');
      const unsigned = observe('publisher-signed.exe', 'unsigned');
      expect(unsigned.result.status).not.toBe(0);
      expect(unsigned.result.stderr).toContain(
        'unsigned mode requires Authenticode status NotSigned, observed "Valid"',
      );
    });
  },
);
