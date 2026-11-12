# Keyboard shortcuts

Open **Settings → Keyboard shortcuts** to search Station commands by their
plain-language names.

- Select a shortcut, then press the new key combination.
- If a new binding or restored default belongs to another registered command, Station explains the conflict before
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

## Command palette

Press **⌘K** on macOS or **Ctrl+K** on Windows and Linux to open the command
palette from anywhere in Station, including while you are typing in a field. It
does not open while another dialog is open, and you can rebind it under
**Settings → Keyboard shortcuts**. You can also choose **Search or jump to…**
in the header, which shows the current shortcut. On a phone it is a search
icon, so a touch device without a keyboard can open the palette too.

With nothing typed, the palette starts with **Suggestions** (such as New chat
and New Board), then **Recent** (up to five items you ran on this device,
newest first), then **Places** to go. Every other command follows under its
usual group. Rows with a shortcut show it.

Type to search. Results are grouped into commands, actions (such as opening the
chat dock, a new Board, the tour, **Troubleshoot an issue** or **Report a problem**), places to go,
plugins, Settings rows, open chats, Projects, workspace panes, Agents and
skills. After two characters it also searches chat messages.
Among close matches, items you use often rank higher; **Reset command history**
clears that. Choose
**Search Tasks and messages** at the top to switch to workspace search.

A command row shows its current shortcut, if it has one, so the palette doubles
as a way to learn them.

Use the arrow keys to move, Return to run the highlighted item, and Escape or a
click outside to close; a key legend at the bottom repeats this unless the
device's main pointer is touch. Running an item usually closes the palette and returns
focus to where you were, including to the header entry if you opened it there. Some items keep it open, such as
**Reset command history**, which shows whether the reset worked, and a message
found on another Station, which explains that it cannot be opened here.

## Shortcut list

Press **⌘/** on macOS or **Ctrl+/** on Windows and Linux, or **?** when focus is
not in a text field, to open the shortcut list. When two commands share a name and key and one always overrides the
other, the list shows only the one that runs.

## Editing chords stay with text

While focus is in a text input, textarea, select, contenteditable editor or
other text box, the editing chords (copy, cut, paste, undo, redo and select all) belong to that
field: a Station command bound to the same chord does not run. Copy and cut
also stay with any selected text elsewhere on the page, so copying part of a
transcript does not cancel a running turn.

## Return in chat

Choose **Chat settings → Return in chat** on each device. Automatic uses Return
to send on desktop and to insert a new line on touch devices. You can explicitly
choose either behavior, including for an attached tablet keyboard. Shift+Return
always inserts a line; Ctrl/Cmd+Return sends. Return never submits during IME
composition. During a turn, the shortcut uses the composer's selected Queue or
Steer mode. The same keys start a chat from the Home, Project page and New chat
composers. This preference is included in device-settings export/import.

## Restore a dismissed conversation

After dismissing an inbox conversation, choose **Undo** in the toast or press
**⌘Z** on macOS / **Ctrl+Z** on Windows and Linux. **Undo inbox dismissal** can
be rebound in Keyboard shortcuts. The command declines inside text fields,
contenteditable editors, CodeMirror and terminals, preserving their own Undo.
Dismissal does not stop work or delete conversation history.

## Undo the last action

After an action that offers **Undo** in a notice (currently deleting a Board or
moving it into a Project), press **⌘Z** on macOS or **Ctrl+Z** on Windows and
Linux to undo the most recent one. **Undo last action** can be rebound in
Keyboard shortcuts. Like **Undo inbox dismissal**, which shares the default
key, it declines inside text fields, contenteditable editors, CodeMirror and
terminals, and does nothing when no notice is waiting. When both have
something to undo, each press undoes one of them; choose **Undo** in a notice
to pick which. If an Undo can no longer apply, the notice says why.

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

The editor's replacement dialog considers the first matching enabled command,
including when restoring a default. It does not analyze all conditional overlaps
or guarantee that every chord is conflict-free. The catalog also depends on which
components have registered their commands in the current view.

Custom bindings containing Space currently store a key name that does not match
the standard keyboard event. [#2771](https://github.com/kontourai/station/issues/2771)
tracks the capture-to-dispatch correction; the defect was reproduced through
the mounted editor and registry with DOM events.

The [keyboard shortcut module](https://github.com/kontourai/station/blob/main/docs/architecture/module-map.md#keyboard-shortcuts)
connects these rules to the editor, registry, device store, import/export owner
and tests. DOM/storage tests do not qualify every physical keyboard, OS shortcut,
or native shell.

## Browser shortcuts

With the Browser experience Feature Preview enabled, Mod+Shift+J opens or focuses Browser from Coding. When Browser has focus, Mod+L focuses the address, Mod+R reloads, Mod+Shift+R reloads without cache, Mod+[/] moves through history, and Alt+Left/Right moves through history on non-macOS platforms. Mod+=, Mod+- and Mod+0 change or reset page zoom. Mod+T, Mod+W and Mod+Shift+T open, close and reopen Browser tabs in the desktop shell; web browsers reserve these keys. Mod means Command on macOS and Control elsewhere.

Mod+Shift+S takes a Browser screenshot even with the preview off and while the live page has focus. Screenshot to chat is a separate menu and palette action. The command palette also offers take control and hand back without default bindings. While the live page has focus, Station shortcuts, including kernel shortcuts such as Mod+K, are suppressed except the screenshot shortcut; Tab moves focus out of the page. Find in page is not available on the streamed host yet.

## Plugin shortcuts

Plugins register shortcuts with the SDK's `useShortcut`. They join the same
registry under `plugin.<plugin>.<id>`, so they appear in the shortcut list
(under **Plugins**) and in Settings, and an active modal suppresses them like
any other. A plugin cannot replace a Station shortcut through the SDK,
because no Station id starts with `plugin.`. Plugin shortcuts rank below
Station's own, so a Station shortcut on the same chord wins whichever
registered first; only Station's "go up a level" Escape fallback yields to a
plugin. Only a verified plugin's pane can register shortcuts.

The command palette (⌘K), Settings (⌘,) and the shortcut list (⌘/) are
reserved, so a user can always get back in control of a misbehaving plugin.
So are the text-editing chords: ⌘C, ⌘V, ⌘X, ⌘Z, ⇧⌘Z and ⌘A, which are Ctrl
off a Mac, and Ctrl+Y.
Station refuses a plugin chord that equals one of their defaults or their
current bindings. If you later move a reserved shortcut onto a plugin's chord,
or move a plugin shortcut onto a reserved one, the plugin's shortcut stops
firing. Off a Mac, `cmd` and `ctrl` are the same chord for this check. A
plugin chord with no Cmd, Ctrl or Alt never fires while focus is in a text
field.

These rules apply to shortcuts registered through the SDK. A plugin that
runs inside Station's own page can still listen for keys directly, so they
are not a sandbox.
