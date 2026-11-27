@echo off
chcp 65001 >nul
title Instalar o agente de impressao
cd /d "%~dp0"
set "DESTINO=C:\AgenteBanho"
set NODEVER=v22.12.0
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0.' -Recurse -File | Unblock-File" >nul 2>nul
if not exist "%~dp0agente.js" (echo Abra o ZIP, clique em "Extrair tudo" e rode o INSTALAR-AGENTE.bat da pasta extraida. & pause & exit /b 1)
if /i not "%~dp0"=="%DESTINO%\" (
  if not exist "%DESTINO%" mkdir "%DESTINO%"
  robocopy "%~dp0." "%DESTINO%" /E /XD node node_modules dados /XF node.zip config.json /NFL /NDL /NJH /NJS /NP >nul
  start "Instalar o agente de impressao" /d "%DESTINO%" "%DESTINO%\INSTALAR-AGENTE.bat"
  exit /b 0
)
if not exist "node\node.exe" (
  echo Baixando o Node.js - so nesta pasta...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest 'https://nodejs.org/dist/%NODEVER%/node-%NODEVER%-win-x64.zip' -OutFile node.zip"
  if not exist "node.zip" (echo Sem internet para baixar o Node.js. & pause & exit /b 1)
  tar -xf node.zip 2>nul
  if exist "node-%NODEVER%-win-x64\node.exe" ren "node-%NODEVER%-win-x64" node
  del /q node.zip
)
if not exist "node\node.exe" (echo Nao consegui preparar o Node.js. Mande um print desta janela. & pause & exit /b 1)
set "PATH=%~dp0node;%PATH%"
echo Instalando os componentes...
call npm install --omit=dev --no-audit --no-fund >nul || (echo Falha ao instalar componentes. & pause & exit /b 1)
node instalar-agente.js
pause
