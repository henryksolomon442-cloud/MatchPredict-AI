@echo off
title DigitEdge AI V24.7
cd /d "%~dp0"

echo.
echo ===========================================
echo   DigitEdge AI V24.7
echo ===========================================
echo.

if not exist node_modules (
  echo Installing required packages...
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo Installation failed. Make sure Node.js is installed.
    pause
    exit /b 1
  )
)

echo Starting DigitEdge AI...
start "DigitEdge AI Server" cmd /k "cd /d ""%~dp0"" && npm.cmd start"
timeout /t 3 /nobreak >nul
start "" "http://localhost:3000"

echo.
echo App should open in your browser.
echo If it does not, open: http://localhost:3000
echo.
pause
