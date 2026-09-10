param(
  [Parameter(Mandatory=$true)][string]$InstallerA,
  [Parameter(Mandatory=$true)][string]$InstallerB,
  [Parameter(Mandatory=$true)][string]$ProofRoot
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$InstallerA = (Resolve-Path -LiteralPath $InstallerA).Path
$InstallerB = (Resolve-Path -LiteralPath $InstallerB).Path
if (-not [IO.Path]::IsPathRooted($ProofRoot) -or (Test-Path $ProofRoot)) { throw 'Use a new absolute proof directory' }
$windowsInstaller = New-Object -ComObject WindowsInstaller.Installer
function Read-MsiProperty([string]$path, [string]$property) {
  $database = $windowsInstaller.OpenDatabase($path, 0)
  $view = $database.OpenView("SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = '$property'")
  $view.Execute()
  $record = $view.Fetch()
  if (-not $record) { throw "Missing MSI property $property" }
  $value = $record.StringData(1)
  $view.Close()
  return $value
}
foreach ($path in @($InstallerA, $InstallerB)) {
  if ((Read-MsiProperty $path 'ProductName') -ne 'Station Nightly') { throw 'Only Station Nightly MSIs may enter this fixture' }
}
$productA = Read-MsiProperty $InstallerA 'ProductCode'
$productB = Read-MsiProperty $InstallerB 'ProductCode'
$upgradeA = Read-MsiProperty $InstallerA 'UpgradeCode'
if ($upgradeA -ne (Read-MsiProperty $InstallerB 'UpgradeCode')) { throw 'MSIs do not share an upgrade identity' }
if ([version](Read-MsiProperty $InstallerB 'ProductVersion') -le [version](Read-MsiProperty $InstallerA 'ProductVersion')) { throw 'Build B must be newer than build A' }
$uninstallKeys = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
$existing = @(Get-ItemProperty $uninstallKeys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'Station Nightly' })
if ($existing.Count) { throw 'An existing Nightly installation belongs to the user; this fixture requires an unused Nightly identity' }
New-Item -ItemType Directory -Path $ProofRoot | Out-Null
Set-Content -LiteralPath (Join-Path $ProofRoot 'fixture-owner.json') -Value (@{ productA=$productA; productB=$productB; upgradeCode=$upgradeA } | ConvertTo-Json) -Encoding utf8
$install = Join-Path $ProofRoot 'install'
$home = Join-Path $ProofRoot 'home'
New-Item -ItemType Directory -Path $home | Out-Null
Set-Content (Join-Path $home 'preserve.txt') 'user-home-sentinel'
function Invoke-Msi([string[]]$arguments, [string]$logName) {
  $log = Join-Path $ProofRoot $logName
  $process = Start-Process msiexec.exe -PassThru -ArgumentList ($arguments + @('/qn', '/norestart', '/l*v', ('"' + $log + '"')))
  if (-not $process.WaitForExit(300000)) { throw "MSI operation did not finish; inspect $log before another operation" }
  if ($process.ExitCode -ne 0) { throw "MSI exit $($process.ExitCode); inspect $log" }
}
function Inventory {
  $records = @(Get-ChildItem -LiteralPath $install -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($install.Length).TrimStart('\')
    if ($relative -ne 'foreign.txt') { "$relative`t$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)" }
  } | Sort-Object)
  return $records
}
# Never target an existing Station installation or terminate another app.
Invoke-Msi @('/i', ('"' + $InstallerA + '"'), ('INSTALLDIR="' + $install + '"')) 'install-a.log'
$installedA = @(Inventory)
$installedA | Set-Content (Join-Path $ProofRoot 'inventory-a.txt')
foreach ($directory in @('node_modules','dist-server','schemas')) {
  $stale = Join-Path (Join-Path $install $directory) 'station-obsolete-fixture\nested'
  New-Item -ItemType Directory -Path $stale -Force | Out-Null
  Set-Content (Join-Path $stale 'obsolete.txt') 'old build resource'
}
Set-Content (Join-Path $install 'foreign.txt') 'not an application resource'
Invoke-Msi @('/i', ('"' + $InstallerB + '"'), ('INSTALLDIR="' + $install + '"')) 'upgrade-b.log'
foreach ($directory in @('node_modules','dist-server','schemas')) {
  if (Test-Path (Join-Path (Join-Path $install $directory) 'station-obsolete-fixture')) { throw "Upgrade retained obsolete $directory files" }
}
$upgraded = @(Inventory)
$upgraded | Set-Content (Join-Path $ProofRoot 'inventory-upgraded-b.txt')
Invoke-Msi @('/x', $productB) 'uninstall-b.log'
foreach ($directory in @('node_modules','dist-server','schemas')) {
  if (Test-Path (Join-Path $install $directory)) { throw "Uninstall retained $directory" }
}
if ((Get-Content (Join-Path $home 'preserve.txt')) -ne 'user-home-sentinel' -or -not (Test-Path (Join-Path $install 'foreign.txt'))) { throw 'Cleanup touched data outside application resources' }
Invoke-Msi @('/i', ('"' + $InstallerB + '"'), ('INSTALLDIR="' + $install + '"')) 'clean-b.log'
$clean = @(Inventory)
$clean | Set-Content (Join-Path $ProofRoot 'inventory-clean-b.txt')
$difference = @(Compare-Object $upgraded $clean)
if ($difference.Count) { $difference | ConvertTo-Json | Set-Content (Join-Path $ProofRoot 'inventory-difference.json'); throw 'Upgraded B differs from clean B' }
Invoke-Msi @('/x', $productB) 'final-uninstall-b.log'
@{ kind='station.windows-msi-upgrade-proof/v1'; result='PASSED'; installerA=$InstallerA; installerB=$InstallerB; filesA=$installedA.Count; filesB=$clean.Count; upgradeEqualsClean=$true; userHomePreserved=$true; installState='UNINSTALLED' } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $ProofRoot 'receipt.json')
