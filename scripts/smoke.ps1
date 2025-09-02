# scripts/smoke.ps1
# Minimal, robust smoke for the RITA backend (PowerShell 5+)

$ErrorActionPreference = 'Stop'

function Get-DeviceSecret {
  # prefer env var; else read from .env
  if ($env:DEVICE_HMAC_SECRET -and $env:DEVICE_HMAC_SECRET.Trim().Length -gt 0) {
    return $env:DEVICE_HMAC_SECRET.Trim()
  }
  $envPath = Join-Path -Path (Get-Location) -ChildPath ".env"
  if (Test-Path $envPath) {
    $line = (Get-Content $envPath) | Where-Object { $_ -match "^DEVICE_HMAC_SECRET=" } | Select-Object -First 1
    if ($line) { return $line.Split('=')[1].Trim() }
  }
  throw "DEVICE_HMAC_SECRET not found in environment or .env"
}

function Get-NowUnix {
  $utc = (Get-Date).ToUniversalTime()
  return [int][Math]::Floor(($utc - [datetime]'1970-01-01Z').TotalSeconds)
}

function Compute-HmacSha256([string]$secret, [string]$raw) {
  $keyBytes = [Text.Encoding]::UTF8.GetBytes($secret)
  $mac = [System.Security.Cryptography.HMACSHA256]::new($keyBytes)
  $hash = $mac.ComputeHash([Text.Encoding]::UTF8.GetBytes($raw))
  -join ($hash | ForEach-Object { $_.ToString('x2') })
}

function Invoke-PostJson([string]$url, [string]$raw, [hashtable]$headers) {
  try {
    $r = Invoke-WebRequest -Uri $url -Method POST -ContentType 'application/json' -Body $raw -Headers $headers
    return [pscustomobject]@{ StatusCode = [int]$r.StatusCode; Content = [string]$r.Content }
  } catch {
    $resp = $_.Exception.Response
    if ($resp -ne $null) {
      $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $content = $reader.ReadToEnd()
      return [pscustomobject]@{ StatusCode = [int]$resp.StatusCode; Content = [string]$content }
    }
    throw
  }
}

# ---------- config ----------
$base = "http://localhost:3000"
$api  = "$base/api/v1"
$artifactDir = "docs\proof2"

# ---------- prepare ----------
New-Item -ItemType Directory -Force $artifactDir | Out-Null
$secret = Get-DeviceSecret
$body = @{ timestamp = Get-NowUnix } | ConvertTo-Json -Compress
$sig  = Compute-HmacSha256 -secret $secret -raw $body
$headers = @{ 'x-signature' = $sig; 'x-dev-user' = 'dev-simulator' }

# save request artifacts
$body      | Out-File -FilePath (Join-Path $artifactDir "request.json")       -Encoding utf8
$sig       | Out-File -FilePath (Join-Path $artifactDir "request.sig.txt")    -Encoding ascii

# ---------- 1) first POST (expect 200) ----------
$r1 = Invoke-PostJson -url "$api/fl/weights" -raw $body -headers $headers
"$($r1.StatusCode)" | Out-File -FilePath (Join-Path $artifactDir "upload-status.txt")  -Encoding ascii
$r1.Content        | Out-File -FilePath (Join-Path $artifactDir "upload-response.json") -Encoding utf8

# ---------- 2) replay same body (expect 409) ----------
$r2 = Invoke-PostJson -url "$api/fl/weights" -raw $body -headers $headers
"$($r2.StatusCode)" | Out-File -FilePath (Join-Path $artifactDir "replay-status.txt")  -Encoding ascii
$r2.Content        | Out-File -FilePath (Join-Path $artifactDir "replay-response.json") -Encoding utf8

# ---------- 3) health snapshot ----------
$health = Invoke-RestMethod "$base/health"
$health | ConvertTo-Json -Depth 6 | Out-File -FilePath (Join-Path $artifactDir "health.json") -Encoding utf8

# ---------- 4) zip results ----------
$zipPath = "docs\rita-proofs.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $artifactDir "*") -DestinationPath $zipPath -Force

# ---------- summary ----------
Write-Host ""
Write-Host "=== Smoke Summary ===" -ForegroundColor Cyan
Write-Host ("upload: {0}   replay: {1}" -f $r1.StatusCode, $r2.StatusCode)
Write-Host ("zip  -> {0}" -f $zipPath)
