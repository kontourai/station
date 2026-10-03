# Keyboard shortcuts

Open **Settings → Keyboard shortcuts** to search Station commands by their
plain-language names.

- Select a shortcut, then press the new key combination.
- If the editor finds another registered command using it, Station explains the conflict before
  saving. Choose **Replace** to clear the old command and move the shortcut, or
  **Cancel** to leave both unchanged.
- **Clear** removes a shortcut. **Restore default** returns the command to its
  current registered default binding, which may come from a plugin or command skill.
- Each row has a context hint, with a technical hint under **Advanced**. These
  currently come from the command's ID, not its actual availability rule; they
  are not a live explanation of why a command can or cannot run.
  [#2767](https://github.com/kontourai/station/issues/2767) tracks that correction.
- Some known browser-reserved combinations carry a warning. They may work more reliably
  in the desktop app because a browser can intercept them first.

Shortcut changes are stored in this browser/app profile's versioned
`station-device-settings-v1` local-storage envelope. The older
`station.device-settings` record is a migration input. Overrides and command-skill
shortcuts are included in Settings export/import; they do not automatically
synchronize across Devices. The editor is read-only in the mobile layout,
including narrow desktop windows.

## Return in chat

Choose **Chat settings → Return in chat** on each device. Automatic uses Return
to send on desktop and to insert a new line on touch devices. You can explicitly
choose either behavior, including for an attached tablet keyboard. Shift+Return
always inserts a line; Ctrl/Cmd+Return sends. Return never submits during IME
composition. During a turn, the shortcut uses the composer's selected Queue or
Steer mode. This preference is included in device-settings export/import.

## Dispatch and limits

The registry orders matching shortcuts by priority, then registry order.
It checks the registered `when` expression and current input/modal state before
running a handler. An active modal suppresses global registry shortcuts;
Escape and chat shortcuts have additional input-ownership rules. A visible
row or saved binding does not bypass those conditions or a browser-reserved key.
A handler that returns `false` declines the key: it is not prevented, the next
matching shortcut is tried, and otherwise the browser keeps it. The Coding
stack's Back/Forward chords decline inside editors that own those keys
(CodeMirror, the terminal, a contenteditable editor) and when there is
nowhere to go; in plain text fields they are the stack's Back and Forward.

The editor's replacement dialog considers the first matching enabled command.
It does not analyze all conditional overlaps or guarantee that restoring a
default leaves every chord conflict-free. The catalog also depends on which
components have registered their commands in the current view.

Custom bindings containing Space currently store a key name that does not match
the standard keyboard event. [#2771](https://github.com/kontourai/station/issues/2771)
tracks the capture-to-dispatch correction; the defect was reproduced through
the mounted editor and registry with DOM events.

The [keyboard shortcut module](https://github.com/kontourai/station/blob/main/docs/architecture/module-map.md#keyboard-shortcuts)
connects these rules to the editor, registry, device store, import/export owner
and tests. DOM/storage tests do not qualify every physical keyboard, OS shortcut,
or native shell.
