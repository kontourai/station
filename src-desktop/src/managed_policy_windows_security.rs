//! Machine-policy trust for the updater, matching managed-policy-windows.ts.
use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, GetSecurityInfo, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    GetAce, IsValidAcl, IsValidSecurityDescriptor, IsValidSid, ACE_HEADER, ACL,
    DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSID,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
};

struct LocalBuffer(*mut c_void);
impl Drop for LocalBuffer {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: each allocation is returned by a Win32 LocalAlloc API.
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

#[derive(Clone, Copy)]
enum Role {
    File,
    PolicyFolder,
    Ancestor,
}

const ADMINISTRATORS: &str = "S-1-5-32-544";
const SYSTEM: &str = "S-1-5-18";
const TRUSTED_INSTALLER: &str = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";

fn trusted_owner(sid: &str) -> bool {
    matches!(sid, ADMINISTRATORS | SYSTEM | TRUSTED_INSTALLER)
}

fn write_mask(role: Role) -> u32 {
    let take_over = 0x10000 | 0x40000 | 0x80000 | 0x02000000 | 0x10000000;
    match role {
        Role::File | Role::PolicyFolder => take_over | 0x40000000 | 0x2 | 0x4 | 0x10 | 0x40 | 0x100,
        Role::Ancestor => take_over | 0x40,
    }
}

// SAFETY: callers retain the descriptor allocation and pass a bounded SID.
unsafe fn sid_text(sid: PSID) -> Result<String, String> {
    if sid.is_null() || IsValidSid(sid) == 0 {
        return Err("the policy descriptor has no valid SID".into());
    }
    let mut text = null_mut();
    let converted = ConvertSidToStringSidW(sid, &mut text);
    let _allocation = LocalBuffer(text.cast());
    if converted == 0 || text.is_null() {
        return Err(format!(
            "read policy SID: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut length = 0;
    while *text.add(length) != 0 {
        length += 1;
    }
    Ok(String::from_utf16_lossy(std::slice::from_raw_parts(
        text, length,
    )))
}

// SAFETY: owner and DACL belong to the live, OS-validated descriptor.
unsafe fn check_descriptor(owner: PSID, dacl: *mut ACL, role: Role) -> Result<(), String> {
    let owner = sid_text(owner)?;
    if !trusted_owner(&owner) {
        return Err(format!(
            "owner {owner} is not Administrators, SYSTEM or TrustedInstaller"
        ));
    }
    if dacl.is_null() || IsValidAcl(dacl) == 0 {
        return Err("the policy descriptor has no valid access control list".into());
    }
    for index in 0..(*dacl).AceCount as u32 {
        let mut raw = null_mut();
        if GetAce(dacl, index, &mut raw) == 0 || raw.is_null() {
            return Err(format!(
                "read policy ACL entry: {}",
                std::io::Error::last_os_error()
            ));
        }
        let header = &*raw.cast::<ACE_HEADER>();
        // Plain, object, callback and callback-object allow ACEs grant access.
        // Inherit-only entries apply to children, which are checked themselves.
        if !matches!(header.AceType, 0 | 5 | 9 | 11) || header.AceFlags & 0x08 != 0 {
            continue;
        }
        let size = header.AceSize as usize;
        if size < 8 {
            return Err("truncated policy allow entry".into());
        }
        let bytes = std::slice::from_raw_parts(raw.cast::<u8>(), size);
        let mask = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        if mask & write_mask(role) == 0 {
            continue;
        }
        let mut sid_offset = 8;
        if matches!(header.AceType, 5 | 11) {
            if size < 12 {
                return Err("truncated policy object entry".into());
            }
            let flags = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
            if flags & !3 != 0 {
                return Err("unknown policy object entry flags".into());
            }
            sid_offset =
                12 + if flags & 1 != 0 { 16 } else { 0 } + if flags & 2 != 0 { 16 } else { 0 };
        }
        if sid_offset + 8 > size {
            return Err("truncated policy entry SID".into());
        }
        let subauthorities = bytes[sid_offset + 1] as usize;
        if subauthorities > 15 || sid_offset + 8 + subauthorities * 4 > size {
            return Err("policy entry SID exceeds its bounds".into());
        }
        let sid = sid_text(raw.cast::<u8>().add(sid_offset).cast())?;
        if !trusted_owner(&sid) && sid != "S-1-3-0" && sid != "S-1-3-4" {
            return Err(format!("the policy ACL grants write rights to {sid}"));
        }
    }
    Ok(())
}

fn check_handle(file: &File, role: Role) -> Result<(), String> {
    let metadata = file
        .metadata()
        .map_err(|error| format!("inspect policy object: {error}"))?;
    if metadata.file_attributes() & 0x400 != 0 {
        return Err("the policy path contains a reparse point".into());
    }
    if !matches!(role, Role::File) && !metadata.is_dir() {
        return Err("the policy path contains a non-directory ancestor".into());
    }
    let mut owner = null_mut();
    let mut dacl = null_mut();
    let mut descriptor = null_mut();
    // SAFETY: the open handle is live, and all out pointers reference local storage.
    // Owner/ACL pointers are used only while the returned allocation is alive.
    unsafe {
        let result = GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        );
        let allocation = LocalBuffer(descriptor);
        if result != 0 {
            return Err(format!(
                "read policy owner/ACL: {}",
                std::io::Error::from_raw_os_error(result as i32)
            ));
        }
        if allocation.0.is_null() || IsValidSecurityDescriptor(allocation.0) == 0 {
            return Err("invalid policy security descriptor".into());
        }
        check_descriptor(owner, dacl, role)
    }
}

pub(super) fn validate_path_chain(path: &Path, file: &File) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("the policy path is not absolute".into());
    }
    check_handle(file, Role::File).map_err(|error| format!("{}: {error}", path.display()))?;
    for (index, parent) in path.ancestors().skip(1).enumerate() {
        let directory = OpenOptions::new()
            .read(true)
            .access_mode(0x20000 | 0x80) // READ_CONTROL | FILE_READ_ATTRIBUTES
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(parent)
            .map_err(|error| format!("open policy ancestor {}: {error}", parent.display()))?;
        check_handle(
            &directory,
            if index == 0 {
                Role::PolicyFolder
            } else {
                Role::Ancestor
            },
        )
        .map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::{GetSecurityDescriptorDacl, GetSecurityDescriptorOwner};

    fn check(sddl: &str, role: Role) -> Result<(), String> {
        let wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
        let mut descriptor = null_mut();
        // SAFETY: the UTF-16 input is terminated; the OS owns the returned descriptor.
        unsafe {
            assert_ne!(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide.as_ptr(),
                    1,
                    &mut descriptor,
                    null_mut()
                ),
                0
            );
            let allocation = LocalBuffer(descriptor);
            let mut owner = null_mut();
            let mut defaulted = 0;
            let mut present = 0;
            let mut dacl = null_mut();
            assert_ne!(
                GetSecurityDescriptorOwner(allocation.0, &mut owner, &mut defaulted),
                0
            );
            assert_ne!(
                GetSecurityDescriptorDacl(allocation.0, &mut present, &mut dacl, &mut defaulted),
                0
            );
            check_descriptor(owner, if present != 0 { dacl } else { null_mut() }, role)
        }
    }

    #[test]
    fn stock_windows_11_descriptors_obey_the_same_roles_as_the_server() {
        // Captured on Windows 11 26200; same independent receipts as the server tests.
        let drive = format!("O:{TRUSTED_INSTALLER}D:PAI(A;;LC;;;AU)(A;OICIIO;SDGXGWGR;;;AU)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)(A;;0x1000a1;;;S-1-15-3-65536-1888954469-739942743-1668119174-2468466756-4239452838-1296943325-355587736-700089176)");
        let program_files = format!("O:{TRUSTED_INSTALLER}D:PAI(A;OICIIO;GA;;;CO)(A;OICIIO;GA;;;SY)(A;;0x1301bf;;;SY)(A;OICIIO;GA;;;BA)(A;;0x1301bf;;;BA)(A;OICIIO;GXGR;;;BU)(A;;0x1200a9;;;BU)(A;CIIO;GA;;;{TRUSTED_INSTALLER})(A;;FA;;;{TRUSTED_INSTALLER})(A;;0x1200a9;;;AC)(A;OICIIO;GXGR;;;AC)(A;;0x1200a9;;;S-1-15-2-2)(A;OICIIO;GXGR;;;S-1-15-2-2)");
        let folder = format!("O:BAD:AI(A;ID;FA;;;{TRUSTED_INSTALLER})(A;CIIOID;GA;;;{TRUSTED_INSTALLER})(A;ID;FA;;;SY)(A;OICIIOID;GA;;;SY)(A;ID;FA;;;BA)(A;OICIIOID;GA;;;BA)(A;ID;0x1200a9;;;BU)(A;OICIIOID;GXGR;;;BU)(A;OICIIOID;GA;;;CO)(A;ID;0x1200a9;;;AC)(A;OICIIOID;GXGR;;;AC)(A;ID;0x1200a9;;;S-1-15-2-2)(A;OICIIOID;GXGR;;;S-1-15-2-2)");
        for (sddl, role) in [(drive.as_str(), Role::Ancestor), (program_files.as_str(), Role::Ancestor), (folder.as_str(), Role::PolicyFolder), ("O:BAD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)(A;ID;0x1200a9;;;AC)(A;ID;0x1200a9;;;S-1-15-2-2)", Role::File)] {
            assert!(check(sddl, role).is_ok());
        }
    }

    #[test]
    fn live_windows_system_file_has_a_trusted_open_handle_chain() {
        let root = std::env::var_os("SystemRoot").expect("Windows system directory");
        let path = std::path::PathBuf::from(root).join("win.ini");
        let file = File::open(&path).expect("stock Windows win.ini");
        validate_path_chain(&path, &file).unwrap();
    }

    #[test]
    fn owner_and_effective_write_grants_fail_closed() {
        assert!(check("O:S-1-5-21-1-2-3-1001D:(A;;FA;;;SY)", Role::File).is_err());
        for (ace, role) in [
            ("(A;;FW;;;BU)", Role::File),
            ("(A;;WD;;;WD)", Role::File),
            ("(A;;0x2;;;BU)", Role::PolicyFolder),
            ("(A;;0x40;;;BU)", Role::Ancestor),
            ("(A;;SD;;;AU)", Role::Ancestor),
            ("(OA;;FA;;;BU)", Role::File),
        ] {
            assert!(check(&format!("O:BAD:(A;;FA;;;SY)(A;;FA;;;BA){ace}"), role).is_err());
        }
        assert!(check("O:BAD:NO_ACCESS_CONTROL", Role::File).is_err());
        assert!(check("O:BA", Role::File).is_err());
        assert!(check("O:BAD:(A;OICIIO;GA;;;BU)(D;;FA;;;BU)", Role::File).is_ok());
        assert!(check("O:SYD:(A;;LC;;;AU)", Role::Ancestor).is_ok());
        assert!(check("O:BAD:(A;;FA;;;OW)(A;;FA;;;CO)", Role::File).is_ok());
    }
}
