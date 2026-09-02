@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title FinSentinels - Fraud Network Intelligence

echo.
echo ============================================================
echo                 FINSENTINELS
echo          Fraud Network Intelligence
echo ============================================================
echo.

where py >nul 2>&1
if %errorlevel%==0 (set "PY=py") else (set "PY=python")

%PY% --version >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Python was not found.
  echo Install Python 3.10+ and try again.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [1/4] Creating virtual environment...
  %PY% -m venv .venv
  if errorlevel 1 goto :fail
) else (
  echo [1/4] Virtual environment found.
)

echo [2/4] Installing dependencies...
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt
if errorlevel 1 goto :fail

echo [3/4] Checking project...
".venv\Scripts\python.exe" verify.py
if errorlevel 1 goto :fail

echo [4/4] Starting server...
echo.
echo Dashboard: http://127.0.0.1:8000/
echo API docs: http://127.0.0.1:8000/docs
echo.
start "" http://127.0.0.1:8000/
".venv\Scripts\python.exe" -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
exit /b 0

:fail
echo.
echo [ERROR] FinSentinels could not start.
pause
exit /b 1
