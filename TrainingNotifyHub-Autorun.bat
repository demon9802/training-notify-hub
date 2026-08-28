@echo off
setlocal
set PORT=8788
set NODE=C:\Users\PC\.workbuddy\binaries\node\versions\22.22.2\node.exe
set SRV=C:\Users\PC\WorkBuddy\2026-07-20-10-56-54\training-notification-server.js
set LOG=C:\Users\PC\WorkBuddy\2026-07-20-10-56-54\autostart.log

REM 健康检查：端口已在监听则视为已启动，直接跳过（避免重复启动）
netstat -an 2>nul | findstr ":%PORT%" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo %DATE% %TIME% already running, skip >> "%LOG%"
  goto :done
)

REM 最小化窗口启动服务（不抢焦点）
start "" /min "%NODE%" "%SRV%"
echo %DATE% %TIME% started server >> "%LOG%"

:done
