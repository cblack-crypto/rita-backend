Param()

cd C:\code\rita-backend
New-Item -ItemType Directory -Force -Path .\docs\proof2,.\docs\proof3,.\docs\proof4 | Out-Null

$port = ((Get-Content .env -Raw) -split "`r?`n" | ? {$_ -match '^PORT='} | % {$_ -replace '^PORT=',''})
if ([string]::IsNullOrWhiteSpace($port)) { $port = 3000 }
$base = "http://localhost:$port"
try { Invoke-RestMethod "$base/health" -TimeoutSec 3 | Out-Null } catch { Write-Host "Server not reachable at $base/health" -ForegroundColor Red; exit 1 }

$secret = ((Get-Content .env -Raw) -split "`r?`n" | ? { $_ -match '^DEVICE_HMAC_SECRET=' } | select -First 1) -replace '^DEVICE_HMAC_SECRET=',''
if ([string]::IsNullOrWhiteSpace($secret)) { Write-Host "DEVICE_HMAC_SECRET missing in .env" -ForegroundColor Red; exit 1 }
$keyBytes = [Text.Encoding]::UTF8.GetBytes($secret)
$hmac = [System.Security.Cryptography.HMACSHA256]::new($keyBytes)

function Invoke-PostRaw {
  param([string]$Url, [string]$Body, [hashtable]$Headers)
  $req=[System.Net.HttpWebRequest]::Create($Url); $req.Method="POST"; $req.ContentType="application/json"
  foreach($k in $Headers.Keys){ $req.Headers.Add($k,$Headers[$k]) }
  $bytes=[System.Text.Encoding]::UTF8.GetBytes($Body); $s=$req.GetRequestStream(); $s.Write($bytes,0,$bytes.Length); $s.Close()
  try{$resp=$req.GetResponse()}catch [System.Net.WebException]{ $resp=$_.Exception.Response }
  $status=[int]$resp.StatusCode; $r=New-Object IO.StreamReader($resp.GetResponseStream()); $content=$r.ReadToEnd(); $r.Close(); $resp.Close()
  [pscustomobject]@{ StatusCode=$status; Content=$content }
}

function Send-Signed {
  param([string]$siteId,[int]$samples,[double]$q,[double[]]$w)
  $body=@{ siteId=$siteId; modelName="demo-model"; weights=@{ layer0=$w }; dataSampleCount=$samples; dataQuality=$q;
           timestamp=[long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); nonce=[guid]::NewGuid().ToString() }
  $raw=(ConvertTo-Json $body -Compress)
  $sig=-join($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($raw))|%{$_.ToString('x2')})
  Invoke-PostRaw -Url "$base/api/v1/fl/weights" -Body $raw -Headers @{ "x-signature"=$sig; "x-dev-user"="dev-simulator" }
}

# ---- Proof #2: upload + replay ----
$now=[long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); $nonce=[guid]::NewGuid().ToString()
$body2=@{ siteId="siteA"; modelName="demo-model"; weights=@{ layer0=@(1.1,-0.5,0.2,0.9) }; dataSampleCount=123; dataQuality=0.95; timestamp=$now; nonce=$nonce }
$raw2=(ConvertTo-Json $body2 -Compress)
$sig2=-join($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($raw2))|%{$_.ToString('x2')})
$hdr=@{ "x-signature"=$sig2; "x-dev-user"="dev-simulator" }
$r1=Invoke-PostRaw "$base/api/v1/fl/weights" $raw2 $hdr
$r2=Invoke-PostRaw "$base/api/v1/fl/weights" $raw2 $hdr
$r1.StatusCode|Out-File -Encoding ascii .\docs\proof2\upload-status.txt
$r2.StatusCode|Out-File -Encoding ascii .\docs\proof2\replay-status.txt
$r1.Content|Out-File -Encoding utf8 .\docs\proof2\upload-response.json
$r2.Content|Out-File -Encoding utf8 .\docs\proof2\replay-response.json
Invoke-RestMethod "$base/health"|ConvertTo-Json -Depth 6|Out-File -Encoding utf8 .\docs\proof2\health.json
Invoke-RestMethod "$base/api/v1/metrics"|ConvertTo-Json -Depth 6|Out-File -Encoding utf8 .\docs\proof2\metrics.json

# ---- Proof #3: 3 updates + aggregate ----
$rA=Send-Signed -siteId "siteA" -samples 120 -q 0.96 -w @(1.00,-0.40,0.30,0.80)
$rB=Send-Signed -siteId "siteB" -samples 150 -q 0.94 -w @(1.20,-0.60,0.10,0.70)
$rC=Send-Signed -siteId "siteC" -samples 100 -q 0.95 -w @(0.90,-0.50,0.20,0.90)
$rA.StatusCode|Out-File -Encoding ascii .\docs\proof3\siteA-status.txt
$rB.StatusCode|Out-File -Encoding ascii .\docs\proof3\siteB-status.txt
$rC.StatusCode|Out-File -Encoding ascii .\docs\proof3\siteC-status.txt
$rA.Content|Out-File -Encoding utf8 .\docs\proof3\siteA-response.json
$rB.Content|Out-File -Encoding utf8 .\docs\proof3\siteB-response.json
$rC.Content|Out-File -Encoding utf8 .\docs\proof3\siteC-response.json
$agg=Invoke-PostRaw "$base/api/v1/fl/aggregate-now" '{"modelName":"demo-model"}' @{ "x-dev-user"="dev-simulator" }
$agg.StatusCode|Out-File -Encoding ascii .\docs\proof3\aggregate-status.txt
$agg.Content|Out-File -Encoding utf8 .\docs\proof3\aggregate-response.json
Invoke-RestMethod "$base/health"|ConvertTo-Json -Depth 6|Out-File -Encoding utf8 .\docs\proof3\health.json
Invoke-RestMethod "$base/api/v1/metrics"|ConvertTo-Json -Depth 6|Out-File -Encoding utf8 .\docs\proof3\metrics.json

# ---- Proof #4: model latest + summary ----
$latest=Invoke-RestMethod "$base/api/v1/fl/model/demo-model" -ErrorAction SilentlyContinue
$latest|ConvertTo-Json -Depth 8|Out-File -Encoding utf8 .\docs\proof4\model-latest.json
$ver=$null; try{ $ver=(Get-Content .\docs\proof3\aggregate-response.json -Raw|ConvertFrom-Json).version }catch{}
if($ver){ (Invoke-RestMethod "$base/api/v1/fl/model/demo-model?version=$ver")|ConvertTo-Json -Depth 8|Out-File -Encoding utf8 ".\docs\proof4\model-$ver.json" }
$hist=$latest.availableVersions
[pscustomobject]@{ timestamp=(Get-Date).ToString("s"); latestVersion=$latest.version; versions=$hist; participantCount=$latest.participantCount; createdAt=$latest.createdAt } |
  ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 .\docs\proof4\summary.json

# ---- zip ----
if(Test-Path .\docs\rita-proofs.zip){ Remove-Item .\docs\rita-proofs.zip -Force }
Compress-Archive -Path .\docs\proof* -DestinationPath .\docs\rita-proofs.zip
Write-Host "upload: $(Get-Content .\docs\proof2\upload-status.txt)  replay: $(Get-Content .\docs\proof2\replay-status.txt)  aggregate: $(Get-Content .\docs\proof3\aggregate-status.txt)"
Write-Host "Zip -> docs\rita-proofs.zip" -ForegroundColor Green
