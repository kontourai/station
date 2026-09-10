param(
  [Parameter(Mandatory=$true)][string]$SourceSha,
  [Parameter(Mandatory=$true)][int]$BundleVersion,
  [switch]$RequireSigning,
  [switch]$SignUpdater
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Run this builder on Windows' }
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$actualSha = git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $SourceSha -notmatch '^[a-f0-9]{40}$' -or $actualSha -ne $SourceSha) { throw 'Source SHA mismatch' }
if (git status --porcelain --untracked-files=no) { throw 'Commit tracked changes before packaging' }
$out = Join-Path $root 'dist-windows-nightly'
if (Test-Path $out) { throw 'Build output already exists; retain it before starting another build' }
New-Item -ItemType Directory -Path $out | Out-Null
$env:STATION_CHANNEL = 'nightly'
$env:STATION_WINDOWS_BUNDLE_VERSION = [string]$BundleVersion
$env:STATION_WINDOWS_CONFIG = Join-Path $out 'tauri.nightly.windows.json'
$env:STATION_WINDOWS_THUMBPRINT = ''
$env:STATION_WINDOWS_SIGN_COMMAND = ''
$certificate = $null
$preexistingCertificates = @(Get-ChildItem Cert:\CurrentUser\My | Select-Object -ExpandProperty Thumbprint)
$updaterSigned = $RequireSigning -or $SignUpdater
try {
  if ($updaterSigned) {
    foreach ($name in @('TAURI_SIGNING_PRIVATE_KEY','TAURI_SIGNING_PUBLIC_KEY')) {
      if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing updater signing input: $name" }
    }
  } else {
    $env:TAURI_SIGNING_PUBLIC_KEY = ''
    $env:TAURI_SIGNING_PRIVATE_KEY = ''
  }
  if ($RequireSigning) {
    if (-not [string]::IsNullOrWhiteSpace($env:WINDOWS_SIGN_COMMAND)) {
      # Tauri's supported hook for cloud/HSM signing. The protected environment
      # supplies the signing tool and its authentication, never the app itself.
      $env:STATION_WINDOWS_SIGN_COMMAND = $env:WINDOWS_SIGN_COMMAND
    } else {
      foreach ($name in @('WINDOWS_CERTIFICATE_BASE64','WINDOWS_CERTIFICATE_PASSWORD')) {
        if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing Windows signing authority: $name or WINDOWS_SIGN_COMMAND" }
      }
      $certificatePath = Join-Path $out 'signing.pfx'
      try {
        [IO.File]::WriteAllBytes($certificatePath, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE_BASE64))
        $password = ConvertTo-SecureString $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
        $certificates = @(Import-PfxCertificate -FilePath $certificatePath -CertStoreLocation Cert:\CurrentUser\My -Password $password | Where-Object HasPrivateKey)
        if ($certificates.Count -ne 1) { throw 'Expected one Windows signing certificate with a private key' }
        $certificate = $certificates[0]
        $env:STATION_WINDOWS_THUMBPRINT = $certificate.Thumbprint
      } finally {
        if (Test-Path $certificatePath) { Remove-Item -LiteralPath $certificatePath }
      }
    }
  }
  node scripts/windows-nightly-config.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Nightly config failed' }
  $config = Get-Content -Raw $env:STATION_WINDOWS_CONFIG | ConvertFrom-Json
  $env:STATION_BUILD_VERSION = $config.version
  npm.cmd run build:sdk
  if ($LASTEXITCODE -ne 0) { throw 'SDK build failed' }
  npm.cmd run build:connect
  if ($LASTEXITCODE -ne 0) { throw 'Connect build failed' }
  npm.cmd run build:desktop -- --verbose --target x86_64-pc-windows-msvc --config (Join-Path $root 'src-desktop/tauri.nightly.conf.json') --config $env:STATION_WINDOWS_CONFIG
  if ($LASTEXITCODE -ne 0) { throw 'Windows installer build failed' }
  $installers = @(Get-ChildItem 'src-desktop/target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe' | Where-Object { $_.Name.Contains($config.version) })
  if ($installers.Count -ne 1 -or $installers[0].Length -lt 1MB) { throw 'Expected one nonempty NSIS installer for this version' }
  $installerPath = $installers[0].FullName
  if ($installers[0].VersionInfo.ProductName -ne 'Station Nightly' -or $installers[0].VersionInfo.ProductVersion -ne $config.version) { throw 'Installer product identity differs from Nightly configuration' }
  $signature = Get-AuthenticodeSignature $installerPath
  if ($RequireSigning -and ($signature.Status -ne 'Valid' -or ($certificate -and $signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint))) { throw "Invalid Authenticode signature: $($signature.Status)" }
  $extracted = Join-Path $out 'installer-extracted'
  $sevenZip = (Get-Command 7z.exe -ErrorAction Stop).Source
  & $sevenZip x -y "-o$extracted" $installerPath
  if ($LASTEXITCODE -ne 0) { throw 'NSIS payload extraction failed' }
  $manifests = @(Get-ChildItem $extracted -Depth 2 -File -Filter station-build.json)
  if ($manifests.Count -ne 1) { throw 'Expected one packaged build identity' }
  $expectedHash = (Get-FileHash src-desktop/station-client-build.json -Algorithm SHA256).Hash
  if ((Get-FileHash $manifests[0].FullName -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Packaged build identity differs from staged source' }
  if ($updaterSigned) {
    node scripts/verify-windows-updater.mjs $installerPath ($installerPath + '.sig')
    if ($LASTEXITCODE -ne 0) { throw 'Tauri updater signature verification failed' }
  }
  git diff --quiet
  if ($LASTEXITCODE -ne 0) { throw 'Packaging changed tracked inputs' }
  $basename = "station-$($config.version)-windows-x86_64-setup.exe"
  Copy-Item $installerPath (Join-Path $out $basename)
  if ($updaterSigned) { Copy-Item ($installerPath + '.sig') (Join-Path $out ($basename + '.sig')) }
  Copy-Item 'src-desktop/station-client-build.json' (Join-Path $out 'station-client-build.json')
  $receipt = [ordered]@{
    kind = 'station.windows-nightly-build/v1'; sourceSha = $SourceSha; version = $config.version
    bundleVersion = $BundleVersion; platform = 'windows-x86_64'; installerKind = 'nsis'; updaterFormat = 'tauri-v2'
    installer = $basename; installerSha256 = (Get-FileHash (Join-Path $out $basename) -Algorithm SHA256).Hash.ToLowerInvariant()
    platformSigningState = $(if ($RequireSigning) { 'VERIFIED' } else { 'NOT_VERIFIED' })
    signerSubject = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null })
    signerThumbprint = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null })
    packagedProvenanceSha256 = $expectedHash.ToLowerInvariant()
    updaterPayloadState = $(if ($updaterSigned) { 'VERIFIED' } else { 'NOT_VERIFIED' })
    publicationState = 'NOT_PUBLISHED'; installState = 'NOT_INSTALLED'; updateState = 'NOT_UPDATED'
  }
  $receipt | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $out 'windows-build-receipt.json')
} finally {
  if ($certificate -and $preexistingCertificates -notcontains $certificate.Thumbprint) { Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" }
  Remove-Item Env:\STATION_WINDOWS_THUMBPRINT -ErrorAction SilentlyContinue
  Remove-Item Env:\STATION_WINDOWS_SIGN_COMMAND -ErrorAction SilentlyContinue
}
