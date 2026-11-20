@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Este computador (%COMPUTERNAME%) vai ASSUMIR o robo do resgate de banho.
echo O robo do outro computador fica em espera sozinho.
choice /c SN /m "Confirma"
if errorlevel 2 exit /b 0
if not exist dados mkdir dados
echo assumir> dados\assumir.flag
taskkill /fi "WINDOWTITLE eq Robo Resgate Banho*" /f >nul 2>nul
wscript "%~dp0iniciar-oculto.vbs"
echo Pronto. Confira na janela do robo: "Este computador (%COMPUTERNAME%) assumiu o robo".
pause
