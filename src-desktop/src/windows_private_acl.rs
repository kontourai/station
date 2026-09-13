//! Fresh read-only equivalents of the current-user PowerShell ACL checks.
//! No descriptor or filesystem authority is cached. Mutation still uses the
//! existing setter; using Win32 here removes shell startup from every read.

use super::TrustKind;
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::path::Path;
use std::ptr::{addr_of, null_mut};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_NO_TOKEN, HANDLE,
};
use windows_sys::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
use windows_sys::Win32::Security::{
    EqualSid, GetAce, GetSecurityDescriptorControl, GetTokenInformation, IsValidAcl,
    IsValidSecurityDescriptor, IsValidSid, TokenUser, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL,
    DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSID, SE_DACL_PROTECTED, TOKEN_QUERY,
    TOKEN_USER,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken,
};

struct Token(HANDLE);
impl Drop for Token {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct Descriptor(*mut c_void);
impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn os_error(label: &str) -> String {
    format!("{label}: {}", std::io::Error::last_os_error())
}

// usize storage provides TOKEN_USER alignment and owns the referenced SID.
fn current_user() -> Result<Vec<usize>, String> {
    let mut handle = null_mut();
    unsafe {
        if OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut handle) == 0 {
            if GetLastError() != ERROR_NO_TOKEN {
                return Err(os_error("read effective Windows token"));
            }
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut handle) == 0 {
                return Err(os_error("read Windows process token"));
            }
        }
        let token = Token(handle);
        let mut required = 0;
        GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut required);
        if required < std::mem::size_of::<TOKEN_USER>() as u32 || required > 65_536 {
            return Err("invalid Windows user token size".into());
        }
        let mut buffer = vec![0usize; (required as usize).div_ceil(std::mem::size_of::<usize>())];
        if GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            required,
            &mut required,
        ) == 0
        {
            return Err(os_error("read Windows user token"));
        }
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
        if user.User.Sid.is_null() || IsValidSid(user.User.Sid) == 0 {
            return Err("invalid Windows user SID".into());
        }
        Ok(buffer)
    }
}

fn check_path(path: &Path, kind: TrustKind) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Windows trust requires an absolute path".into());
    }
    // Inspect every existing component, including junctions and other reparse
    // points, before asking the OS for the target's security descriptor.
    for component in path.ancestors() {
        let metadata = std::fs::symlink_metadata(component).map_err(|error| {
            format!(
                "inspect Windows trust path {}: {error}",
                component.display()
            )
        })?;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(format!(
                "Station trust path contains a reparse point: {}",
                component.display()
            ));
        }
    }
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("inspect Windows trust target: {error}"))?;
    if !match kind {
        TrustKind::Directory => metadata.is_dir(),
        TrustKind::File => metadata.is_file(),
    } {
        return Err(format!(
            "Station trust path kind changed: {}",
            path.display()
        ));
    }
    Ok(())
}

fn verify_descriptor(path: &Path, sid: PSID) -> Result<(), String> {
    let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if wide.contains(&0) {
        return Err("Windows trust path contains NUL".into());
    }
    wide.push(0);
    let mut owner = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor = null_mut();
    // All subordinate pointers belong to the descriptor allocated by Win32.
    // Keep it alive until inspection is complete and free it on every return.
    unsafe {
        let status = GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        );
        if status != 0 {
            if !descriptor.is_null() {
                LocalFree(descriptor);
            }
            return Err(format!(
                "read Windows ACL {}: {}",
                path.display(),
                std::io::Error::from_raw_os_error(status as i32)
            ));
        }
        let descriptor = Descriptor(descriptor);
        if descriptor.0.is_null()
            || IsValidSecurityDescriptor(descriptor.0) == 0
            || owner.is_null()
            || IsValidSid(owner) == 0
            || dacl.is_null()
            || IsValidAcl(dacl) == 0
        {
            return Err("Windows trust descriptor is invalid or grants unrestricted access".into());
        }
        let mut control = 0;
        let mut revision = 0;
        if GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) == 0 {
            return Err(os_error("read Windows ACL protection"));
        }
        if control & SE_DACL_PROTECTED == 0 || EqualSid(owner, sid) == 0 {
            return Err(format!(
                "Station trust ACL is not current-user protected: {}",
                path.display()
            ));
        }
        if (*dacl).AceCount != 1 {
            return Err(format!(
                "Station trust ACL has unrelated entries: {}",
                path.display()
            ));
        }
        let mut raw_ace = null_mut();
        if GetAce(dacl, 0, &mut raw_ace) == 0 || raw_ace.is_null() {
            return Err(os_error("read Windows ACL entry"));
        }
        let header = &*raw_ace.cast::<ACE_HEADER>();
        // ACCESS_ALLOWED_ACE_TYPE=0. SidStart follows the eight-byte header
        // and mask. Check its complete variable-length bounds before SID APIs.
        if header.AceType != 0 || header.AceSize < 16 || header.AceFlags & 0x08 != 0 {
            return Err("Windows trust ACL is not a plain allow entry".into());
        }
        let ace = &*raw_ace.cast::<ACCESS_ALLOWED_ACE>();
        let ace_sid = addr_of!(ace.SidStart).cast::<u8>();
        let subauthorities = *ace_sid.add(1) as usize;
        if subauthorities > 15 || 8 + 8 + subauthorities * 4 > ace.Header.AceSize as usize {
            return Err("Windows trust ACL SID exceeds its entry".into());
        }
        let ace_sid = ace_sid.cast_mut().cast::<c_void>();
        if IsValidSid(ace_sid) == 0
            || EqualSid(ace_sid, sid) == 0
            || ace.Mask & 0x001f01ff != 0x001f01ff
        {
            return Err(format!("Station trust ACL permits an unrelated principal or lacks current-user control: {}", path.display()));
        }
    }
    Ok(())
}

pub(super) fn verify(paths: &[(TrustKind, &Path)]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("Windows trust needs a path".into());
    }
    let user = current_user()?;
    // The aligned token buffer owns this SID through the entire operation.
    let sid = unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    for (kind, path) in paths {
        check_path(path, *kind)?;
        verify_descriptor(path, sid)?;
    }
    Ok(())
}
