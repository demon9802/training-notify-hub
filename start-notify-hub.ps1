param([switch]$Watchdog)

$port = 8788
$node = "C:\Users\PC\.workbuddy\binaries\node\versions\22.22.2\node.exe"
$scriptPath = "C:\Users\PC\WorkBuddy\2026-07-20-10-56-54\training-notification-server.js"
$workdir = "C:\Users\PC\WorkBuddy\2026-07-20-10-56-54"
$log = ($workdir + "\server-autostart.log")

function Log($m) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " " + $m
  try { Add-Content -Path $log -Value $line -Encoding UTF8 } catch { }
}

function Ensure-Service {
  $healthy = $false
  try {
    $r = Invoke-WebRequest -Uri ("http://localhost:" + $port + "/") -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
    if ($r.StatusCode -eq 200) { $healthy = $true }
  } catch { }
  if ($healthy) { return $true }

  try {
    $conns = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if ($conns) {
      $pids = $conns.OwningProcess | Sort-Object -Unique
      foreach ($p in $pids) {
        Log ("killing stale pid " + $p)
        try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch { }
      }
      Start-Sleep -Seconds 1
    }
  } catch { }

  Log "starting server"
  try {
    Start-Process -FilePath $node -ArgumentList $scriptPath -WindowStyle Hidden -WorkingDirectory $workdir
  } catch {
    Log ("start FAILED: " + $_.Exception.Message)
    return $false
  }
  Start-Sleep -Seconds 2
  try {
    $r2 = Invoke-WebRequest -Uri ("http://localhost:" + $port + "/") -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    Log ("server started, HTTP " + $r2.StatusCode)
    return $true
  } catch {
    Log "server verify FAILED"
    return $false
  }
}

if ($Watchdog) {
  Log "watchdog mode started"
  while ($true) {
    try { Ensure-Service | Out-Null } catch { Log "watchdog error" }
    Start-Sleep -Seconds 60
  }
} else {
  Ensure-Service | Out-Null
}
