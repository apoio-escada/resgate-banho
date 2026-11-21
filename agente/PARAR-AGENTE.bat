@echo off
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and ($_.ExecutablePath -like '*AgenteBanho*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
if exist "%~dp0dados\agente.lock" del /q "%~dp0dados\agente.lock"
echo Agente parado. Para abrir de novo: reinicie o computador ou de dois cliques em iniciar-agente-oculto.vbs
pause
