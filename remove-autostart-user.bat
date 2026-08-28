@echo off
setlocal
REM 卸载用户级自动启动（无需管理员）
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set SHORTCUT=%STARTUP%\TrainingNotifyHub.bat

echo 移除用户启动项...
if exist "%SHORTCUT%" (
  del /F "%SHORTCUT%" && echo   [OK] 已删除启动器
) else (
  echo   [跳过] 启动器不存在
)

echo 停止看门狗与本地服务...
powershell.exe -ExecutionPolicy Bypass -File "C:\Users\PC\WorkBuddy\2026-07-20-10-56-54\stop-notify-hub.ps1"

echo 完成。
pause
