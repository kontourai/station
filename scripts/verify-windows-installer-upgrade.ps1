param(
  [Parameter(Mandatory=$true)][string]$InstallerA,
  [Parameter(Mandatory=$true)][string]$InstallerB,
  [Parameter(Mandatory=$true)][string]$PayloadB,
  [Parameter(Mandatory=$true)][string]$ProofRoot,
  [switch]$KeepInstalled
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$InstallerA = (Resolve-Path -LiteralPath $InstallerA).Path
$InstallerB = (Resolve-Path -LiteralPath $InstallerB).Path
$PayloadB = (Resolve-Path -LiteralPath $PayloadB).Path
if (-not [IO.Path]::IsPathRooted($ProofRoot) -or (Test-Path $ProofRoot)) { throw 'Use a new absolute proof directory' }
function Read-NightlyVersion([string]$path) {
  $info = (Get-Item -LiteralPath $path).VersionInfo
  if ($info.ProductName -ne 'Station Nightly') { throw 'Only Station Nightly installers may enter this fixture' }
  $matchRecord = [regex]::Match($info.ProductVersion, '^(\d+)\.(\d+)\.(\d+)-nightly\.(\d+)(?:\.(\d+))?$')
  if (-not $matchRecord.Success) { throw 'Installer has no Nightly version' }
  return @(1..5 | ForEach-Object { if ($matchRecord.Groups[$_].Success) { [int]$matchRecord.Groups[$_].Value } else { 0 } })
}
$versionA = @(Read-NightlyVersion $InstallerA)
$versionB = @(Read-NightlyVersion $InstallerB)
$newer = $false
for ($index = 0; $index -lt 5; $index++) {
  if ($versionB[$index] -ne $versionA[$index]) { $newer = $versionB[$index] -gt $versionA[$index]; break }
}
if (-not $newer) { throw 'Build B must be newer than build A' }
function NightlyRegistrations {
  $keys = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
  return @(Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $displayName = $_.PSObject.Properties['DisplayName']; $displayName -and $displayName.Value -eq 'Station Nightly' })
}
if (@(Get-Process -Name station,station-nightly -ErrorAction SilentlyContinue).Count) { throw 'A Station process is running; the legacy test installer must not close another channel' }
if (@(NightlyRegistrations).Count) { throw 'An existing Nightly installation belongs to the user; use an unused Nightly identity' }
$defaultInstall = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Station Nightly'
if (Test-Path $defaultInstall) { throw 'An unregistered default Nightly directory must be inspected before this fixture runs' }
New-Item -ItemType Directory -Path $ProofRoot | Out-Null
$install = Join-Path $ProofRoot 'install'
$proofHome = Join-Path $ProofRoot 'home'
New-Item -ItemType Directory -Path $proofHome | Out-Null
Set-Content (Join-Path $proofHome 'preserve.txt') 'user-home-sentinel'
@{ installerA=$InstallerA; installerB=$InstallerB; install=$install } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $ProofRoot 'fixture-owner.json')
# Any installer-triggered child is confined to this fixture's Station home.
$env:STATION_HOME = $proofHome
Remove-Item Env:\STATION_ROOT -ErrorAction SilentlyContinue
function Run-Installer([string]$path, [string]$arguments) {
  $process = Start-Process -FilePath $path -ArgumentList $arguments -PassThru
  if (-not $process.WaitForExit(600000)) { throw "Installer did not settle: $path; inspect before another operation" }
  if ($process.ExitCode -ne 0) { throw "Installer exit $($process.ExitCode): $path" }
}
function Assert-OwnedRegistration {
  $entries = @(NightlyRegistrations)
  if ($entries.Count -ne 1) { throw 'The fixture no longer owns exactly one Nightly registration' }
  $location = $entries[0].PSObject.Properties['InstallLocation']
  if (-not $location -or [IO.Path]::GetFullPath(([string]$location.Value).Trim('"')).TrimEnd('\') -ne $install.TrimEnd('\')) { throw 'Nightly registration no longer points to the fixture' }
}
function Inventory([string]$directory, [string]$name) {
  $output = Join-Path $ProofRoot $name
  node (Join-Path $PSScriptRoot 'windows-installed-tree.mjs') $directory $output | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Runtime inventory failed: $name" }
  return (Get-Content -Raw ($output + '.summary.json') | ConvertFrom-Json)
}
function Uninstall-Owned {
  Assert-OwnedRegistration
  Run-Installer (Join-Path $install 'uninstall.exe') '/S'
  # NSIS may launch a temporary uninstaller, so its parent exit is not proof.
  $deadline = (Get-Date).AddMinutes(3)
  while ((Test-Path $install) -or @(NightlyRegistrations).Count) {
    if ((Get-Date) -ge $deadline) { throw 'Uninstall did not remove the owned installation and registration' }
    Start-Sleep -Milliseconds 250
  }
  if ((Get-Content (Join-Path $proofHome 'preserve.txt')) -ne 'user-home-sentinel') { throw 'Uninstall changed the separate Station home' }
}
$expected = Inventory $PayloadB 'inventory-payload-b.json'
Run-Installer $InstallerA "/S /D=$install"
Assert-OwnedRegistration
foreach ($directory in @('node_modules','dist-server','schemas')) {
  $stale = Join-Path (Join-Path $install $directory) 'station-obsolete-fixture\nested'
  New-Item -ItemType Directory -Path $stale -Force | Out-Null
  Set-Content (Join-Path $stale 'obsolete.txt') 'old build resource'
}
# Use Tauri's NSIS update flag and registry discovery. Omit only its restart
# flag: this fixture verifies installation; native window/relaunch proof is separate.
Run-Installer $InstallerB '/S /UPDATE /ARGS'
Assert-OwnedRegistration
foreach ($directory in @('node_modules','dist-server','schemas')) {
  if (Test-Path (Join-Path (Join-Path $install $directory) 'station-obsolete-fixture')) { throw "Upgrade retained obsolete $directory files" }
}
$upgraded = Inventory $install 'inventory-upgraded-b.json'
if ($upgraded.runtimeSha256 -ne $expected.runtimeSha256) { throw 'Upgraded B differs from the packaged B payload' }
Uninstall-Owned
Run-Installer $InstallerB "/S /D=$install"
Assert-OwnedRegistration
$clean = Inventory $install 'inventory-clean-b.json'
if ($clean.runtimeSha256 -ne $expected.runtimeSha256 -or $clean.fullSha256 -ne $upgraded.fullSha256) { throw 'Clean B differs from the packaged or upgraded B payload' }
if (-not $KeepInstalled) { Uninstall-Owned }
@{ kind='station.windows-installer-upgrade-proof/v1'; installerKind='nsis'; result='PASSED'; installerA=$InstallerA; installerB=$InstallerB; payloadInventorySha256=$expected.runtimeSha256; upgradeEqualsPayload=$true; upgradeEqualsClean=$true; userHomePreserved=$true; installState=$(if ($KeepInstalled) { 'INSTALLED' } else { 'UNINSTALLED' }); inAppUpdateState='NOT_VERIFIED'; nativeWindowState='NOT_VERIFIED' } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $ProofRoot 'receipt.json')
