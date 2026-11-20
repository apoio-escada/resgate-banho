@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PATH=%~dp0node;%PATH%"
node teste-impressao.js %*
pause
