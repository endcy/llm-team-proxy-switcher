@echo off
chcp 65001 >nul 2>&1
title llm-team-proxy-switcher

echo.
echo  ╔════════════════════════════════════════════════════════╗
echo  ║   llm-team-proxy-switcher - One-click Start           ║
echo  ╚════════════════════════════════════════════════════════╝
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js not found. Please install Node.js first.
    echo  Download: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: Show Node.js version
echo  Node.js: & node -v
echo.

:: Check config.json
if not exist "%~dp0config.json" (
    echo  [WARN] config.json not found, creating default...
    echo {> "%~dp0config.json"
    echo   "port": 9982,>> "%~dp0config.json"
    echo   "bind": "0.0.0.0",>> "%~dp0config.json"
    echo   "upstream": "",>> "%~dp0config.json"
    echo   "providers": []>> "%~dp0config.json"
    echo }>> "%~dp0config.json"
    echo  [INFO] Default config.json created. Please edit it before use.
    echo.
)

:: Start proxy
echo  Starting proxy...
echo.
cd /d "%~dp0"
node proxy.js

:: If proxy exits, pause so user can see the error
echo.
echo  [INFO] Proxy stopped.
pause
