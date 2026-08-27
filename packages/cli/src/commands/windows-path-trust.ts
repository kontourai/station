import { win32 } from 'node:path';
import type { CommandRunner } from './service.js';

export type WindowsTrustKind = 'directory' | 'file';
export type WindowsTrustOperation = 'ensure' | 'verify';
export type WindowsTrustPolicy = 'current-user-only' | 'execution-safe';

export interface WindowsTrustTarget {
  kind: WindowsTrustKind;
  path: string;
  policy?: WindowsTrustPolicy;
}

export type WindowsSystemUtility = 'cmd' | 'powershell' | 'schtasks' | 'whoami';

/**
 * System tools are invoked before Station can use PowerShell to inspect a
 * caller-controlled path. Resolve their protected System32 locations
 * directly; never allow a GUI launcher's inherited PATH to select them.
 */
export function windowsSystemUtilityPath(
  utility: WindowsSystemUtility,
): string {
  const systemRoot =
    process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  if (!win32.isAbsolute(systemRoot) || systemRoot.startsWith('\\\\')) {
    throw new Error('Windows SystemRoot must be a local absolute path');
  }
  const system32 = win32.join(win32.normalize(systemRoot), 'System32');
  switch (utility) {
    case 'powershell':
      return win32.join(
        system32,
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
    default:
      return win32.join(system32, `${utility}.exe`);
  }
}

interface WindowsTrustResult {
  trusted: true;
}

/**
 * This script intentionally contains no path interpolation.  Every pathname
 * is serialized as Base64 JSON inside an encoded PowerShell program, including
 * names with quotes or PowerShell metacharacters. It establishes a protected
 * DACL containing one explicit FullControl allow ACE for the current token
 * SID, then proves that exact boundary again. We do not rely on localized
 * `icacls` output or PowerShell's ambiguous post-`-Command` argv handling.
 */
const WINDOWS_TRUST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__STATION_TRUST_PAYLOAD__')) | ConvertFrom-Json
function Assert-NoReparse([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($full)
  $current = $root
  $tail = $full.Substring($root.Length).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if ($tail.Length -eq 0) { return }
  foreach ($part in $tail -split '[\\/]') {
    if ($part.Length -eq 0) { continue }
    $current = Join-Path -Path $current -ChildPath $part
    if (Test-Path -LiteralPath $current) {
      if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Station trust path contains a reparse point: $current"
      }
    }
  }
}
function Set-CurrentUserDacl([string]$Path, [bool]$Directory) {
  Assert-NoReparse $Path
  $acl = if ($Directory) { [IO.Directory]::GetAccessControl($Path) } else { [IO.File]::GetAccessControl($Path) }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
  $inheritance = if ($Directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  $acl.SetOwner($sid)
  $acl.AddAccessRule($rule)
  if ($Directory) { [IO.Directory]::SetAccessControl($Path, $acl) } else { [IO.File]::SetAccessControl($Path, $acl) }
}
function Assert-CurrentUserDacl([string]$Path, [bool]$Directory, [bool]$ExecutionSafe) {
  Assert-NoReparse $Path
  $item = Get-Item -LiteralPath $Path -Force
  if ($Directory -ne $item.PSIsContainer) { throw "Station trust path kind changed: $Path" }
  $acl = if ($Directory) { [IO.Directory]::GetAccessControl($Path) } else { [IO.File]::GetAccessControl($Path) }
  $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($ExecutionSafe) {
    $allowedOwners = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
    if ($allowedOwners -notcontains $ownerSid) { throw "Station executable has an untrusted owner: $Path" }
    # Composite rights such as FullControl and Modify also contain read and
    # execute bits. Including them in a bit mask makes an ordinary RX ACE look
    # writable. Build the mask only from primitive mutation rights so inherited
    # read/execute access remains execution-safe while any real write authority
    # still fails closed.
    $writeMask = [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    # Effective write access can be inherited from a parent directory. Include
    # both explicit and inherited allow ACEs so a writable ancestor cannot be
    # mistaken for an execution-safe command path.
    foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
      if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $allowedOwners -notcontains $rule.IdentityReference.Value -and (($rule.FileSystemRights -band $writeMask) -ne 0)) { throw "Station executable is writable by an unrelated SID: $Path" }
    }
    return
  }
  if (-not $acl.AreAccessRulesProtected -or $ownerSid -ne $sid.Value) { throw "Station trust ACL is not current-user protected: $Path" }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 1) { throw "Station trust ACL has unrelated entries: $Path" }
  $rule = $rules[0]
  if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)) { throw "Station trust ACL permits an unrelated principal or lacks current-user control: $Path" }
}
$operation = [string]$request.operation
foreach ($target in @($request.targets)) {
  $kind = [string]$target.kind
  $policy = [string]$target.policy
  $path = [string]$target.path
  if ($kind -ne 'directory' -and $kind -ne 'file') { throw 'Station trust received an invalid path kind' }
  if ($policy -ne 'current-user-only' -and $policy -ne 'execution-safe') { throw 'Station trust received an invalid path policy' }
  $directory = $kind -eq 'directory'
  if ($operation -eq 'ensure') {
    Assert-NoReparse $path
    if (-not (Test-Path -LiteralPath $path)) {
      if (-not $directory) { throw "Station trust file does not exist: $path" }
      [void][IO.Directory]::CreateDirectory($path)
    }
    Set-CurrentUserDacl $path $directory
  } elseif ($operation -eq 'verify') {
    if (-not (Test-Path -LiteralPath $path)) { throw "Station trust path does not exist: $path" }
    Assert-CurrentUserDacl $path $directory ($policy -eq 'execution-safe')
  } else { throw 'Station trust received an invalid operation' }
}
[Console]::Out.Write('{"trusted":true}')
`;

export function encodePowerShellCommand(program: string): string {
  return Buffer.from(program, 'utf16le').toString('base64');
}

export function buildWindowsTrustCommand(
  operation: WindowsTrustOperation,
  targets: readonly WindowsTrustTarget[],
): string[] {
  if (targets.length === 0) throw new Error('Windows trust needs a path');
  const payload = Buffer.from(
    JSON.stringify({
      operation,
      targets: targets.map((target) => ({
        kind: target.kind,
        path: target.path,
        policy: target.policy ?? 'current-user-only',
      })),
    }),
    'utf8',
  ).toString('base64');
  const program = WINDOWS_TRUST_SCRIPT.replace(
    '__STATION_TRUST_PAYLOAD__',
    payload,
  );
  return [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodePowerShellCommand(program),
  ];
}

export function parseWindowsTrustResult(
  stdout: string | undefined,
): WindowsTrustResult {
  const output = stdout?.trim();
  if (!output) throw new Error('Windows trust returned no verification result');
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('Windows trust returned an invalid verification result');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as Partial<WindowsTrustResult>).trusted !== true
  ) {
    throw new Error('Windows trust did not confirm the current-user ACL');
  }
  return { trusted: true };
}

export function assertWindowsPathsTrusted(
  run: CommandRunner,
  targets: readonly WindowsTrustTarget[],
): void {
  if (process.platform !== 'win32') return;
  const result = run(
    windowsSystemUtilityPath('powershell'),
    buildWindowsTrustCommand('verify', targets),
  );
  if (result.status !== 0 || result.error) {
    throw new Error(
      `Windows current-user ACL verification failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`,
    );
  }
  parseWindowsTrustResult(result.stdout);
}

export function ensureWindowsDirectoriesTrusted(
  run: CommandRunner,
  paths: readonly string[],
): void {
  if (process.platform !== 'win32') return;
  const targets = paths.map((path) => ({ kind: 'directory' as const, path }));
  const result = run(
    windowsSystemUtilityPath('powershell'),
    buildWindowsTrustCommand('ensure', targets),
  );
  if (result.status !== 0 || result.error) {
    throw new Error(
      `Windows current-user ACL setup failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`,
    );
  }
  parseWindowsTrustResult(result.stdout);
  assertWindowsPathsTrusted(run, targets);
}

/** Harden an existing file (or create/harden a directory) before it is used. */
export function hardenWindowsPathsTrusted(
  run: CommandRunner,
  targets: readonly WindowsTrustTarget[],
): void {
  if (process.platform !== 'win32') return;
  const result = run(
    windowsSystemUtilityPath('powershell'),
    buildWindowsTrustCommand('ensure', targets),
  );
  if (result.status !== 0 || result.error) {
    throw new Error(
      `Windows current-user ACL setup failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`,
    );
  }
  parseWindowsTrustResult(result.stdout);
  assertWindowsPathsTrusted(run, targets);
}
