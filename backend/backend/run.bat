@echo off
setlocal
title Fin Sentinels launcher

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-local.ps1"
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
pause
exit /b 1
