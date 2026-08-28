Dim fso, shell, startup, installed, http, svc, autostartStatus, msg
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
startup = shell.SpecialFolders("Startup")
installed = fso.FileExists(startup & "\TrainingNotifyHub-Autorun.bat")

On Error Resume Next
Set http = CreateObject("MSXML2.XMLHTTP")
http.Open "GET", "http://localhost:8788/", False
http.Send
svc = http.Status
If Err.Number <> 0 Then svc = "未运行/无法连接"
On Error GoTo 0

If installed Then
  autostartStatus = "是"
Else
  autostartStatus = "否"
End If

msg = "培训通知助手 · 本地服务状态" & vbCrLf & vbCrLf
msg = msg & "服务 http://localhost:8788 ： " & svc & vbCrLf
msg = msg & "开机自动启动已配置： " & autostartStatus & vbCrLf & vbCrLf
msg = msg & "手动启动命令：" & vbCrLf & "  node training-notification-server.js"

MsgBox msg, vbInformation, "TrainingNotifyHub 状态"
