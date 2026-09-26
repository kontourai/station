@echo off
rem Station portable server launcher. It runs the Node.js runtime bundled in
rem this archive and never a Node.js found on PATH. It deliberately sets no
rem variables: anything set here would leak into the server's environment.
setlocal
if /i "%~1"=="--version" (
  "%~dp0..\runtime\node.exe" "%~dp0station-version.mjs" %*
) else if /i "%~1"=="-v" (
  "%~dp0..\runtime\node.exe" "%~dp0station-version.mjs" %*
) else (
  rem The server reads schemas\ relative to its working directory.
  cd /d "%~dp0.."
  "%~dp0..\runtime\node.exe" "%~dp0..\dist-server\command-station.js" %*
)
exit /b %ERRORLEVEL%
