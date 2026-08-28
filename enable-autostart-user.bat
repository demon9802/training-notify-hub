@echo off
setlocal
set ROOT=C:\Users\PC\WorkBuddy\2026-07-20-10-56-54
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set LOG=%ROOT%\autostart.log

echo ============================================
echo  TrainingNotifyHub 自动启动配置（纯批处理）
echo ============================================
echo.
echo  目标启动文件夹: %STARTUP%
echo.

copy /Y "%ROOT%\TrainingNotifyHub-Autorun.bat" "%STARTUP%\TrainingNotifyHub-Autorun.bat" >nul
if exist "%STARTUP%\TrainingNotifyHub-Autorun.bat" (echo   [OK] 开机自启脚本已复制) else (echo   [失败] 无法写入启动文件夹)

copy /Y "%ROOT%\TrainingNotifyHub-Watchdog.vbs" "%STARTUP%\TrainingNotifyHub-Watchdog.vbs" >nul
if exist "%STARTUP%\TrainingNotifyHub-Watchdog.vbs" (echo   [OK] 看门狗(崩溃自愈)已复制) else (echo   [失败] 无法写入看门狗)

echo.
echo  立即验证服务状态...
ping -n 3 127.0.0.1 >nul
powershell.exe -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:8788/' -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop; Write-Host ('  [OK] 服务正常，HTTP ' + $r.StatusCode) } catch { Write-Host '  [提示] 服务未响应，但自启已配置' }" 2>nul

echo.
echo  完成！之后关机 / 休眠 / 低电量关机都会自动恢复。
echo  日志：%ROOT%\autostart.log
echo  查看状态：双击 check-status.vbs
echo ============================================
pause
