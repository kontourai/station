param(
  [Parameter(Mandatory=$true)][string]$ProofRoot,
  [string]$MakeNsis = "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe"
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (!(Test-Path -LiteralPath $MakeNsis -PathType Leaf)) { throw 'The native NSIS compiler is required' }
$ProofRoot = [IO.Path]::GetFullPath($ProofRoot)
if ($ProofRoot.Contains('$')) { throw 'ProofRoot must not contain NSIS variable syntax' }
if (Test-Path -LiteralPath $ProofRoot) { throw 'Use a new proof directory; existing evidence must be preserved' }
$sourceHooks = Join-Path $PSScriptRoot '../src-desktop/nsis-hooks.nsh'
New-Item -ItemType Directory -Path $ProofRoot | Out-Null
$hooksRoot = Join-Path $ProofRoot 'src-desktop'
$resources = Join-Path $ProofRoot 'dist-desktop-wix-resources'
New-Item -ItemType Directory -Path $hooksRoot,$resources | Out-Null
Copy-Item -LiteralPath $sourceHooks -Destination (Join-Path $hooksRoot 'nsis-hooks.nsh')
Set-Content -LiteralPath (Join-Path $resources 'installer-path-budget.nsh') -Value '!define STATION_WINDOWS_MAX_INSTALL_ROOT 247' -Encoding utf8
$hooksHash = (Get-FileHash -LiteralPath $sourceHooks -Algorithm SHA256).Hash
$drive = Get-Volume -FilePath $ProofRoot
$refusedKiB = [long][Math]::Ceiling($drive.Size / 1024) + 1048576
$results = @()
foreach ($case in @(@{ name='insufficient'; size=$refusedKiB; code=3 }, @{ name='sufficient'; size=1; code=0 })) {
  $install = Join-Path $ProofRoot $case.name
  $oldRuntime = Join-Path $install 'node_modules'
  New-Item -ItemType Directory -Path $oldRuntime | Out-Null
  $sentinel = Join-Path $oldRuntime 'previous-build.txt'
  Set-Content -LiteralPath $sentinel -Value 'previous-build'
  $sentinelHash = (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
  $installer = Join-Path $ProofRoot ($case.name + '.exe')
  $script = Join-Path $ProofRoot ($case.name + '.nsi')
  @"
Unicode true
RequestExecutionLevel user
SilentInstall silent
!include LogicLib.nsh
!define ESTIMATEDSIZE $($case.size)
!define MAINBINARYNAME "station-space-fixture"
!define PRODUCTNAME "Station space fixture"
!macro CheckIfAppIsRunning binary product
!macroend
!include "$hooksRoot\nsis-hooks.nsh"
OutFile "$installer"
InstallDir "$install"
Section
  SetOutPath `$INSTDIR
  !insertmacro NSIS_HOOK_PREINSTALL
  FileOpen `$0 "`$INSTDIR\installed.txt" w
  FileWrite `$0 "replacement-build"
  FileClose `$0
SectionEnd
"@ | Set-Content -LiteralPath $script -Encoding utf8
  & $MakeNsis /V2 $script
  if ($LASTEXITCODE -ne 0) { throw "NSIS compilation failed: $($case.name)" }
  $process = Start-Process -FilePath $installer -PassThru -WindowStyle Hidden
  if (!$process.WaitForExit(30000)) { throw "Fixture installer did not settle: $($case.name); inspect before continuing" }
  if ($process.ExitCode -ne $case.code) { throw "Expected exit $($case.code), received $($process.ExitCode): $($case.name)" }
  $replacement = Join-Path $install 'installed.txt'
  if ($case.name -eq 'insufficient') {
    if (!(Test-Path -LiteralPath $sentinel) -or (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $sentinelHash) { throw 'Low-space refusal changed the previous runtime' }
    if (Test-Path -LiteralPath $replacement) { throw 'Low-space refusal wrote a replacement' }
  } else {
    if (Test-Path -LiteralPath $oldRuntime) { throw 'Successful preflight did not replace the previous runtime' }
    if ((Get-Content -LiteralPath $replacement -Raw) -ne 'replacement-build') { throw 'Successful preflight did not install the replacement' }
  }
  $results += @{ name=$case.name; exitCode=$process.ExitCode; result='PASSED' }
}
@{ kind='station.windows-installer-space-proof/v1'; hooksSha256=$hooksHash; cases=$results; inAppUpdateState='NOT_VERIFIED'; installedArtifactState='NOT_VERIFIED' } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $ProofRoot 'receipt.json') -Encoding utf8
Write-Output "Native NSIS space preflight passed; evidence: $ProofRoot"
