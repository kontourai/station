param(
  [Parameter(Mandatory=$true)][string]$ProofRoot,
  [string]$TrustSourcePath = (Join-Path (Split-Path $PSScriptRoot -Parent) 'src-desktop\src\windows_path_trust.rs')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Run on Windows' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run unelevated so administrator privileges cannot mask the ownership regression' }
if (-not [IO.Path]::IsPathRooted($ProofRoot) -or (Test-Path $ProofRoot)) { throw 'Use a new absolute proof directory' }
$source = Get-Content -Raw (Resolve-Path $TrustSourcePath)
$scriptMatches = [regex]::Matches($source, '(?s)const TRUST_SCRIPT: &str = r#"(.*?)"#;')
if ($scriptMatches.Count -ne 1) { throw 'Expected exactly one native trust program' }
$program = $scriptMatches[0].Groups[1].Value
$sid = $identity.User
New-Item -ItemType Directory $ProofRoot | Out-Null
$sourceHash = (Get-FileHash $TrustSourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
@{kind='station.windows-acl-proof/v1';sourceSha256=$sourceHash;unelevated=$true} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $ProofRoot 'owner.json')
function Native-Trust([string]$Operation, [string]$Path, [string]$Kind) {
  $payload = @{operation=$Operation;targets=@(@{path=$Path;kind=$Kind;policy='current-user-only'})} | ConvertTo-Json -Depth 5 -Compress
  $body = $program.Replace('__STATION_TRUST_PAYLOAD__', [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload)))
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $info.Arguments = '-NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body))
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $child = [Diagnostics.Process]::new()
  $child.StartInfo = $info
  [void]$child.Start()
  $stdout = $child.StandardOutput.ReadToEndAsync()
  $stderr = $child.StandardError.ReadToEndAsync()
  if (-not $child.WaitForExit(20000)) { $child.Kill(); throw 'Native trust process timed out' }
  return @{exitCode=$child.ExitCode;stdout=$stdout.Result;stderr=$stderr.Result}
}
function Assert-Trusted($Result) {
  if ($Result.exitCode -ne 0 -or $Result.stdout.Trim() -ne '{"trusted":true}') { throw "Native trust failed: $($Result.stderr)" }
}
$phase = 'setup'
try {
  foreach ($kind in @('directory','file')) {
    $path = Join-Path $ProofRoot $kind
    if ($kind -eq 'directory') { New-Item -ItemType Directory $path | Out-Null } else { Set-Content $path 'preserve payload' }
    $acl = Get-Acl $path
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Fixture is not owned by the unelevated user' }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::Modify, [Security.AccessControl.AccessControlType]::Allow))
    if ($kind -eq 'directory') { [IO.Directory]::SetAccessControl($path, $acl) } else { [IO.File]::SetAccessControl($path, $acl) }
    $before = Native-Trust 'verify' $path $kind
    if ($before.exitCode -eq 0) { throw 'Modify-only fixture incorrectly passed strict trust verification' }
    $phase = "ensure-$kind"
    Assert-Trusted (Native-Trust 'ensure' $path $kind)
    Assert-Trusted (Native-Trust 'verify' $path $kind)
    $acl = Get-Acl $path
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow))
    if ($kind -eq 'directory') { [IO.Directory]::SetAccessControl($path, $acl) } else { [IO.File]::SetAccessControl($path, $acl) }
    $phase = "reject-unrelated-access-$kind"
    if ((Native-Trust 'verify' $path $kind).exitCode -eq 0) { throw 'Unrelated access rule incorrectly passed verification' }
    Assert-Trusted (Native-Trust 'ensure' $path $kind)
    Assert-Trusted (Native-Trust 'verify' $path $kind)
    if ($kind -eq 'file' -and (Get-Content $path) -ne 'preserve payload') { throw 'ACL hardening changed file contents' }
  }
  @{result='PASSED';sourceSha256=$sourceHash;unelevated=$true;directory=$true;file=$true;rejectsUnrelatedAccess=$true} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $ProofRoot 'receipt.json')
} catch {
  @{result='FAILED';phase=$phase;sourceSha256=$sourceHash;failure=$_.Exception.Message} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $ProofRoot 'receipt.json')
  throw
}
