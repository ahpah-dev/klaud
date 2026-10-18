@echo off
rem ---------------------------------------------------------------------------
rem  Publish the marketing site (site\) to https://klaud-app.vercel.app
rem
rem  Vercel only auto-aliases the project's default domains, so this does two
rem  things: deploys site\ to production, then points klaud-app.vercel.app at
rem  the deployment it just created. Run it after any site change.
rem
rem  Needs the Vercel CLI (npx pulls it) and an active login/OIDC token.
rem ---------------------------------------------------------------------------
setlocal

cd /d "%~dp0site"

echo.
echo   Deploying site\ to production...
echo.
set "DEPLOY_URL="
for /f "delims=" %%U in ('npx --no-install vercel deploy --prod --yes 2^>nul') do if not defined DEPLOY_URL set "DEPLOY_URL=%%U"

if not defined DEPLOY_URL (
  echo   Deploy failed. Run this by hand to see why:
  echo.
  echo       cd site ^&^& npx vercel deploy --prod
  echo.
  pause
  exit /b 1
)

echo   Deployment: %DEPLOY_URL%
echo   Pointing klaud-app.vercel.app at it...
npx --no-install vercel alias set "%DEPLOY_URL%" klaud-app.vercel.app
if errorlevel 1 (
  echo.
  echo   The deploy succeeded but the alias did not. Retry with:
  echo.
  echo       npx vercel alias set %DEPLOY_URL% klaud-app.vercel.app
  echo.
  pause
  exit /b 1
)

echo.
echo   Done. https://klaud-app.vercel.app
echo.
pause
endlocal