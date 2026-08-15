@echo off
setlocal

call "%AIMONITOR_VSDEVCMD%" -no_logo -arch=%AIMONITOR_VS_ARCH% -host_arch=%AIMONITOR_VS_ARCH%
if errorlevel 1 exit /b %ERRORLEVEL%

cd /d "%AIMONITOR_DESKTOP_ROOT%"
call "%AIMONITOR_TAURI_CMD%" %AIMONITOR_TAURI_MODE%
exit /b %ERRORLEVEL%
