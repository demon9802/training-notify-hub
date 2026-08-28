@echo off
REM ============================================================
REM  TrainingNotifyHub 自动启动安装脚本
REM  用法：右键本文件 -> 以管理员身份运行（只需运行一次）
REM  效果：
REM   1) 登录/开机自动启动服务（覆盖「关机」「低电量关机」）
REM   2) 休眠/睡眠唤醒后自动自愈（Kernel-Power 事件 107）
REM   3) 每 5 分钟看门狗，进程崩溃也会自动拉起
REM  卸载请运行同目录 remove-autostart.bat
REM ============================================================
setlocal
set LAUNCHER=C:\Users\PC\WorkBuddy\2026-07-20-10-56-54\start-notify-hub.ps1
set ACTION=powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\Users\PC\WorkBuddy\2026-07-20-10-56-54\start-notify-hub.ps1

echo 正在创建计划任务（登录自启 + 休眠唤醒自愈 + 每5分钟看门狗）...
schtasks /Create /TN "TrainingNotifyHub-Logon" /TR "%ACTION%" /SC ONLOGON /F
schtasks /Create /TN "TrainingNotifyHub-Resume" /TR "%ACTION%" /SC ONEVENT /EC System /MO "*[System[Provider[@Name='Microsoft-Windows-Kernel-Power'] and (EventID=107)]]" /F
schtasks /Create /TN "TrainingNotifyHub-Watchdog" /TR "%ACTION%" /SC MINUTE /MO 5 /F

echo 正在写入启动文件夹快捷方式（登录自启备用）...
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
copy /Y "%~dp0TrainingNotifyHub-Startup.bat" "%STARTUP%\TrainingNotifyHub-Startup.bat" >nul 2>&1

echo 立即启动一次服务...
powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "%LAUNCHER%"

echo.
echo 完成。以后重启电脑或休眠唤醒，服务都会自动恢复。
echo 如需停用，请运行同目录下的 remove-autostart.bat。
pause
