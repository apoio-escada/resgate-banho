@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Parando o robo...
taskkill /fi "WINDOWTITLE eq Robo Resgate Banho*" /f >nul 2>nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -or $_.Name -eq 'chrome.exe') -and $_.CommandLine -like '*%~dp0*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Robo Resgate Banho.lnk" >nul 2>nul
echo.
echo Pronto: o robo foi parado e nao inicia mais com o Windows.
echo Agora e so apagar a pasta %~dp0
pause
