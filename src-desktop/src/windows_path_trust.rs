//! Windows-only current-user ACL and reparse-point boundary for Station files.
//!
//! `icacls` is deliberately not used: its output is localized and cannot be a
//! fail-closed parser. Paths are separate process arguments, never inserted
//! into the PowerShell source.

#[cfg(windows)]
#[path = "windows_private_acl.rs"]
mod private_acl;

use std::path::Path;
#[cfg(windows)]
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustKind {
    Directory,
    File,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustPolicy {
    CurrentUserOnly,
    ExecutionSafe,
}

#[cfg(any(windows, test))]
fn result_is_trusted(stdout: &[u8]) -> bool {
    std::str::from_utf8(stdout)
        .ok()
        .map(str::trim)
        .is_some_and(|value| value == r#"{"trusted":true}"#)
}

/// Base64 implementation kept local so the trust boundary needs no CLI or
/// locale-dependent helper. PowerShell `-EncodedCommand` requires UTF-16LE.
#[cfg(any(windows, test))]
pub fn base64_utf8(value: &str) -> String {
    base64(value.as_bytes())
}

#[cfg(any(windows, test))]
pub fn encoded_powershell_command(program: &str) -> Vec<String> {
    let utf16le = program
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    vec![
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-EncodedCommand".into(),
        base64(&utf16le),
    ]
}

/// Resolve the inbox PowerShell by its protected System32 path. The native
/// process can begin with an arbitrary GUI PATH, so `Command::new("powershell")`
/// would select an attacker-controlled executable before ACL verification.
#[cfg(windows)]
pub(crate) fn powershell_path() -> Result<PathBuf, String> {
    let system_root = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("WINDIR"))
        .unwrap_or_else(|| "C:\\Windows".into());
    let system_root = PathBuf::from(system_root);
    if !system_root.is_absolute() || system_root.to_string_lossy().starts_with("\\\\") {
        return Err("Windows SystemRoot must be a local absolute path".into());
    }
    Ok(system_root
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe"))
}

#[cfg(any(windows, test))]
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        encoded.push(char::from(TABLE[((value >> 18) & 0x3f) as usize]));
        encoded.push(char::from(TABLE[((value >> 12) & 0x3f) as usize]));
        encoded.push(if chunk.len() > 1 {
            char::from(TABLE[((value >> 6) & 0x3f) as usize])
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            char::from(TABLE[(value & 0x3f) as usize])
        } else {
            '='
        });
    }
    encoded
}

#[cfg(any(windows, test))]
const TRUST_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__STATION_TRUST_PAYLOAD__')) | ConvertFrom-Json
function Assert-NoReparse([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path); $root = [IO.Path]::GetPathRoot($full); $current = $root
  $tail = $full.Substring($root.Length).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  foreach ($part in $tail -split '[\\/]') { if ($part.Length -eq 0) { continue }; $current = Join-Path $current $part; if ((Test-Path -LiteralPath $current) -and (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw "Station trust path contains a reparse point: $current" } }
}
function Set-Trust([string]$Path, [bool]$Directory) {
  Assert-NoReparse $Path; $acl = if ($Directory) { [IO.Directory]::GetAccessControl($Path) } else { [IO.File]::GetAccessControl($Path) }
  $acl.SetAccessRuleProtection($true, $false); foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
  $inheritance = if ($Directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  # An owner can change its DACL without WRITE_OWNER. Marking an unchanged
  # owner for persistence would unnecessarily require that additional right.
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { $acl.SetOwner($sid) }
  $acl.AddAccessRule($rule); if ($Directory) { [IO.Directory]::SetAccessControl($Path, $acl) } else { [IO.File]::SetAccessControl($Path, $acl) }
}
function Assert-Trust([string]$Path, [bool]$Directory, [bool]$ExecutionSafe) {
  Assert-NoReparse $Path; $item = Get-Item -LiteralPath $Path -Force; if ($Directory -ne $item.PSIsContainer) { throw "Station trust path kind changed: $Path" }
  $acl = if ($Directory) { [IO.Directory]::GetAccessControl($Path) } else { [IO.File]::GetAccessControl($Path) }; $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; if ($ExecutionSafe) { $allowedOwners = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544'); if ($allowedOwners -notcontains $ownerSid) { throw "Station executable has an untrusted owner: $Path" }; $writeMask = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Modify -bor [Security.AccessControl.FileSystemRights]::FullControl -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership; foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) { if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $allowedOwners -notcontains $rule.IdentityReference.Value -and (($rule.FileSystemRights -band $writeMask) -ne 0)) { throw "Station executable is writable by an unrelated SID: $Path" } }; return }; if (-not $acl.AreAccessRulesProtected -or $ownerSid -ne $sid.Value) { throw "Station trust ACL is not current-user protected: $Path" }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])); if ($rules.Count -ne 1) { throw "Station trust ACL has unrelated entries: $Path" }; $rule = $rules[0]
  if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)) { throw "Station trust ACL permits an unrelated principal: $Path" }
}
$operation = [string]$request.operation; foreach ($target in @($request.targets)) { $directory = [string]$target.kind -eq 'directory'; $executionSafe = [string]$target.policy -eq 'execution-safe'; $path = [string]$target.path; if ($operation -eq 'ensure') { if (-not (Test-Path -LiteralPath $path)) { if (-not $directory) { throw "Station trust file does not exist: $path" }; [void][IO.Directory]::CreateDirectory($path) }; Set-Trust $path $directory } elseif ($operation -eq 'verify') { if (-not (Test-Path -LiteralPath $path)) { throw "Station trust path does not exist: $path" }; Assert-Trust $path $directory $executionSafe } else { throw 'invalid Station trust operation' } }
# Complete the same verification pass before returning from an ensure request.
# Keeping both phases in this process avoids a second PowerShell startup.
if ($operation -eq 'ensure') {
  foreach ($target in @($request.targets)) {
    Assert-Trust ([string]$target.path) ([string]$target.kind -eq 'directory') $false
  }
}
[Console]::Out.Write('{"trusted":true}')
"#;

#[cfg(windows)]
fn invoke(operation: &str, paths: &[(TrustKind, TrustPolicy, &Path)]) -> Result<(), String> {
    use std::process::Command;
    if paths.is_empty() {
        return Err("Windows trust needs a path".into());
    }
    let targets = paths
        .iter()
        .map(|(kind, policy, path)| {
            serde_json::json!({
                "kind": match kind { TrustKind::Directory => "directory", TrustKind::File => "file" },
                "policy": match policy { TrustPolicy::CurrentUserOnly => "current-user-only", TrustPolicy::ExecutionSafe => "execution-safe" },
                "path": path.display().to_string(),
            })
        })
        .collect::<Vec<_>>();
    let payload = serde_json::json!({ "operation": operation, "targets": targets });
    let program = TRUST_SCRIPT.replace(
        "__STATION_TRUST_PAYLOAD__",
        &base64_utf8(&payload.to_string()),
    );
    let mut command = Command::new(powershell_path()?);
    command.args(encoded_powershell_command(&program));
    let output = command
        .output()
        .map_err(|error| format!("run Windows ACL verification: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Windows current-user ACL verification failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if !result_is_trusted(&output.stdout) {
        return Err("Windows current-user ACL verification returned an invalid result".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn invoke(_operation: &str, _paths: &[(TrustKind, TrustPolicy, &Path)]) -> Result<(), String> {
    Ok(())
}

pub fn ensure(paths: &[(TrustKind, &Path)]) -> Result<(), String> {
    let paths = paths
        .iter()
        .map(|(kind, path)| (*kind, TrustPolicy::CurrentUserOnly, *path))
        .collect::<Vec<_>>();
    invoke("ensure", &paths)
}

pub fn verify(paths: &[(TrustKind, &Path)]) -> Result<(), String> {
    #[cfg(windows)]
    {
        private_acl::verify(paths)
    }
    #[cfg(not(windows))]
    {
        let _ = paths;
        Ok(())
    }
}

pub fn verify_execution_paths(paths: &[(TrustKind, &Path)]) -> Result<(), String> {
    let paths = paths
        .iter()
        .map(|(kind, path)| (*kind, TrustPolicy::ExecutionSafe, *path))
        .collect::<Vec<_>>();
    invoke("verify", &paths)
}

#[cfg(test)]
mod tests {
    use super::{encoded_powershell_command, result_is_trusted, TRUST_SCRIPT};

    #[cfg(windows)]
    #[test]
    fn native_private_acl_matches_powershell_and_rechecks_changed_permissions() {
        use super::{ensure, invoke, verify, TrustKind, TrustPolicy};
        use std::os::windows::process::CommandExt;
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("private");
        let file = directory.join("secret.txt");
        ensure(&[(TrustKind::Directory, &directory)]).unwrap();
        std::fs::write(&file, b"preserved").unwrap();
        ensure(&[(TrustKind::File, &file)]).unwrap();
        let expected = |valid: bool| {
            let paths = [
                (TrustKind::Directory, directory.as_path()),
                (TrustKind::File, file.as_path()),
            ];
            assert_eq!(verify(&paths).is_ok(), valid);
            let targets = paths
                .iter()
                .map(|(kind, path)| (*kind, TrustPolicy::CurrentUserOnly, *path))
                .collect::<Vec<_>>();
            assert_eq!(invoke("verify", &targets).is_ok(), valid);
        };
        expected(true);
        let start = std::time::Instant::now();
        for _ in 0..100 {
            verify(&[(TrustKind::Directory, &directory), (TrustKind::File, &file)]).unwrap();
        }
        println!("100 fresh native ACL checks: {:?}", start.elapsed());
        let encoded = super::base64_utf8(&file.to_string_lossy());
        for mutation in [
            "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow))",
            "$acl.SetAccessRuleProtection($false,$false)",
            "foreach($r in @($acl.Access)){[void]$acl.RemoveAccessRuleAll($r)}; $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::Modify,[Security.AccessControl.AccessControlType]::Allow))",
            "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Deny))",
        ] {
            let program = format!("$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}')); $acl=Get-Acl -LiteralPath $p; {mutation}; Set-Acl -LiteralPath $p -AclObject $acl");
            let output = std::process::Command::new(super::powershell_path().unwrap())
                .args(super::encoded_powershell_command(&program)).creation_flags(0x08000000).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            expected(false);
            ensure(&[(TrustKind::File, &file)]).unwrap();
            expected(true);
        }
        assert_eq!(std::fs::read(&file).unwrap(), b"preserved");
        assert!(verify(&[(TrustKind::File, &directory)]).is_err());
        assert!(verify(&[(TrustKind::Directory, &file)]).is_err());
        assert!(verify(&[(TrustKind::File, &directory.join("missing"))]).is_err());
        assert!(verify(&[]).is_err());
        // Junction creation needs no symlink privilege. The real underlying
        // target is trusted; its redirected spelling must still be rejected.
        let junction = temp.path().join("junction");
        let output = std::process::Command::new(super::powershell_path().unwrap())
            .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:STATION_TEST_JUNCTION -Target $env:STATION_TEST_TARGET | Out-Null"])
            .env("STATION_TEST_JUNCTION", &junction).env("STATION_TEST_TARGET", &directory)
            .creation_flags(0x08000000).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(verify(&[(TrustKind::File, &junction.join("secret.txt"))]).is_err());
        let targets = [(
            TrustKind::File,
            TrustPolicy::CurrentUserOnly,
            junction.join("secret.txt"),
        )];
        assert!(invoke("verify", &[(targets[0].0, targets[0].1, &targets[0].2)]).is_err());
        std::fs::remove_dir(&junction).unwrap();
    }

    #[test]
    fn only_accepts_the_structured_acl_verification_result() {
        assert!(result_is_trusted(br#"{"trusted":true}"#));
        assert!(!result_is_trusted(br#"{"trusted":false}"#));
        assert!(!result_is_trusted(b"localized result"));
    }

    #[test]
    fn encoded_program_has_no_post_command_arguments() {
        let args = encoded_powershell_command("Write-Output ok");
        assert_eq!(args.len(), 4);
        assert_eq!(args[2], "-EncodedCommand");
    }

    #[test]
    fn execution_trust_checks_inherited_aces() {
        assert!(TRUST_SCRIPT.contains("GetAccessRules($true, $true"));
    }
}
