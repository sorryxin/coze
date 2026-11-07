@echo off
setlocal
cd /d "%~dp0"

set "NODE_DIR=%~dp0.toolchain\node-v22.14.0-win-x64"
if not exist "%NODE_DIR%\node.exe" goto :nonode
set "PATH=%NODE_DIR%;%PATH%"

if not exist "apps\web\dist\index.html" goto :build
goto :serve

:nonode
echo [ERROR] Portable Node not found at:
echo         %NODE_DIR%
echo Make sure the .toolchain folder was extracted together with this file.
pause
exit /b 1

:build
echo [INFO] Frontend build not found, building now...
call npm run build
if errorlevel 1 goto :buildfail
goto :serve

:buildfail
echo [ERROR] Build failed.
pause
exit /b 1

:serve
echo.
echo   Shadow Classroom
echo   Open your browser at:  http://127.0.0.1:8787
echo   Close this window to stop the server.
echo.
start "" http://127.0.0.1:8787
node --experimental-strip-types apps/server/src/index.ts

echo.
echo Server stopped.
pause
