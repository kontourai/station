@echo off
rem Station portable launcher, for people at a Windows prompt. It runs the
rem Node.js bundled in this archive, never a Node.js on PATH.
rem
rem A supervisor (service manager, installer, another program) must not go
rem through cmd.exe: spawn runtime\node.exe with bin\station.mjs and the
rem arguments directly, with the archive root as the working directory and
rem STATION_INVOKED_CWD set to the caller's directory.
rem
rem No argument is inspected here, so quotes inside an argument are never
rem parsed by batch logic; they reach Node.js as typed.
setlocal
set "STATION_INVOKED_CWD=%CD%"
cd /d "%~dp0.."
"%~dp0..\runtime\node.exe" "%~dp0station.mjs" %*
exit /b %ERRORLEVEL%
