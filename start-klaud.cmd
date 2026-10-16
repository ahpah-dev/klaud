@echo off
rem ---------------------------------------------------------------
rem  Klaud launcher (Windows)
rem  Starts the local server and opens the UI in your browser.
rem ---------------------------------------------------------------
setlocal

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is required but was not found on your PATH.
  echo   Install it from https://nodejs.org  ^(LTS is fine^) and try again.
  echo.
  pause
  exit /b 1
)

cd /d "%~dp0"
echo.
echo   Starting Klaud...
node src\server.js --open

if errorlevel 1 (
  echo.
  echo   Klaud exited with an error. Read the message above.
  echo.
  pause
)
endlocal
