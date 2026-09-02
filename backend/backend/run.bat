@echo off
setlocal
title FinSentinels - Fraud Network Intelligence

cd /d "%~dp0"

echo ==========================================
echo        FinSentinels
echo   Fraud Network Intelligence
echo ==========================================
echo.

REM ------------------------------------------
REM Find Python
REM ------------------------------------------
set "PYTHON="

where py >nul 2>&1
if %errorlevel%==0 (
    py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
    if %errorlevel%==0 set "PYTHON=py -3"
)

if not defined PYTHON (
    where python >nul 2>&1
    if %errorlevel%==0 (
        python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
        if %errorlevel%==0 set "PYTHON=python"
    )
)

if not defined PYTHON (
    echo ERROR: Python 3.10 or newer is required.
    echo Install Python from https://www.python.org/downloads/
    echo Make sure Python is added to PATH.
    pause
    exit /b 1
)

REM ------------------------------------------
REM Create virtual environment if needed
REM ------------------------------------------
if not exist "%~dp0.venv\Scripts\python.exe" (
    echo Creating virtual environment...
    %PYTHON% -m venv "%~dp0.venv"

    if errorlevel 1 (
        echo.
        echo ERROR: Failed to create virtual environment.
        pause
        exit /b 1
    )
)

set "PY=%~dp0.venv\Scripts\python.exe"

REM ------------------------------------------
REM Install dependencies only when needed
REM ------------------------------------------
"%PY%" -c "import fastapi, uvicorn, networkx" >nul 2>&1

if errorlevel 1 (
    echo Installing required packages...
    "%PY%" -m pip install --upgrade pip
    "%PY%" -m pip install -r "%~dp0requirements.txt"

    if errorlevel 1 (
        echo.
        echo ERROR: Dependency installation failed.
        pause
        exit /b 1
    )
)

REM ------------------------------------------
REM Start server
REM ------------------------------------------
echo.
echo Starting FinSentinels...
echo.
echo Dashboard:
echo http://127.0.0.1:8000
echo.
echo Press CTRL+C to stop the server.
echo.

start "" http://127.0.0.1:8000

"%PY%" -m uvicorn main:app --host 127.0.0.1 --port 8000

echo.
echo Server stopped.
pause