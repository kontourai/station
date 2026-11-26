; Station NSIS installer hooks (station#3379).
;
; The stock uninstaller emits a per-file `Delete` for every file in the build
; it was generated from, then `RMDir` (no /r) on the directories. That removes
; a clean install of the SAME build, but it can only name files that build
; contains: anything whose path changed between versions is never named again,
; survives the uninstall, and leaves its directory non-empty so the `RMDir`
; fails too. Because install also overlays rather than replaces, those orphans
; accumulate. Measured on a real host: an upgraded tree held 62,656 files
; against 34,844 for a clean install of the identical build, and uninstalling
; it exited 0 while leaving 27,812 files behind — exactly the difference.
;
; That matters beyond disk. Node resolves from `node_modules`, so a file
; deleted between versions stays resolvable after an upgrade, and the shipped
; build is not the tree that runs.
;
; Both hooks operate only on $INSTDIR. NSIS derives $INSTDIR from the location
; of uninstall.exe, so it is always the directory this app was installed into.
; Station's shared user root is STATION_ROOT (%USERPROFILE%\.station by
; default); STATION_HOME is one channel runtime leaf beneath it. Neither lives
; here, and the packaged runtime treats $INSTDIR as read-only.

!include "${__FILEDIR__}\..\dist-desktop-wix-resources\installer-path-budget.nsh"

!macro NSIS_HOOK_PREINSTALL
  Push $0
  StrLen $0 "$INSTDIR"
  ${If} $0 > ${STATION_WINDOWS_MAX_INSTALL_ROOT}
    Pop $0
    MessageBox MB_ICONSTOP|MB_OK "The installation folder is too long. Choose a shorter folder (at most ${STATION_WINDOWS_MAX_INSTALL_ROOT} characters), such as C:\Station, to keep Station's runtime files within Windows path limits. Runtime extraction has been stopped." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  Pop $0

  ; Ask before destroying anything. The template's own running-app check runs
  ; AFTER this hook, so without this the resource directories would already be
  ; gone by the time the user is asked whether Station may be closed — and
  ; cancelling would leave a gutted install behind. Files held open by a live
  ; sidecar (node-pty, esbuild) also fail to delete, so the copy that follows
  ; would overwrite an inconsistent tree.
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Clear the directory resources so this install replaces the previous build
  ; instead of merging with it. Each is fully re-created by the copy that
  ; follows. Keep this list in step with `bundle.resources` in
  ; tauri.windows.conf.json — a resource directory that is renamed or dropped
  ; stops being cleared here and accumulates until the next uninstall.
  RMDir /r "$INSTDIR\node_modules"
  RMDir /r "$INSTDIR\dist-server"
  RMDir /r "$INSTDIR\schemas"
  RMDir /r "$INSTDIR\examples"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; The template has already deleted every file the current build names.
  ; Anything still here belongs to a build that no longer exists, so
  ; uninstalling must take it — otherwise "uninstalled" leaves most of the
  ; application on disk.
  ;
  ; Accepted trade, stated deliberately: this removes $INSTDIR wholesale, so a
  ; user who installed into a directory they also keep other files in loses
  ; those too. That is standard NSIS practice and is what makes the residual
  ; provably zero; the alternative — recursing only into the three resource
  ; directories — would spare foreign files but silently keep orphans from any
  ; resource directory added later without updating these hooks.
  RMDir /r "$INSTDIR"
!macroend
