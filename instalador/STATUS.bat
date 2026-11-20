@echo off
chcp 65001 >nul
title Robo Resgate Banho - STATUS (pode fechar, o robo continua rodando)
cd /d "%~dp0"
echo Ultimas mensagens do robo (atualiza sozinho). Fechar esta janela NAO para o robo.
echo.
powershell -NoProfile -Command "Get-Content -Path 'dados\robo.log' -Tail 40 -Wait -Encoding UTF8"
