---
"@kontourai/station-cli": patch
---

Stop the CLI hanging on macOS Keychain dialogs. On macOS the CLI now reaches the Keychain through Apple's `/usr/bin/security` tool instead of an addon inside `node`. Keychain approval was tied to the exact `node` binary, which changes with every runtime upgrade, so each upgrade showed a new dialog and a non-interactive shell hung indefinitely. With the stable tool, one **Always Allow** keeps working across upgrades. Credentials saved by earlier versions ask once more, this time for `security`.

`station stations list`, `stations show`, and other status displays now check only whether a credential exists, and never show a Keychain dialog. Reading, storing, or deleting a credential gives up after 5 seconds without a terminal, or 2 minutes with one. It exits non-zero with an error that names the cause and the remedy: run the command once from a terminal and choose **Always Allow**, or unlock the keychain. Linux and Windows still use the native keyring addon.
