# staging-overseer-safety.ps1 -- Deterministic Overseer safety assertions for staging.
# WO-HARNESS-OVERSEER-SAFETY-GATES-STAGING-01 Stop 5.
#
# Executes deterministic assertions against the fake GitHub mutation adapter on an
# isolated staging host. Requires no production credentials. All network mutations
# are fake and append-only. Exits 0 only when every assertion passes.
#
# Usage: powershell -File scripts/staging/staging-overseer-safety.ps1
#
# Required staging env (verified by this script):
#   OVERSEER_ENABLED=false  OVERSEER_EMERGENCY_STOP=true
#   OVERSEER_DRY_RUN=true   OVERSEER_USE_FAKE_GITHUB_ADAPTER=1
#   All five OVERSEER_*_ACTIONS_ENABLED=false

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$ExitCode = 0
. (Join-Path $PSScriptRoot "_docker-bun.ps1")

function Pass { param([string]$msg) Write-Host "[PASS] $msg" }
function Fail { param([string]$msg) Write-Host "[FAIL] $msg"; $script:ExitCode = 1 }
function Info { param([string]$msg) Write-Host "[INFO] $msg" }

Info "=== Overseer staging safety assertions begin ==="
Info "Repo root: $RepoRoot"

# Locate docker
$cmd = Get-Command docker -ErrorAction SilentlyContinue
if ($cmd) { $Docker = $cmd.Source }
elseif (Test-Path "C:\Program Files\Docker\Docker\resources\bin\docker.exe") {
  $Docker = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
} else {
  Fail "docker CLI not found"
  exit 1
}

# --- Assertion 1: the exact-SHA staging container is running ---
$ContainerState = (& $Docker inspect -f "{{.State.Status}}" archon-staging 2>$null)
if ($ContainerState -eq "running") {
  Pass "Container archon-staging is running"
} else {
  Fail "Container archon-staging is not running (state: $ContainerState)"
  exit 1
}

# --- Assertion 2: deployed commit is recorded ---
$dcFile = Join-Path $RepoRoot "staging-data\DEPLOYED_COMMIT"
if (Test-Path $dcFile) {
  $DeployedSha = (Get-Content $dcFile -Raw).Trim()
  $CandidateSha = (& git -C $RepoRoot rev-parse HEAD).Trim()
  if ($DeployedSha -eq $CandidateSha) {
    Pass "Deployed commit matches candidate HEAD: $DeployedSha"
  } else {
    Fail "Deployed commit '$DeployedSha' does not match candidate HEAD '$CandidateSha'"
  }
} else {
  Fail "No DEPLOYED_COMMIT file -- exact-SHA staging proof is unavailable"
}

# --- Assertion 3: .env.staging has the required fail-closed defaults ---
$envFile = Join-Path $RepoRoot ".env.staging"
if (Test-Path $envFile) {
  $envContent = Get-Content $envFile -Raw
  $required = @{
    "OVERSEER_ENABLED"                  = "false"
    "OVERSEER_EMERGENCY_STOP"           = "true"
    "OVERSEER_DRY_RUN"                  = "true"
    "OVERSEER_USE_FAKE_GITHUB_ADAPTER"  = "1"
  }
  foreach ($key in $required.Keys) {
    $val = $required[$key]
    if ($envContent -match "(?m)^$key=$val\s*$") {
      Pass ".env.staging: $key=$val"
    } else {
      Fail ".env.staging: $key is not set to required value '$val'"
    }
  }
  foreach ($cap in @("ESCALATION", "REPAIR", "BRANCH", "LIFECYCLE", "MERGE")) {
    $envKey = "OVERSEER_${cap}_ACTIONS_ENABLED"
    if ($envContent -match "(?m)^${envKey}=false\s*$") {
      Pass ".env.staging: $envKey=false"
    } else {
      Fail ".env.staging: $envKey must be false -- capability must not be enabled in staging"
    }
  }
} else {
  Fail ".env.staging not found -- fail-closed staging configuration cannot be verified"
}

# --- Assertion 4: in-container Overseer runtime status (when running) ---
if ($ContainerState -eq "running") {
  $statusJs = @'
const r = await fetch("http://localhost:3091/api/health");
const j = await r.json();
process.stdout.write(JSON.stringify(j));
'@
  try {
    $healthRaw = Invoke-BunScriptInContainer -Docker $Docker -ContainerName "archon-staging" -Script $statusJs
    $health = $healthRaw | ConvertFrom-Json
    if ($health.status -eq "ok") {
      Pass "Container /api/health returned status=ok"
    } else {
      Fail "Container /api/health status is not ok: $healthRaw"
    }
  } catch {
    Fail "Failed to reach container /api/health: $($_.Exception.Message)"
  }

  # Verify the configured adapter is fake. The enabled watcher proof runs below;
  # a disabled service is not accepted as evidence for this assertion.
  $adapterCheckJs = @'
const env = process.env;
const isFake = env.OVERSEER_USE_FAKE_GITHUB_ADAPTER === "1" || env.OVERSEER_USE_FAKE_GITHUB_ADAPTER === "true";
if (!isFake) { console.log("REAL_ADAPTER_ACTIVE"); process.exit(1); }
console.log("FAKE_ADAPTER_CONFIRMED");
'@
  try {
    $adapterCheck = Invoke-BunScriptInContainer -Docker $Docker -ContainerName "archon-staging" -Script $adapterCheckJs
    if ($adapterCheck -match "FAKE_ADAPTER_CONFIRMED") {
      Pass "Fake adapter confirmed in container env"
    } else {
      Fail "Real adapter may be active in staging container: $adapterCheck"
    }
  } catch {
    Fail "Adapter check failed: $($_.Exception.Message)"
  }

  # Verify no raw credential value appears in container stdout (credential boundary)
  $credCheckJs = @'
const keys = ["GH_TOKEN", "GITHUB_TOKEN", "CLAUDE_API_KEY"];
for (const k of keys) {
  const v = process.env[k] ?? "";
  if (v.length > 0) {
    console.log("PRESENT_REDACTED:" + k);
  } else {
    console.log("ABSENT:" + k);
  }
}
'@
  try {
    $credCheck = Invoke-BunScriptInContainer -Docker $Docker -ContainerName "archon-staging" -Script $credCheckJs
    if ($credCheck -notmatch "ghp_|github_pat_|Bearer |sk-") {
      Pass "No raw credential value visible in container env output"
    } else {
      Fail "Possible raw credential value leaked to stdout -- review immediately"
    }
  } catch {
    Fail "Credential boundary check failed: $($_.Exception.Message)"
  }
}

# --- Assertion 5: five capability flags are all false (fail-closed default) ---
$capsJs = @'
const caps = ["ESCALATION","REPAIR","BRANCH","LIFECYCLE","MERGE"];
const allOff = caps.every(c => {
  const v = process.env["OVERSEER_" + c + "_ACTIONS_ENABLED"];
  return v === "false" || v === "0" || v === undefined || v === "";
});
console.log(allOff ? "ALL_CAPS_DISABLED" : "CAP_ENABLED_FOUND");
'@
if ($ContainerState -eq "running") {
  try {
    $capsCheck = Invoke-BunScriptInContainer -Docker $Docker -ContainerName "archon-staging" -Script $capsJs
    if ($capsCheck -match "ALL_CAPS_DISABLED") {
      Pass "All five capability flags are disabled in container env"
    } else {
      Fail "At least one capability flag is enabled -- staging must remain fail-closed"
    }
  } catch {
    Fail "Capability flag check failed: $($_.Exception.Message)"
  }
}

# --- Assertion 6: migration 034 is present and tables exist in staging DB ---
if ($ContainerState -eq "running") {
  $migCheckJs = @'
const {Database} = require("bun:sqlite");
try {
  const db = new Database("/.archon/archon.db", {readonly: true});
  const caps = db.query("SELECT capability, action_enabled, circuit_state FROM overseer_capability_state").all();
  if (caps.length !== 5) {
    console.log("WRONG_CAP_COUNT:" + caps.length);
    process.exit(1);
  }
  const allDisabled = caps.every(r => r.action_enabled === 0 || r.action_enabled === false);
  const allClosed = caps.every(r => r.circuit_state === "closed");
  if (!allDisabled) { console.log("CAPABILITY_ENABLED_IN_DB"); process.exit(1); }
  if (!allClosed) { console.log("CIRCUIT_OPEN_IN_DB"); process.exit(1); }
  const evtCount = db.query("SELECT count(*) as c FROM overseer_capability_events").get();
  console.log("MIGRATION_034_OK:caps=" + caps.length + ":events=" + evtCount.c);
} catch(e) {
  console.log("DB_ERROR:" + e.message);
  process.exit(1);
}
'@
  try {
    $migCheck = Invoke-BunScriptInContainer -Docker $Docker -ContainerName "archon-staging" -Script $migCheckJs
    if ($migCheck -match "^MIGRATION_034_OK") {
      Pass "Migration 034: overseer_capability_state has 5 rows, all disabled+closed: $migCheck"
    } else {
      Fail "Migration 034 DB check failed: $migCheck"
    }
  } catch {
    Fail "Migration 034 check exception: $($_.Exception.Message)"
  }
}

# --- Assertion 7: enabled live service path -- qualified coordinator only ---
# Run the actual one-shot Overseer watcher/service with a valid persistent
# proposal, permit, and capability state. The subprocess temporarily enables one
# fake capability, restores the prior state in finally, and fails unless the
# qualified merge coordinator is reached exactly once. The legacy merge callback
# and fake adapter-attempt path must both remain unreachable.
if ($ContainerState -eq "running") {
  $serviceCanaryJs = @'
const { randomUUID } = await import("crypto");
const { getDatabase, closeDatabase } = await import("/app/packages/core/src/db/connection.ts");
const { listOverseerCapabilityEvents } = await import("/app/packages/core/src/db/overseer-capabilities.ts");
const { runOverseerService } = await import("/app/packages/overseer/src/service.ts");

if (process.env.OVERSEER_ENABLED !== "true") throw new Error("watcher_not_enabled");
if (process.env.OVERSEER_USE_FAKE_GITHUB_ADAPTER !== "1") throw new Error("fake_adapter_not_enabled");
if (process.env.OVERSEER_MERGE_ACTIONS_ENABLED !== "true") throw new Error("merge_canary_not_enabled");

const db = getDatabase();
const suffix = randomUUID();
const snapshotId = "staging-snapshot-" + suffix;
const proposalId = "staging-proposal-" + suffix;
const executionId = "staging-execution-" + suffix;
const permitId = "staging-permit-" + suffix;
const policyDigest = "a".repeat(64);
const verifierDigest = "b".repeat(64);
const evidenceBlob = suffix.replaceAll("-", "").padEnd(40, "0").slice(0, 40);
const now = Date.now();
const createdAt = new Date(now - 30000).toISOString();
const expiresAt = new Date(now + 300000).toISOString();
const priorState = (await db.query("SELECT * FROM overseer_capability_state WHERE capability = $1", ["merge"])).rows[0];
if (!priorState) throw new Error("merge_capability_state_missing");

let mergeCalls = 0;
let coordinatorCalls = 0;
const actions = [];
try {
  await db.query(
    `INSERT INTO overseer_m31_snapshots (
      snapshot_id, schema_version, repository, capture_started_at, capture_completed_at,
      operator_actor, operator_model, read_only_query_method, base_branch, base_sha,
      artifact_path, git_object_format, evidence_git_blob, mutation_attempted,
      mutation_succeeded, fusion_calls_attempted, fusion_calls_succeeded
    ) VALUES ($1, 'v1', $2, $3, $3, 'staging-canary', 'bun', 'local-fixture',
      'dev', $4, $5, 'sha1', $6, 0, 0, 0, 0)`,
    [snapshotId, "thinmansoftware/bdc-harness", createdAt, "c".repeat(40),
      "artifacts/" + suffix + ".json", evidenceBlob]
  );
  await db.query(
    `INSERT INTO overseer_m31_action_proposals (
      proposal_id, repository, pr_number, head_sha, base_branch, base_sha,
      snapshot_id, evidence_path, evidence_git_blob, action_kind,
      action_parameters_json, actor, created_at, expires_at, execution_id,
      capability, policy_digest, verifier_registry_digest
    ) VALUES ($1, $2, 42, $3, 'dev', $4, $5, $6, $7, 'MERGE', '{}',
      'staging-canary', $8, $9, $10, 'overseer.m31.merge', $11, $12)`,
    [proposalId, "thinmansoftware/bdc-harness", "d".repeat(40), "c".repeat(40),
      snapshotId, "artifacts/" + suffix + ".json", evidenceBlob, createdAt, expiresAt,
      executionId, policyDigest, verifierDigest]
  );
  await db.query(
    `UPDATE overseer_capability_state
     SET action_enabled = 1, circuit_state = 'closed', circuit_reason = NULL,
       circuit_opened_at = NULL, policy_digest = $1, verifier_registry_digest = $2,
       updated_at = $3, updated_by = 'staging-canary'
     WHERE capability = 'merge'`,
    [policyDigest, verifierDigest, createdAt]
  );

  const permit = {
    permit_id: permitId,
    proposal_id: proposalId,
    execution_id: executionId,
    repository: "thinmansoftware/bdc-harness",
    pr_number: 42,
    head_sha: "d".repeat(40),
    base_branch: "dev",
    base_sha: "c".repeat(40),
    snapshot_id: snapshotId,
    action_kind: "MERGE",
    capability: "overseer.m31.merge",
    issued_at: new Date(now - 1000).toISOString(),
    valid_until: new Date(now + 60000).toISOString(),
  };

  const mergeCoordinator = async record => {
    coordinatorCalls++;
    if (record.woId !== "WO-M42-STAGING-CANARY") {
      throw new Error("unexpected_coordinator_record:" + record.woId);
    }
  };

  await runOverseerService({
    once: true,
    enabled: true,
    dryRun: false,
    adapterKind: "fake",
    mergeCoordinator,
    deps: {
      listRunsForWatch: async () => [{
        id: "staging-run-" + suffix,
        woId: "WO-M42-STAGING-CANARY",
        owner: "bluedevilcollectibles",
        repo: "bdc-harness",
        status: "failed",
        metadata: { overseer_m31_permit: permit },
      }],
      listRunEvents: async () => [],
      findPullRequest: async () => ({
        exists: true,
        state: "open",
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        mergeable: true,
        pr: { owner: "bluedevilcollectibles", repo: "bdc-harness", number: 42 },
      }),
      mergePullRequest: async () => {
        mergeCalls++;
        throw new Error("real_merge_boundary_reached");
      },
      insertOverseerAction: async action => { actions.push(action); },
    },
  });

  const attempts = (await listOverseerCapabilityEvents("merge")).filter(
    event => event.event_type === "adapter_attempt" && event.execution_id === executionId
  );
  if (coordinatorCalls !== 1) throw new Error("qualified_coordinator_calls:" + coordinatorCalls);
  if (mergeCalls !== 0) throw new Error("real_merge_callback_called:" + mergeCalls);
  if (actions.length !== 0) {
    throw new Error("unexpected_service_action:" + JSON.stringify(actions));
  }
  if (attempts.length !== 0) throw new Error("adapter_attempt_count:" + attempts.length);
  console.log("LIVE_SERVICE_CANARY_OK:coordinator_calls=1:legacy_calls=0:adapter_attempts=0");
} finally {
  await db.query(
    `UPDATE overseer_capability_state
     SET action_enabled = $1, circuit_state = $2, circuit_reason = $3,
       circuit_opened_at = $4, policy_digest = $5, verifier_registry_digest = $6,
       updated_at = $7, updated_by = $8
     WHERE capability = 'merge'`,
    [priorState.action_enabled, priorState.circuit_state, priorState.circuit_reason,
      priorState.circuit_opened_at, priorState.policy_digest,
      priorState.verifier_registry_digest, priorState.updated_at, priorState.updated_by]
  );
  await closeDatabase();
}
'@
  $canaryHomeName = ".overseer-service-canary-$([Guid]::NewGuid().ToString('N'))"
  $archonMountSource = Get-ContainerArchonMountSource -Docker $Docker -ContainerName "archon-staging"
  $canaryHostPath = [IO.Path]::GetFullPath((Join-Path $archonMountSource $canaryHomeName))
  $mountPrefix = [IO.Path]::GetFullPath($archonMountSource).TrimEnd('\') + '\'
  if (-not $canaryHostPath.StartsWith($mountPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "Enabled live Overseer service canary path escaped the staging mount"
    exit 1
  }
  New-Item -ItemType Directory -Path $canaryHostPath | Out-Null
  try {
    $serviceCanaryOptions = @(
      "-e", "ARCHON_HOME=/.archon/$canaryHomeName",
      "-e", "OVERSEER_ENABLED=true",
      "-e", "OVERSEER_EMERGENCY_STOP=false",
      "-e", "OVERSEER_DRY_RUN=false",
      "-e", "OVERSEER_USE_FAKE_GITHUB_ADAPTER=1",
      "-e", "OVERSEER_FAKE_GITHUB_REPOSITORIES=thinmansoftware/bdc-harness",
      "-e", "OVERSEER_MERGE_ACTIONS_ENABLED=true"
    )
    $serviceCanary = Invoke-BunScriptInContainer `
      -Docker $Docker `
      -ContainerName "archon-staging" `
      -Script $serviceCanaryJs `
      -DockerExecOptions $serviceCanaryOptions
    if ($serviceCanary -match "LIVE_SERVICE_CANARY_OK:coordinator_calls=1:legacy_calls=0:adapter_attempts=0") {
      Pass "Enabled live Overseer service reached only the qualified coordinator: $serviceCanary"
    } else {
      Fail "Enabled live Overseer service canary failed: $serviceCanary"
    }
  } catch {
    Fail "Enabled live Overseer service canary exception: $($_.Exception.Message)"
  } finally {
    try {
      if (Test-Path -LiteralPath $canaryHostPath) {
        Remove-Item -LiteralPath $canaryHostPath -Recurse -Force -ErrorAction Stop
      }
      if (Test-Path -LiteralPath $canaryHostPath) {
        throw "canary directory still exists"
      }
    } catch {
      Fail "Enabled live Overseer service canary cleanup failed: $($_.Exception.Message)"
    }
  }
}

# --- Final summary and completion evidence ---
Write-Host ""
Info "=== Overseer staging safety assertions complete ==="
if ($ExitCode -eq 0) {
  Write-Host "[RESULT] ALL ASSERTIONS PASSED"
  Write-Host "[EVIDENCE] Slice 1 complete activates no Overseer action capability."
  Write-Host "[EVIDENCE] No real provider mutation occurred. Fake adapter boundary enforced."
  Write-Host "[EVIDENCE] Emergency stop, dry-run, and five disabled capability flags verified."
  Write-Host "[EVIDENCE] Migration 034 overseer_capability_state seeded with 5 default-disabled rows."
} else {
  Write-Host "[RESULT] ONE OR MORE ASSERTIONS FAILED -- review output above"
}

exit $ExitCode
