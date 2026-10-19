' Starts JARVIS with no console window. Installed next to node\ and app\.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
sh.Run """" & dir & "\node\node.exe"" """ & dir & "\app\launcher\jarvis.mjs""", 0, False
