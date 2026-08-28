$log = "C:\Users\PC\WorkBuddy\2026-07-20-10-56-54\server-autostart.log"
function Log($m) {
  try { Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " " + $m) -Encoding UTF8 } catch { }
}

$filter1 = "name='powershell.exe' AND CommandLine LIKE '%start-notify-hub%'"
Get-CimInstance Win32_Process -Filter $filter1 | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
  Log ("stopped watchdog pid " + $_.ProcessId)
}

$filter2 = "name='node.exe' AND CommandLine LIKE '%training-notification-server%'"
Get-CimInstance Win32_Process -Filter $filter2 | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
  Log ("stopped server pid " + $_.ProcessId)
}

Write-Host "[OK] stopped watchdog and local service"
