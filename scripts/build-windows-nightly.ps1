param(
  [Parameter(Mandatory=$true)][string]$SourceSha,
  [Parameter(Mandatory=$true)][int]$BundleVersion,
  [switch]$RequireSigning
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Run this builder on Windows' }
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$actualSha = git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $SourceSha -notmatch '^[a-f0-9]{40}$' -or $actualSha -ne $SourceSha) { throw 'Source SHA mismatch' }
$out = Join-Path $root 'dist-windows-nightly'
if (Test-Path $out) { throw 'Build output already exists; use a fresh worktree for a new reservation' }
New-Item -ItemType Directory -Path $out | Out-Null
$env:STATION_CHANNEL = 'nightly'
$env:STATION_WINDOWS_BUNDLE_VERSION = [string]$BundleVersion
$env:STATION_WINDOWS_CONFIG = Join-Path $out 'tauri.nightly.windows.json'
$certificate = $null
try {
  if ($RequireSigning) {
    foreach ($name in @('WINDOWS_CERTIFICATE_BASE64','WINDOWS_CERTIFICATE_PASSWORD','TAURI_SIGNING_PRIVATE_KEY','TAURI_SIGNING_PRIVATE_KEY_PASSWORD','TAURI_SIGNING_PUBLIC_KEY')) {
      if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing protected signing secret: $name" }
    }
    $certificatePath = Join-Path $out 'signing.pfx'
    try {
      [IO.File]::WriteAllBytes($certificatePath, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE_BASE64))
      $password = ConvertTo-SecureString $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
      $certificate = Import-PfxCertificate -FilePath $certificatePath -CertStoreLocation Cert:\CurrentUser\My -Password $password
      if (-not $certificate.Thumbprint) { throw 'Certificate import failed' }
      $env:STATION_WINDOWS_THUMBPRINT = $certificate.Thumbprint
    } finally {
      if (Test-Path $certificatePath) { Remove-Item -LiteralPath $certificatePath }
    }
  } else {
    # Local packaging evidence must not accidentally borrow release credentials.
    $env:TAURI_SIGNING_PUBLIC_KEY = ''
    $env:TAURI_SIGNING_PRIVATE_KEY = ''
  }
  node scripts/windows-nightly-config.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Nightly config failed' }
  $config = Get-Content -Raw $env:STATION_WINDOWS_CONFIG | ConvertFrom-Json
  $env:STATION_BUILD_VERSION = $config.version
  npm.cmd run build:sdk
  if ($LASTEXITCODE -ne 0) { throw 'SDK build failed' }
  npm.cmd run build:connect
  if ($LASTEXITCODE -ne 0) { throw 'Connect build failed' }
  npm.cmd run build:desktop -- --target x86_64-pc-windows-msvc --config (Join-Path $root 'src-desktop/tauri.nightly.conf.json') --config $env:STATION_WINDOWS_CONFIG
  if ($LASTEXITCODE -ne 0) { throw 'Windows installer build failed' }
  $installers = @(Get-ChildItem 'src-desktop/target/x86_64-pc-windows-msvc/release/bundle/msi/*.msi')
  if ($installers.Count -ne 1 -or $installers[0].Length -lt 1MB) { throw 'Expected one nonempty MSI' }
  $signature = Get-AuthenticodeSignature $installers[0].FullName
  if ($RequireSigning -and $signature.Status -ne 'Valid') { throw "Invalid Authenticode signature: $($signature.Status)" }
  $extracted = Join-Path $out 'msi-extracted'
  $extractLog = Join-Path $out 'msi-extract.log'
  $extraction = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @('/a', ('"' + $installers[0].FullName + '"'), '/qn', ('TARGETDIR="' + $extracted + '"'), '/l*v', ('"' + $extractLog + '"'))
  if ($extraction.ExitCode -ne 0) { throw "MSI administrative extraction failed: $($extraction.ExitCode)" }
  $manifests = @(Get-ChildItem $extracted -Recurse -Filter station-build.json)
  if ($manifests.Count -ne 1) { throw 'Expected one packaged build identity' }
  $expectedHash = (Get-FileHash src-desktop/station-client-build.json -Algorithm SHA256).Hash
  if ((Get-FileHash $manifests[0].FullName -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Packaged build identity differs from staged source' }
  if ($RequireSigning) {
    $expanded = Join-Path $out 'updater-extracted'
    Expand-Archive -LiteralPath ($installers[0].FullName + '.zip') -DestinationPath $expanded
    $updaterInstallers = @(Get-ChildItem $expanded -Recurse -File)
    if ($updaterInstallers.Count -ne 1 -or $updaterInstallers[0].Extension -ne '.msi' -or (Get-FileHash $updaterInstallers[0].FullName -Algorithm SHA256).Hash -ne (Get-FileHash $installers[0].FullName -Algorithm SHA256).Hash) { throw 'Updater archive does not contain exactly the signed MSI' }
  }
  $basename = "station-$($config.version)-windows-x86_64.msi"
  Copy-Item $installers[0].FullName (Join-Path $out $basename)
  if ($RequireSigning) {
    foreach ($suffix in @('.zip','.zip.sig')) {
      Copy-Item ($installers[0].FullName + $suffix) (Join-Path $out ($basename + $suffix))
    }
  }
  Copy-Item 'src-desktop/station-client-build.json' (Join-Path $out 'station-client-build.json')
  $receipt = [ordered]@{
    kind = 'station.windows-nightly-build/v1'; sourceSha = $SourceSha; version = $config.version
    bundleVersion = $BundleVersion; platform = 'windows-x86_64'
    installer = $basename; installerSha256 = (Get-FileHash (Join-Path $out $basename) -Algorithm SHA256).Hash.ToLowerInvariant()
    platformSigningState = $(if ($RequireSigning) { 'VERIFIED' } else { 'NOT_VERIFIED' })
    packagedProvenanceSha256 = $expectedHash.ToLowerInvariant()
    updaterPayloadState = $(if ($RequireSigning) { 'VERIFIED' } else { 'NOT_VERIFIED' })
    publicationState = 'NOT_PUBLISHED'; installState = 'NOT_INSTALLED'; updateState = 'NOT_UPDATED'
  }
  $receipt | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $out 'windows-build-receipt.json')
} finally {
  if ($certificate) { Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" }
  Remove-Item Env:\STATION_WINDOWS_THUMBPRINT -ErrorAction SilentlyContinue
}
