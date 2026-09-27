import { spawnSync } from 'node:child_process';
import { windowsSystemUtilityPath } from './windows-system-utility.mjs';

/**
 * The one budget for a Windows trust PowerShell run (#2805). Every caller is a
 * one-shot at startup or before a sensitive write, and every failure fails
 * closed — the server does not boot, the CLI command refuses — so a slow
 * success is worth far more than a fast failure. 30s was measured too short:
 * on a GitHub Windows runner saturated by scanning a freshly extracted
 * 44k-file archive, the server's first trust call timed out at 30s
 * (run 36326088380) while a bare `where.exe` took ~58s. 120s covers that
 * host with room, and still fits inside `station start`'s readiness wait,
 * which extends to 180s while the server process is alive (lifecycle.ts,
 * STARTUP_READINESS_MAX_TIMEOUT_MS).
 */
export const WINDOWS_TRUST_COMMAND_TIMEOUT_MS = 120_000;

// A type alias, not an interface, so a general command runner whose options
// are `Record<string, unknown>` (the service manager's) accepts it.
export type WindowsTrustCommandOptions = {
  /** Kill the command after this many milliseconds. */
  timeout: number;
};

export interface WindowsTrustCommandResult {
  error?: Error;
  status: number | null;
  stderr?: string;
  stdout?: string;
}

/**
 * Runs one trust command. The trust functions pass the budget as `options`;
 * a production runner must honor it. Test runners may ignore it.
 */
export type WindowsTrustCommandRunner = (
  command: string,
  args: string[],
  options?: WindowsTrustCommandOptions,
) => WindowsTrustCommandResult;

/** The default production runner for the Windows trust functions. */
export function runWindowsTrustCommand(
  command: string,
  args: string[],
  options: WindowsTrustCommandOptions = {
    timeout: WINDOWS_TRUST_COMMAND_TIMEOUT_MS,
  },
): WindowsTrustCommandResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: options.timeout,
    // The program prints one short JSON line; errors are a few KB at most.
    maxBuffer: 1024 * 1024,
  });
  return {
    error: result.error,
    status: result.status,
    stderr: typeof result.stderr === 'string' ? result.stderr : undefined,
    stdout: typeof result.stdout === 'string' ? result.stdout : undefined,
  };
}

const TRUST_COMMAND_OPTIONS: WindowsTrustCommandOptions = {
  timeout: WINDOWS_TRUST_COMMAND_TIMEOUT_MS,
};

export type WindowsTrustKind = 'directory' | 'file';
export type WindowsTrustOperation = 'ensure' | 'verify';
export type WindowsTrustPolicy = 'current-user-only' | 'execution-safe';

export interface WindowsTrustTarget {
  kind: WindowsTrustKind;
  path: string;
  policy?: WindowsTrustPolicy;
}

export type { WindowsSystemUtility } from './windows-system-utility.mjs';
export { windowsSystemUtilityPath };

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
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { $acl.SetOwner($sid) }
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
if ($operation -eq 'ensure') {
  # Prove every boundary just written by reading each ACL back from disk.
  # This is the same assertion the 'verify' operation makes, run after all
  # targets are set; doing it here instead of in a second PowerShell process
  # halves the cold starts that time out on loaded Windows hosts (#2315).
  foreach ($target in @($request.targets)) {
    Assert-CurrentUserDacl ([string]$target.path) ([string]$target.kind -eq 'directory') ([string]$target.policy -eq 'execution-safe')
  }
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
  run: WindowsTrustCommandRunner,
  targets: readonly WindowsTrustTarget[],
): void {
  if (process.platform !== 'win32') return;
  const result = run(
    windowsSystemUtilityPath('powershell'),
    buildWindowsTrustCommand('verify', targets),
    TRUST_COMMAND_OPTIONS,
  );
  if (result.status !== 0 || result.error) {
    throw new Error(
      `Windows current-user ACL verification failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`,
    );
  }
  parseWindowsTrustResult(result.stdout);
}

export function ensureWindowsDirectoriesTrusted(
  run: WindowsTrustCommandRunner,
  paths: readonly string[],
): void {
  if (process.platform !== 'win32') return;
  const targets = paths.map((path) => ({ kind: 'directory' as const, path }));
  const result = run(
    windowsSystemUtilityPath('powershell'),
    buildWindowsTrustCommand('ensure', targets),
    TRUST_COMMAND_OPTIONS,
  );
  if (result.status !== 0 || result.error) {
    throw new Error(
      `Windows current-user ACL setup failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`,
    );
  }
  // The ensure program re-reads and asserts every ACL it set before it
  // reports success, so no second verification process is needed.
  parseWindowsTrustResult(result.stdout);
}

/** Harden an existing file (or create/harden a directory) before it is used. */
export function hardenWindowsPathsTrusted(
  run: WindowsTrustCommandRunner,
  targets: readonly WindowsTrustTarget[],
): void {
  if (process.platform !== 'win32') return;
  const result = run(
    windowsSystemUtilityPath('powershell'),
    buildWindowsTrustCommand('ensure', targets),
    TRUST_COMMAND_OPTIONS,
  );
  if (result.status !== 0 || result.error) {
    throw new Error(
      `Windows current-user ACL setup failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`,
    );
  }
  // The ensure program re-reads and asserts every ACL it set before it
  // reports success, so no second verification process is needed.
  parseWindowsTrustResult(result.stdout);
}
