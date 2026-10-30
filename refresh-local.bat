@echo off
cd /d "%~dp0"
node --test
if errorlevel 1 goto end
node src/update.mjs
:end
pause
