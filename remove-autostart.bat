@echo off
REM TrainingNotifyHub 卸载自动启动（右键 -> 以管理员身份运行）
echo 正在移除计划任务与启动文件夹项...
schtasks /Delete /TN "TrainingNotifyHub-Logon" /F 2>nul
schtasks /Delete /TN "TrainingNotifyHub-Resume" /F 2>nul
schtasks /Delete /TN "TrainingNotifyHub-Watchdog" /F 2>nul
del /Q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\TrainingNotifyHub-Startup.bat" 2>nul
echo 已卸载自动启动。
pause
