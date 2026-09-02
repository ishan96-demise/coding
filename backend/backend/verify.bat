@echo off
setlocal
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" (set "PY=.venv\Scripts\python.exe") else (set "PY=python")
%PY% verify.py
if errorlevel 1 (echo. & echo Verification FAILED. & pause & exit /b 1)
echo.
echo Verification PASSED.
pause
endlocal
