@echo off
title ClaudeUsage
cd /d "%~dp0"

:: ================================================
:: Przyklad _dev.bat dla tego typu projektu:
:: H:\_Dev\repos\products\pdflang\_dev.bat
:: Dostosuj ponizszy szablon do swoich potrzeb.
:: ================================================

echo.
echo === ClaudeUsage - DEV ===
echo.
echo [1] Killing old process on port 3016...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3016 " ^| findstr "LISTENING"') do (
    echo     Killing PID %%a
    taskkill /PID %%a /F >nul 2>&1
)
echo [2] Installing dependencies...
call pnpm install
echo [3] Opening browser...
start "" http://localhost:3016
echo [4] Starting dev server...
call pnpm run dev
pause
