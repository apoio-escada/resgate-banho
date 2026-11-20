' Abre o robo do resgate em segundo plano (sem a janela preta)
Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = pasta
sh.Run "cmd /c """ & pasta & "\INICIAR.bat""", 0, False
