@echo off
rem ---------------------------------------------------------------------------
rem  Publish Klaud to GitHub.
rem
rem  Run this once. It creates the public repository ahpah-dev/klaud, pushes
rem  main, and pushes the v1.0 tag.
rem
rem  It needs you logged in first. If it says you are not, run:
rem      gh auth login
rem  and choose GitHub.com, HTTPS, and "Login with a web browser".
rem ---------------------------------------------------------------------------
setlocal

where gh >nul 2>nul
if errorlevel 1 (
  echo.
  echo   The GitHub CLI ^(gh^) was not found on your PATH.
  echo   Install it from https://cli.github.com and run this again.
  echo.
  pause
  exit /b 1
)

gh auth status >nul 2>nul
if errorlevel 1 (
  echo.
  echo   You are not logged in to GitHub yet.
  echo   Run this first, then try again:
  echo.
  echo       gh auth login
  echo.
  pause
  exit /b 1
)

cd /d "%~dp0"

echo.
echo   Creating the repository and pushing...
echo.
gh repo create klaud --public --source . --remote origin --push ^
  --description "A local coding agent that runs free. Bring your own key, or none at all. Zero dependencies."
if errorlevel 1 (
  echo.
  echo   Could not create the repository. Read the message above.
  echo   If it already exists, push to it directly with:
  echo       git remote add origin https://github.com/ahpah-dev/klaud.git
  echo       git push -u origin main
  echo.
  pause
  exit /b 1
)

git push origin v1.0
if errorlevel 1 (
  echo.
  echo   The repository was created, but the v1.0 tag did not push.
  echo   Retry with:  git push origin v1.0
  echo.
  pause
  exit /b 1
)

echo.
echo   Done. https://github.com/ahpah-dev/klaud
echo   Tag v1.0 published.
echo.
pause
endlocal
