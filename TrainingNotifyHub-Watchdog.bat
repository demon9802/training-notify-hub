@echo off
set PORT=8788
set NODE=C:\Users\PC\.workbuddy\binaries\node\versions\22.22.2\node.exe
set SRV=C:\Users\PC\WorkBuddy\2026-07-20-10-56-54\training-notification-server.js

:loop
REM 每 60 秒检查一次，服务挂了就自动拉起（崩溃自愈）
netstat -an 2>nul | findstr ":%PORT%" | findstr "LISTENING" >nul
if errorlevel 1 (
  start "" /min "%NODE%" "%SRV%"
)
ping -n 61 127.0.0.1 >nul
goto :loop
