@echo off
chcp 65001 >nul
title Instalar o robo do resgate de banho
cd /d "%~dp0"
set "DESTINO=C:\RoboBanho"
set NODEVER=v22.12.0
rem v2.15: tira a marca "baixado da internet" dos arquivos (o Windows/Controle Inteligente bloqueia scripts com essa marca)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0.' -Recurse -File | Unblock-File" >nul 2>nul
if not exist "%~dp0robo.js" (echo Abra o ZIP, clique em "Extrair tudo" e rode o INSTALAR.bat da pasta extraida. & pause & exit /b 1)
if /i not "%~dp0"=="%DESTINO%\" (
  echo Copiando para %DESTINO% ...
  if not exist "%DESTINO%" mkdir "%DESTINO%"
  taskkill /fi "WINDOWTITLE eq Robo Resgate Banho*" /f >nul 2>nul
  robocopy "%~dp0." "%DESTINO%" /E /XD node node_modules dados perfil-navegador Comprovantes /XF node.zip config.json /NFL /NDL /NJH /NJS /NP >nul
  if exist "%~dp0config.json" if not exist "%DESTINO%\config.json" copy "%~dp0config.json" "%DESTINO%\config.json" >nul
  start "Instalar o robo do resgate de banho" /d "%DESTINO%" "%DESTINO%\INSTALAR.bat"
  exit /b 0
)
if exist "node.zip" del /q "node.zip"
if not exist "node\node.exe" (
  echo Baixando o Node.js %NODEVER% - so nesta pasta...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest 'https://nodejs.org/dist/%NODEVER%/node-%NODEVER%-win-x64.zip' -OutFile node.zip"
  if not exist "node.zip" (echo Sem internet para baixar o Node.js. Confira e rode de novo. & pause & exit /b 1)
  tar -xf node.zip 2>nul
  if not exist "node-%NODEVER%-win-x64\node.exe" powershell -NoProfile -Command "Expand-Archive node.zip -DestinationPath . -Force"
  if exist "node-%NODEVER%-win-x64\node.exe" ren "node-%NODEVER%-win-x64" node
  del /q node.zip
)
if not exist "node\node.exe" (echo Nao consegui preparar o Node.js. Mande um print desta janela. & pause & exit /b 1)
set "PATH=%~dp0node;%PATH%"
echo Instalando os componentes do robo...
call npm install --omit=dev --no-audit --no-fund >nul || (echo Falha ao instalar componentes. Mande um print desta janela. & pause & exit /b 1)
node instalar.js
pause
