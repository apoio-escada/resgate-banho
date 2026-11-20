@echo off
chcp 65001 >nul
title Reinicio automatico - robo e totem do banho
set "ROBO=C:\RoboBanho"
set "URL_TOTEM=https://apoio-escada.github.io/resgate-banho/"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK_ROBO=%STARTUP%\Robo Resgate Banho.lnk"
set "LNK_TOTEM=%STARTUP%\Totem Resgate Banho.lnk"

:menu
cls
echo ==========================================================
echo   REINICIO AUTOMATICO - ROBO E TOTEM DO BANHO
echo ==========================================================
if exist "%LNK_ROBO%" (echo   Robo abre com o Windows .......... LIGADO) else (echo   Robo abre com o Windows .......... desligado)
if exist "%LNK_TOTEM%" (echo   Totem abre com o Windows ......... LIGADO) else (echo   Totem abre com o Windows ......... desligado)
echo ----------------------------------------------------------
echo   1 - Ligar: robo abre sozinho ao entrar no Windows
echo   2 - Desligar: robo nao abre sozinho
echo   3 - Ligar: totem abre sozinho em tela cheia
echo   4 - Desligar: totem nao abre sozinho
echo   5 - Abrir pagina do Autologon (entrar no Windows sem senha)
echo   0 - Sair
echo ----------------------------------------------------------
echo   BIOS: "Restore on AC Power Loss" = Power On (feito pela TI)
echo ==========================================================
choice /c 123450 /n /m "Escolha: "
if errorlevel 6 exit /b 0
if errorlevel 5 goto autologon
if errorlevel 4 goto totem_off
if errorlevel 3 goto totem_on
if errorlevel 2 goto robo_off
if errorlevel 1 goto robo_on

:robo_on
if not exist "%ROBO%\INICIAR.bat" (echo Nao achei %ROBO%\INICIAR.bat. Instale o robo antes. & pause & goto menu)
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK_ROBO%');$s.TargetPath='%ROBO%\INICIAR.bat';$s.WorkingDirectory='%ROBO%';$s.WindowStyle=7;$s.Save()"
call :energia
echo Pronto: o robo abre sozinho (minimizado) ao entrar no Windows.
pause & goto menu

:robo_off
del "%LNK_ROBO%" >nul 2>nul
echo Pronto: o robo nao abre mais sozinho. (Para abrir: %ROBO%\INICIAR.bat)
pause & goto menu

:totem_on
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined CHROME (echo Nao achei o Google Chrome neste computador. Instale e tente de novo. & pause & goto menu)
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK_TOTEM%');$s.TargetPath='%CHROME%';$s.Arguments='--kiosk --kiosk-printing --no-first-run --disable-session-crashed-bubble %URL_TOTEM%';$s.Save()"
call :energia
echo Pronto: o totem abre sozinho em tela cheia ao entrar no Windows.
echo Para sair da tela cheia: Alt+F4.
pause & goto menu

:totem_off
del "%LNK_TOTEM%" >nul 2>nul
echo Pronto: o totem nao abre mais sozinho.
pause & goto menu

:autologon
start "" "https://learn.microsoft.com/sysinternals/downloads/autologon"
echo Baixe o Autologon da Microsoft, rode e informe usuario e senha do Windows do totem.
echo Ele guarda a senha criptografada. Para desligar: rode de novo e clique em Disable.
pause & goto menu

:energia
rem na tomada: nunca suspender nem apagar a tela por inatividade
powercfg /change standby-timeout-ac 0 >nul 2>nul
powercfg /change monitor-timeout-ac 0 >nul 2>nul
powercfg /change hibernate-timeout-ac 0 >nul 2>nul
exit /b 0
