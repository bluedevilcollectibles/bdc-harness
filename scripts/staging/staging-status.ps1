# staging-status.ps1 -- health + run status for the laptop Cauldron STAGING instance.
# WO-HARNESS-CAULDRON-LAPTOP-STAGING-01.
#
# Shows: container state, /api/health, deployed commit, running runs, last 5 runs
# from the STAGING event store (staging-data/archon.db, read in-container via
# bun:sqlite so no host sqlite3 dependency).
#
# Usage: powershell -File scripts/staging/staging-status.ps1

[CmdletBinding()]
param()

$ErrorActionPreference = "Continue"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
. (Join-Path $PSScriptRoot "_docker-bun.ps1")

$cmd = Get-Command docker -ErrorAction SilentlyContinue
if ($cmd) { $Docker = $cmd.Source }
elseif (Test-Path "C:\Program Files\Docker\Docker\resources\bin\docker.exe") { $Docker = "C:\Program Files\Docker\Docker\resources\bin\docker.exe" }
else { Write-Error "docker CLI not found"; exit 1 }

# container state
$state = (& $Docker inspect -f "{{.State.Status}} (health: {{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}})" archon-staging 2>$null)
if (-not $state) { $state = "not created" }
Write-Host "[staging-status] container archon-staging: $state"

# deployed commit
$dcFile = Join-Path $RepoRoot "staging-data\DEPLOYED_COMMIT"
if (Test-Path $dcFile) { Write-Host "[staging-status] deployed commit: $((Get-Content $dcFile -Raw).Trim())" }

# health
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:3091/api/health" -UseBasicParsing -TimeoutSec 5
  Write-Host "[staging-status] /api/health: $($r.StatusCode) $($r.Content)"
} catch {
  Write-Host "[staging-status] /api/health: UNREACHABLE ($($_.Exception.Message))"
}

# event store: running + last 5 runs (in-container bun:sqlite; ASCII-only JS)
if ($state -like "running*") {
  $js = 'const {Database}=require("bun:sqlite");const db=new Database("/.archon/archon.db",{readonly:true});try{const rows=db.query("SELECT id,workflow_name,status,started_at FROM remote_agent_workflow_runs ORDER BY started_at DESC LIMIT 5").all();console.log(JSON.stringify(rows,null,1));}catch(e){console.log("event store not initialized yet: "+e.message);}'
  Write-Host "[staging-status] last 5 runs (staging event store):"
  Invoke-BunScriptInContainer -Docker $Docker -ContainerName "archon-staging" -Script $js
} else {
  Write-Host "[staging-status] container not running -- event store persisted at staging-data/archon.db"
}
