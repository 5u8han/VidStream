@echo off
setlocal DisableDelayedExpansion
rem Keep the setup code visible and enable the folder picker in a single process.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0Start-Here.ps1"
set "VIDSTREAM_SETUP_STATUS=%ERRORLEVEL%"
pause
exit /b %VIDSTREAM_SETUP_STATUS%
