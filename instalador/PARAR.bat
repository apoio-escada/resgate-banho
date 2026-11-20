@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Parando o robo do resgate...
rem 1) o laco do INICIAR (cmd), 2) o robo (node da pasta C:\RoboBanho\node), 3) os Chrome do perfil do robo
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process; $p | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*RoboBanho*INICIAR*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; $p | Where-Object { $_.Name -eq 'wscript.exe' -and $_.CommandLine -like '*iniciar-oculto*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 500; $p | Where-Object { $_.Name -eq 'node.exe' -and (($_.ExecutablePath -like '*RoboBanho*') -or ($_.CommandLine -like '*robo.js*')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 500; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*RoboBanho*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
if exist "dados\robo.lock" del /q "dados\robo.lock"
echo Robo parado. Para abrir de novo: atalho "Robo Banho" na area de trabalho.
pause
