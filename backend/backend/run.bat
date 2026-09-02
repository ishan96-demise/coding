@echo off
setlocal EnableExtensions
title FinSentinels - Fraud Network Intelligence

cd /d "%~dp0"

echo.
echo ============================================================
echo                 FinSentinels - PS-29
echo          Fraud Network Intelligence Platform
echo ============================================================
echo.

REM ============================================================
REM Find Python 3.10+
REM ============================================================

set "PYTHON_CMD="

where py >nul 2>&1
if not errorlevel 1 (
    py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
    if not errorlevel 1 set "PYTHON_CMD=py -3"
)

if not defined PYTHON_CMD (
    where python >nul 2>&1
    if not errorlevel 1 (
        python -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
        if not errorlevel 1 set "PYTHON_CMD=python"
    )
)

if not defined PYTHON_CMD (
    echo [ERROR] Python 3.10 or newer was not found.
    echo.
    echo Install Python from:
    echo https://www.python.org/downloads/
    echo.
    echo During installation, enable:
    echo "Add Python to PATH"
    echo.
    pause
    exit /b 1
)

echo [OK] Python detected:
%PYTHON_CMD% --version

REM ============================================================
REM Create virtual environment
REM ============================================================

echo.
echo [1/3] Checking virtual environment...

if not exist "%~dp0.venv\Scripts\python.exe" (
    echo Creating local virtual environment...
    %PYTHON_CMD% -m venv "%~dp0.venv"

    if errorlevel 1 (
        echo.
        echo [ERROR] Could not create the virtual environment.
        pause
        exit /b 1
    )

    echo [OK] Virtual environment created.
) else (
    echo [OK] Virtual environment already exists.
)

set "PY=%~dp0.venv\Scripts\python.exe"

if not exist "%PY%" (
    echo.
    echo [ERROR] Virtual environment Python was not found.
    pause
    exit /b 1
)

REM ============================================================
REM Install dependencies only when required
REM ============================================================

echo.
echo [2/3] Checking dependencies...

"%PY%" -c "import fastapi, uvicorn, networkx, pydantic" >nul 2>&1

if errorlevel 1 (
    echo Installing required dependencies...
    echo.

    "%PY%" -m pip install --disable-pip-version-check --upgrade pip

    if errorlevel 1 (
        echo.
        echo [ERROR] Failed to update pip.
        pause
        exit /b 1
    )

    "%PY%" -m pip install --disable-pip-version-check -r "%~dp0requirements.txt"

    if errorlevel 1 (
        echo.
        echo [ERROR] Dependency installation failed.
        pause
        exit /b 1
    )

    echo.
    echo [OK] Dependencies installed.
) else (
    echo [OK] Dependencies already installed.
)

REM ============================================================
REM Start application
REM ============================================================

echo.
echo [3/3] Starting FinSentinels...
echo.
echo ------------------------------------------------------------
echo Dashboard:
echo http://127.0.0.1:8000/
echo.
echo API Docs:
echo http://127.0.0.1:8000/docs
echo ------------------------------------------------------------
echo.
echo Press CTRL+C in this window to stop FinSentinels.
echo.

REM Open browser after a short delay so Uvicorn has time to start.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:8000/"

"%PY%" -m uvicorn main:app --host 127.0.0.1 --port 8000

echo.
echo FinSentinels has stopped.
pause
exit /b 0