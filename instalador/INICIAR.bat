@echo off
chcp 65001 >nul
title Robo Resgate Banho - NAO FECHE ESTA JANELA
cd /d "%~dp0"
set "PATH=%~dp0node;%PATH%"
:loop
node robo.js
echo O robo parou. Reiniciando em 5 segundos...
timeout /t 5 >nul
goto loop
