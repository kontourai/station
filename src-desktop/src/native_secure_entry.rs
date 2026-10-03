//! Host-only entries for desktop keyrings and device-bound mobile storage.

pub(crate) struct NativeSecureEntry {
    #[cfg(not(mobile))]
    entry: keyring_core::Entry,
    #[cfg(mobile)]
    store: tauri_plugin_keyring_store::KeyringStore,
    #[cfg(mobile)]
    account: String,
}

impl NativeSecureEntry {
    pub(crate) fn new(service: &'static str, account: &str) -> keyring_core::Result<Self> {
        #[cfg(not(mobile))]
        {
            Ok(Self {
                entry: keyring_core::Entry::new(service, account)?,
            })
        }
        #[cfg(mobile)]
        {
            let store = tauri_plugin_keyring_store::KeyringStore::new(service);
            #[cfg(target_os = "ios")]
            let store = store.with_write_accessibility(
                tauri_plugin_keyring_store::WriteAccessibility::AfterFirstUnlockThisDeviceOnly,
            );
            Ok(Self {
                store,
                account: account.to_owned(),
            })
        }
    }

    pub(crate) fn get_password(&self) -> keyring_core::Result<String> {
        #[cfg(not(mobile))]
        {
            self.entry.get_password()
        }
        #[cfg(mobile)]
        {
            // Foreground reads distinguish absence from locked/protected data.
            // The plugin's background convenience read intentionally cannot.
            self.store
                .get_password(&self.account)
                .map_err(mobile_error)?
                .ok_or(keyring_core::Error::NoEntry)
        }
    }

    pub(crate) fn set_password(&self, value: &str) -> keyring_core::Result<()> {
        #[cfg(not(mobile))]
        {
            self.entry.set_password(value)
        }
        #[cfg(mobile)]
        {
            self.store
                .set_password(&self.account, value)
                .map_err(mobile_error)
        }
    }

    pub(crate) fn delete_credential(&self) -> keyring_core::Result<()> {
        #[cfg(not(mobile))]
        {
            self.entry.delete_credential()
        }
        #[cfg(mobile)]
        {
            self.store.delete(&self.account).map_err(mobile_error)
        }
    }
}

#[cfg(mobile)]
fn mobile_error(error: tauri_plugin_keyring_store::Error) -> keyring_core::Error {
    match error {
        tauri_plugin_keyring_store::Error::NoEntry => keyring_core::Error::NoEntry,
        tauri_plugin_keyring_store::Error::KeychainLocked => {
            keyring_core::Error::NoStorageAccess(Box::new(error))
        }
        _ => keyring_core::Error::PlatformFailure(Box::new(error)),
    }
}
