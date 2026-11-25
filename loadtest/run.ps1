# Load test, step 2: run the API (+ the worker for the waiting room) as LINUX containers next to
# PostgreSQL and Redis, fire k6 at it from a third container, measure, stop. From the repo root,
# AFTER setup.mjs:
#
#   docker build -f server/Dockerfile -t ticketing-api:loadtest .      (once, or after code changes)
#   powershell -File loadtest/run.ps1 -Rate 1000
#
# Why containers: the first runs used k6 in Docker → Docker Desktop's port forwarding → the API on
# Windows. Thousands of NEW connections a second were refused on the way in (Windows / the port
# forwarder), before they ever reached Node. Inside one Docker network (Linux, like a real server)
# the load test measures OUR app, not the laptop's Windows networking.
param([int]$Rate = 1000, [int]$CheckRate = 500, [string]$BuyDuration = '60s')
# (Not 'Stop': k6 prints warnings on stderr, which Windows PowerShell would turn into a terminating error.)
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$run = Get-Content "$repo\loadtest\.data\run.json" | ConvertFrom-Json
$net = 'ticketbooking_default'
# server/.env (secrets such as JWT_ACCESS_SECRET: the tokens made by setup.mjs must verify), then the
# load-test overrides, then the addresses INSIDE the Docker network (-e wins over --env-file).
$common = @('--network', $net, '--env-file', "$repo\server\.env", '--env-file', "$repo\loadtest\loadtest.env",
  '-e', 'DATABASE_URL=postgres://ticketing:ticketing@ticketing-postgres:5432/ticketing',
  '-e', 'REDIS_URL=redis://ticketing-redis:6379')

docker rm -f lt-api lt-worker 2>$null | Out-Null
docker run -d --name lt-api @common ticketing-api:loadtest | Out-Null
if ($run.scenario -eq 'waiting-room') { docker run -d --name lt-worker @common ticketing-api:loadtest node src/worker.js | Out-Null }

try {
  # Wait until the API answers (from inside the network).
  for ($i = 0; $i -lt 40; $i++) {
    docker exec lt-api node -e "fetch('http://localhost:5059/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>$null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }

  # Sample the API container's CPU and memory once a second while k6 runs.
  $sampler = Start-Job -ScriptBlock {
    $out = @()
    while ($true) {
      $line = docker stats --no-stream --format '{{.CPUPerc}},{{.MemUsage}}' lt-api 2>$null
      if (-not $line) { break }
      $out += $line
      $out | Set-Content "$env:TEMP\lt-samples.csv"
    }
  }

  docker run --rm --network $net -v "${repo}/loadtest:/scripts" -e BASE_URL=http://lt-api:5059 -e RATE=$Rate -e CHECK_RATE=$CheckRate -e BUY_DURATION=$BuyDuration `
    grafana/k6:0.54.0 run --quiet /scripts/flash-sale.k6.js 2>$null | Select-Object -Last 30
  "k6 exit code: $LASTEXITCODE"
}
finally {
  if ($sampler) { Stop-Job $sampler; Remove-Job $sampler }
  $apiErrors = @(docker logs lt-api 2>&1 | Where-Object { "$_" -match 'Error' -and "$_" -notmatch '^\s+at ' })
  docker rm -f lt-api lt-worker 2>$null | Out-Null
}

$samples = Get-Content "$env:TEMP\lt-samples.csv" -ErrorAction SilentlyContinue | ForEach-Object {
  $cpu, $mem = $_ -split ','
  $used = ($mem -split '/')[0].Trim()
  $mb = if ($used -match 'GiB') { [double]($used -replace 'GiB', '') * 1024 } else { [double]($used -replace 'MiB', '') }
  [pscustomobject]@{ cpu = [double]($cpu -replace '%', ''); mb = $mb }
}
$peakMb = [Math]::Round(($samples | Measure-Object mb -Maximum).Maximum)
$peakCpu = [Math]::Round(($samples | Measure-Object cpu -Maximum).Maximum)
"API container: peak memory $peakMb MB, peak CPU $peakCpu % (100 % = one core), server errors logged: $($apiErrors.Count)"
$apiErrors | Select-Object -First 3
@{ peakMemoryMb = $peakMb; peakCpuPercent = $peakCpu; serverErrorsLogged = $apiErrors.Count } | ConvertTo-Json |
  Set-Content "$repo\loadtest\.data\server-$($run.scenario).json"
